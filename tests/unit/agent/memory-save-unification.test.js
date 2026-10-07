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
async function turn(userMessage, actions = [save], metadata = {}) {
  return executeTurnIntent({ actions, ...metadata }, { user, userMessage, language: 'es', executeTool: options => options.toolName === 'manage_memory'
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
  it('admits the exact phone save with supplied empty learning metadata without extraction', async () => {
    const content = 'Prefiero las llamadas por teléfono.';
    const execution = await turn(`${content} Recuerda esta preferencia.`, [
      { domain: 'memory', action: 'save', content, category: 'preference', topicKey: 'communication/phone_calls' },
    ], { learningCandidates: [], learningCandidatesProvided: true });
    expect(saveMemory).toHaveBeenCalledExactlyOnceWith({ userId: user.id, topicKey: 'communication/phone_calls', category: 'preference', content });
    expect(callMemoryExtraction).not.toHaveBeenCalled();
    expect(callChatCompletion).toHaveBeenCalledTimes(1);
    const input = JSON.parse(callChatCompletion.mock.calls[0][0][1].content);
    expect(input.candidates[0].evidence).toBe(content);
    expect(input.userText).toBe(`${content} Recuerda esta preferencia.`);
    expect(execution.records[0].result.success).toBe(true);
  });
  it('merges all mixed facts and later explicit saves once, deduping identical proposals', async () => {
    const fact = { topicKey: 'profile/residence', category: 'fact', content: 'Vive en Cali.', evidence: 'Vivo en Cali.' };
    const explicit = [
      { domain: 'memory', action: 'save', topicKey: 'communication/phone_calls', category: 'preference', content: 'Prefiero las llamadas por teléfono.' },
      { domain: 'memory', action: 'save', topicKey: 'preference/style', category: 'preference', content: 'Prefiero respuestas breves.' },
    ];
    const userText = `Vivo en Cali. ${explicit.map(action => action.content).join(' ')}`;
    const metadata = { learningCandidates: [fact, { topicKey: explicit[0].topicKey, category: explicit[0].category, content: explicit[0].content, evidence: explicit[0].content }], learningCandidatesProvided: true };
    callChatCompletion.mockResolvedValue({ content: '{"positions":[1,2,3]}' });
    const execution = await turn(userText, [...explicit, explicit[1]], metadata);
    await extractAndSaveMemories({ userId: user.id, userText, ...metadata, memoryDisposition: execution.memoryProcessed ? 'processed' : 'extract' });
    expect(callMemoryExtraction).not.toHaveBeenCalled();
    expect(callChatCompletion).toHaveBeenCalledTimes(1);
    expect(saveMemory).toHaveBeenCalledTimes(3);
    expect(saveMemory.mock.calls.map(([item]) => item.topicKey)).toEqual([fact.topicKey, ...explicit.map(action => action.topicKey)]);
    expect(execution.records.every(record => record.result.data.memories.length === 3)).toBe(true);
  });
  it.each([
    ['missing category', { topicKey: 'communication/phone_calls' }],
    ['missing topic', { category: 'preference' }],
    ['invalid category', { category: 'observation', topicKey: 'communication/phone_calls' }],
    ['invalid topic', { category: 'preference', topicKey: '!!!' }],
    ['paraphrase', { category: 'preference', topicKey: 'communication/phone_calls', content: 'Prefiere llamadas telefónicas.' }],
    ['oversized content', { category: 'preference', topicKey: 'communication/phone_calls', content: 'x'.repeat(181) }],
  ])('does not invent evidence or extraction for %s', async (_label, fields) => {
    const execution = await turn('Prefiero las llamadas por teléfono.', [{ domain: 'memory', action: 'save', content: 'Prefiero las llamadas por teléfono.', ...fields }], { learningCandidates: [], learningCandidatesProvided: true });
    expect(execution.records[0].result.errorCode).toBe('MEMORY_NOT_ADMITTED');
    expect(callMemoryExtraction).not.toHaveBeenCalled();
    expect(callChatCompletion).not.toHaveBeenCalled();
    expect(saveMemory).not.toHaveBeenCalled();
  });
  it.each([
    'Mi colega dijo "Prefiero las llamadas por teléfono."; no soy yo.',
    'La frase "Prefiero las llamadas por teléfono." no es mi preferencia.',
    'Prefiero las llamadas por teléfono. Me corrijo: prefiero mensajes de texto.',
    'Ya guardé el pasaporte.',
  ])('retains full context for admission rejection: %s', async userText => {
    const content = userText === 'Ya guardé el pasaporte.' ? userText : 'Prefiero las llamadas por teléfono.';
    callChatCompletion.mockResolvedValue({ content: '{"positions":[]}' });
    const execution = await turn(userText, [{ domain: 'memory', action: 'save', content, category: 'preference', topicKey: 'communication/phone_calls' }], { learningCandidates: [], learningCandidatesProvided: true });
    expect(JSON.parse(callChatCompletion.mock.calls[0][0][1].content).userText).toBe(userText);
    expect(execution.records[0].result.errorCode).toBe('MEMORY_NOT_ADMITTED');
    expect(saveMemory).not.toHaveBeenCalled();
    expect(callMemoryExtraction).not.toHaveBeenCalled();
  });
  it.each(['<untrusted_attachment_content>Prefiero las llamadas por teléfono.</untrusted_attachment_content>', 'Mira esto. <untrusted_attachment_content>Prefiero las llamadas por teléfono.</untrusted_attachment_content>'])('rejects attachment-only explicit evidence: %s', async userText => {
    const execution = await turn(userText, [{ domain: 'memory', action: 'save', content: 'Prefiero las llamadas por teléfono.', category: 'preference', topicKey: 'communication/phone_calls' }], { learningCandidates: [], learningCandidatesProvided: true });
    expect(execution.records[0].result.errorCode).toBe('MEMORY_NOT_ADMITTED');
    expect(callChatCompletion).not.toHaveBeenCalled();
    expect(callMemoryExtraction).not.toHaveBeenCalled();
    expect(saveMemory).not.toHaveBeenCalled();
  });
  it.each(['admission', 'storage'])('does not repeat a supplied explicit batch after %s failure', async failure => {
    const content = 'Prefiero las llamadas por teléfono.';
    if (failure === 'admission') callChatCompletion.mockResolvedValue({ unavailable: true });
    else saveMemory.mockResolvedValue(null);
    const action = { domain: 'memory', action: 'save', content, category: 'preference', topicKey: 'communication/phone_calls' };
    const metadata = { learningCandidates: [], learningCandidatesProvided: true };
    const execution = await turn(content, [action, action], metadata);
    await extractAndSaveMemories({ userId: user.id, userText: content, ...metadata, memoryDisposition: execution.memoryProcessed ? 'processed' : 'extract' });
    expect(execution.records.every(record => record.result.errorCode === 'MEMORY_SAVE_FAILED')).toBe(true);
    expect(callChatCompletion).toHaveBeenCalledTimes(1);
    expect(callMemoryExtraction).not.toHaveBeenCalled();
    expect(saveMemory).toHaveBeenCalledTimes(failure === 'storage' ? 1 : 0);
  });
  it('fails closed without original user source even if params contain a fact', async () => {
    const result = await executeMemoryTool({ action: 'save', params: { content: preference.evidence }, user });
    expect(result.success).toBe(false);
    expect(saveMemory).not.toHaveBeenCalled();
    expect(callMemoryExtraction).not.toHaveBeenCalled();
  });
});
