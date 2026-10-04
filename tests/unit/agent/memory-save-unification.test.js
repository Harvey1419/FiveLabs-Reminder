import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/infrastructure/database/index.js', () => ({
  saveMemory: vi.fn(), searchMemories: vi.fn(), getActiveMemories: vi.fn(),
  getStandingMemories: vi.fn(), forgetMemories: vi.fn(), findOrCreateEntityFuzzy: vi.fn(),
}));
vi.mock('../../../src/agent/providers/client.js', () => ({ callMemoryExtraction: vi.fn(), callChatCompletion: vi.fn() }));
vi.mock('../../../src/agent/orchestration/select-memory-forgetting.js', () => ({ selectMemoriesToForget: vi.fn() }));
vi.mock('../../../src/agent/tools/index.js', () => ({ executeTool: vi.fn() }));
vi.mock('../../../src/agent/core/working-memory-store.js', () => ({ getWorkingMemory: vi.fn(() => ({})), sanitizeResponseText: text => text }));
vi.mock('../../../src/agent/core/working-memory-execution.js', () => ({ updateWorkingMemoryFromExecution: vi.fn(), updateWorkingMemoryFromFacts: vi.fn() }));
vi.mock('../../../src/agent/core/agent-run.js', () => ({ cancelSupersededInputRun: vi.fn(), createApprovalRun: vi.fn(), createInputRun: vi.fn() }));
vi.mock('../../../src/agent/orchestration/resolve-observed-target.js', () => ({ resolveObservedTarget: vi.fn() }));

import { saveMemory, searchMemories } from '../../../src/infrastructure/database/index.js';
import { callMemoryExtraction, callChatCompletion } from '../../../src/agent/providers/client.js';
import { executeMemoryTool } from '../../../src/agent/tools/memory.js';
import { executeTurnIntent } from '../../../src/agent/orchestration/intent-executor.js';
import { extractAndSaveMemories } from '../../../src/features/memory/service.js';

const user = { id: 'offline-memory-user', timezone: 'UTC' };
const preference = { topicKey: 'preference/communication', category: 'preference', content: 'Prefiere llamadas telefónicas.', evidence: 'Prefiero llamadas telefónicas.' };
const save = { domain: 'memory', action: 'save', content: 'recuerda esta preferencia: Prefiero llamadas telefónicas.' };
async function turn(userMessage, actions = [save]) {
  return executeTurnIntent({ actions }, { user, userMessage, language: 'es', executeTool: options => options.toolName === 'manage_memory'
    ? executeMemoryTool({ ...options, action: options.params.action })
    : { success: true, action: 'created_task', data: { items: [{ id: 'offline-task', title: 'Llamar mañana' }] }, rawSummary: 'Tarea creada.' } });
}

describe('one source-attributed memory writing path', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    searchMemories.mockResolvedValue([]);
    callMemoryExtraction.mockResolvedValue(JSON.stringify([preference]));
    callChatCompletion.mockResolvedValue({ content: '{"positions":[1]}' });
    saveMemory.mockImplementation(async value => ({ id: 'saved', ...value }));
  });
  it('writes normalized preference once across explicit and automatic boundaries', async () => {
    const userText = 'recuerda esta preferencia: Prefiero llamadas telefónicas.';
    const execution = await turn(userText);
    await extractAndSaveMemories({ userId: user.id, userText, executionFacts: execution.facts, memoryDisposition: execution.memoryProcessed ? 'processed' : 'extract' });
    expect(saveMemory).toHaveBeenCalledExactlyOnceWith({ userId: user.id, topicKey: preference.topicKey, category: 'preference', content: preference.content });
    expect(callMemoryExtraction).toHaveBeenCalledTimes(1);
    expect(callChatCompletion).toHaveBeenCalledTimes(1);
    expect(execution.records[0].result.rawSummary).not.toContain('recuerda esta preferencia');
  });
  it('reuses extraction for repeated explicit saves but not a subsequent turn', async () => {
    await turn(preference.evidence, [save, save]);
    expect(saveMemory).toHaveBeenCalledTimes(1);
    expect(callMemoryExtraction).toHaveBeenCalledTimes(1);
    await turn(preference.evidence);
    expect(callMemoryExtraction).toHaveBeenCalledTimes(2);
  });
  it('rejects quoted attribution when admission excludes it', async () => {
    const userText = 'La frase "Prefiero llamadas telefónicas." está citada, no es mi preferencia.';
    callChatCompletion.mockResolvedValue({ content: '{"positions":[]}' });
    const execution = await turn(userText);
    expect(saveMemory).not.toHaveBeenCalled();
    expect(execution.records[0].result).toMatchObject({ success: false, action: 'memory_not_admitted' });
    expect(JSON.parse(callChatCompletion.mock.calls[0][0][1].content).userText).toBe(userText);
  });
  it('does not acknowledge empty extraction as saved', async () => {
    callMemoryExtraction.mockResolvedValue('[]');
    const execution = await turn('Recuerda esto.');
    expect(execution.records[0].result).toMatchObject({ success: false, action: 'memory_not_admitted' });
    expect(saveMemory).not.toHaveBeenCalled();
  });
  it.each(['extraction', 'admission', 'storage'])('reports %s failure truthfully without automatic retry', async failure => {
    if (failure === 'extraction') callMemoryExtraction.mockRejectedValue(new Error('offline failure'));
    if (failure === 'admission') callChatCompletion.mockRejectedValue(new Error('offline failure'));
    if (failure === 'storage') saveMemory.mockResolvedValue(null);
    const execution = await turn(preference.evidence);
    expect(execution.records[0].result).toMatchObject({ success: false, action: 'memory_save_failed' });
    await extractAndSaveMemories({ userId: user.id, userText: preference.evidence, memoryDisposition: execution.memoryProcessed ? 'processed' : 'extract' });
    expect(callMemoryExtraction).toHaveBeenCalledTimes(1);
  });
  it('preserves independent facts from the full mixed turn rather than just save parameters', async () => {
    const fact = { topicKey: 'profile/residence', category: 'fact', content: 'Vive en Cali.', evidence: 'Vivo en Cali.' };
    callMemoryExtraction.mockResolvedValue(JSON.stringify([preference, fact]));
    callChatCompletion.mockResolvedValue({ content: '{"positions":[1,2]}' });
    const execution = await turn('Crea una tarea para llamar mañana. Prefiero llamadas telefónicas. Vivo en Cali.', [
      { domain: 'task', action: 'create', content: 'Llamar mañana', projectless: true }, save,
    ]);
    expect(execution.records[0].result.success).toBe(true);
    expect(JSON.parse(callChatCompletion.mock.calls[0][0][1].content).executionFacts[0].tool).toBe('manage_task');
    expect(saveMemory).toHaveBeenCalledTimes(2);
    expect(execution.records[1].result.data.memories).toHaveLength(2);
    expect(callMemoryExtraction.mock.calls[0][0][1].content).toContain('Vivo en Cali.');
  });
  it('fails closed without original user source even if params contain a fact', async () => {
    const result = await executeMemoryTool({ action: 'save', params: { content: preference.evidence }, user });
    expect(result.success).toBe(false);
    expect(saveMemory).not.toHaveBeenCalled();
    expect(callMemoryExtraction).not.toHaveBeenCalled();
  });
});
