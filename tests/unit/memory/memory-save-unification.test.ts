import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/infrastructure/database/index.js', () => ({
  saveMemory: vi.fn(), searchMemories: vi.fn(), getActiveMemories: vi.fn(),
  getStandingMemories: vi.fn(), forgetMemories: vi.fn(), findOrCreateEntityFuzzy: vi.fn(),
}));
vi.mock('../../../src/agent/providers/client.js', () => ({ callMemoryExtraction: vi.fn(), callChatCompletion: vi.fn() }));
vi.mock('../../../src/agent/orchestration/select-memory-forgetting.js', () => ({ selectMemoriesToForget: vi.fn() }));
vi.mock('../../../src/agent/tools/index.js', () => ({ executeTool: vi.fn() }));
vi.mock('../../../src/agent/core/working-memory-store.js', () => ({ getWorkingMemory: vi.fn(() => ({})), sanitizeResponseText: (text: string) => text }));
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
async function turn(userMessage: string, actions: NonNullable<Parameters<typeof executeTurnIntent>[0]>['actions'] = [save], metadata: Omit<NonNullable<Parameters<typeof executeTurnIntent>[0]>, 'actions'> = {}) {
  return executeTurnIntent({ actions, ...metadata }, { user, userMessage, language: 'es', executeTool: async options => options.toolName === 'manage_memory'
    ? executeMemoryTool({ ...options, action: options.params.action as string } as Parameters<typeof executeMemoryTool>[0])
    : { success: true, action: 'created_task', data: { items: [{ id: 'offline-task', title: 'Llamar mañana' }] }, rawSummary: 'Tarea creada.' } });
}

describe('memory save unification and paraphrase grounding', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(searchMemories, { partial: true }).mockResolvedValue([]);
    vi.mocked(callMemoryExtraction, { partial: true }).mockResolvedValue(JSON.stringify([preference]));
    vi.mocked(callChatCompletion, { partial: true }).mockResolvedValue({ content: '{"positions":[1]}' });
    vi.mocked(saveMemory, { partial: true }).mockImplementation(async value => ({ id: 'saved', ...value }));
  });

  it('admits paraphrased memory.save with literal evidence extracted from user text', async () => {
    const userText = 'ahora prefiero mensajes de texto';
    const action = {
      domain: 'memory',
      action: 'save',
      category: 'preference',
      topicKey: 'preference/communication',
      content: 'Prefiero los mensajes de texto',
    };
    const execution = await turn(userText, [action], { learningCandidates: [], learningCandidatesProvided: true });
    expect(callMemoryExtraction).not.toHaveBeenCalled();
    expect(callChatCompletion).toHaveBeenCalledTimes(1);
    const admissionInput = JSON.parse((vi.mocked(callChatCompletion).mock.calls[0]![0][1] as { content: string }).content);
    expect(admissionInput.userText).toBe(userText);
    expect(admissionInput.candidates[0]!.content).toBe('Prefiero los mensajes de texto');
    expect(userText).toContain(admissionInput.candidates[0]!.evidence);
    expect(admissionInput.candidates[0]!.evidence).toBe('prefiero mensajes de texto');
    expect(saveMemory).toHaveBeenCalledExactlyOnceWith({
      userId: user.id,
      topicKey: 'preference/communication',
      category: 'preference',
      content: 'Prefiero los mensajes de texto',
    });
    expect(execution.records[0]!.result.success).toBe(true);
  });

  it('admits paraphrased memory.save with explicitly provided literal evidence', async () => {
    const userText = 'ahora prefiero mensajes de texto para coordinar';
    const action = {
      domain: 'memory',
      action: 'save',
      category: 'preference',
      topicKey: 'preference/communication',
      content: 'Prefiero los mensajes de texto',
      evidence: 'prefiero mensajes de texto',
    };
    const execution = await turn(userText, [action], { learningCandidates: [], learningCandidatesProvided: true });
    expect(callMemoryExtraction).not.toHaveBeenCalled();
    expect(callChatCompletion).toHaveBeenCalledTimes(1);
    const admissionInput = JSON.parse((vi.mocked(callChatCompletion).mock.calls[0]![0][1] as { content: string }).content);
    expect(admissionInput.candidates[0]!.evidence).toBe('prefiero mensajes de texto');
    expect(saveMemory).toHaveBeenCalledExactlyOnceWith({
      userId: user.id,
      topicKey: 'preference/communication',
      category: 'preference',
      content: 'Prefiero los mensajes de texto',
    });
    expect(execution.records[0]!.result.success).toBe(true);
  });

  it('rejects memory.save when neither phrase nor provided evidence grounds in user text', async () => {
    const userText = 'ahora prefiero mensajes de texto';
    const action = {
      domain: 'memory',
      action: 'save',
      category: 'preference',
      topicKey: 'preference/food',
      content: 'Prefiero comer pizza los domingos',
    };
    const execution = await turn(userText, [action], { learningCandidates: [], learningCandidatesProvided: true });
    expect(execution.records[0]!.result.errorCode).toBe('MEMORY_NOT_ADMITTED');
    expect(callChatCompletion).not.toHaveBeenCalled();
    expect(saveMemory).not.toHaveBeenCalled();
  });

  it('writes normalized preference once across explicit and automatic boundaries', async () => {
    const userText = 'recuerda esta preferencia: Prefiero llamadas telefónicas.';
    const execution = await turn(userText);
    await extractAndSaveMemories({ userId: user.id, userText, executionFacts: execution.facts, memoryDisposition: execution.memoryProcessed ? 'processed' : 'extract' });
    expect(saveMemory).toHaveBeenCalledExactlyOnceWith({ userId: user.id, topicKey: preference.topicKey, category: 'preference', content: preference.content });
    expect(callMemoryExtraction).toHaveBeenCalledTimes(1);
    expect(callChatCompletion).toHaveBeenCalledTimes(1);
    expect(execution.records[0]!.result.rawSummary).not.toContain('recuerda esta preferencia');
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
    vi.mocked(callChatCompletion, { partial: true }).mockResolvedValue({ content: '{"positions":[]}' });
    const execution = await turn(userText);
    expect(saveMemory).not.toHaveBeenCalled();
    expect(execution.records[0]!.result).toMatchObject({ success: false, action: 'memory_not_admitted' });
    expect(JSON.parse((vi.mocked(callChatCompletion).mock.calls[0]![0][1] as { content: string }).content).userText).toBe(userText);
  });

  it.each([
    ['missing category', { topicKey: 'communication/phone_calls' }],
    ['missing topic', { category: 'preference' }],
    ['invalid category', { category: 'observation', topicKey: 'communication/phone_calls' }],
    ['invalid topic', { category: 'preference', topicKey: '!!!' }],
    ['oversized content', { category: 'preference', topicKey: 'communication/phone_calls', content: 'x'.repeat(181) }],
  ])('does not invent evidence or extraction for %s', async (_label, fields) => {
    const execution = await turn('Prefiero las llamadas por teléfono.', [{ domain: 'memory', action: 'save', content: 'Prefiero las llamadas por teléfono.', ...fields }], { learningCandidates: [], learningCandidatesProvided: true });
    expect(execution.records[0]!.result.errorCode).toBe('MEMORY_NOT_ADMITTED');
    expect(callMemoryExtraction).not.toHaveBeenCalled();
    expect(callChatCompletion).not.toHaveBeenCalled();
    expect(saveMemory).not.toHaveBeenCalled();
  });
});
