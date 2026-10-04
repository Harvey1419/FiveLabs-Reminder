import { beforeEach, expect, it, vi } from 'vitest';
vi.mock('../../../src/infrastructure/database/index.js', () => ({ saveMemory: vi.fn(), searchMemories: vi.fn(), findOrCreateEntityFuzzy: vi.fn() }));
vi.mock('../../../src/agent/providers/client.js', () => ({ callMemoryExtraction: vi.fn(), callChatCompletion: vi.fn() }));
const { saveMemory, searchMemories } = await import('../../../src/infrastructure/database/index.js');
const { callMemoryExtraction, callChatCompletion } = await import('../../../src/agent/providers/client.js');
const { extractAndSaveMemories } = await import('../../../src/features/memory/service.js');
const candidate = { topicKey: 'preference/communication_method', category: 'preference', content: 'Prefiere mensajes de texto.', evidence: 'Ahora prefiero mensajes de texto' };
beforeEach(() => { vi.resetAllMocks(); searchMemories.mockResolvedValue([]); callChatCompletion.mockResolvedValue({ content: '{"positions":[1]}' }); });
it('recovers capitalization before admission and supersedes the existing topic through persistence', async () => {
  const active = new Map([[candidate.topicKey, 'Prefiere llamadas.']]);
  searchMemories.mockResolvedValue([{ topic_key: candidate.topicKey, category: 'preference', content: active.get(candidate.topicKey) }]);
  saveMemory.mockImplementation(async ({ topicKey, content }) => { active.set(topicKey, content); return { topic_key: topicKey, content }; });
  callMemoryExtraction.mockResolvedValue(JSON.stringify([candidate]));
  const userText = 'Antes prefería llamadas, pero ahora prefiero mensajes de texto. Actualiza mi preferencia.';
  expect(await extractAndSaveMemories({ userId: 'offline', userText })).toHaveLength(1);
  const payload = JSON.parse(callChatCompletion.mock.calls[0][0][1].content);
  expect(payload.userText).toBe(userText);
  expect(payload.candidates[0].evidence).toBe('ahora prefiero mensajes de texto');
  expect(active.get(candidate.topicKey)).toBe(candidate.content);
});
it.each([
  ['ahora prefiero mensajes de voz', candidate.evidence],
  ['ahora prefiero mensajes de texto; AHORA PREFIERO MENSAJES DE TEXTO', candidate.evidence],
  ['prefiero teléfono', 'Prefiero telefono'],
  ['prefiero  texto', 'Prefiero texto'],
  ['İ prefiero texto', 'i prefiero texto'],
])('does not admit nonliteral or ambiguous evidence: %s', async (userText, evidence) => {
  callMemoryExtraction.mockResolvedValue(JSON.stringify([{ ...candidate, evidence }]));
  expect(await extractAndSaveMemories({ userId: 'offline', userText })).toEqual([]);
  expect(saveMemory).not.toHaveBeenCalled();
  expect(callChatCompletion).not.toHaveBeenCalled();
});
it('leaves exact evidence unchanged and semantic rejection authoritative', async () => {
  callMemoryExtraction.mockResolvedValue(JSON.stringify([candidate]));
  callChatCompletion.mockResolvedValue({ content: '{"positions":[]}' });
  expect(await extractAndSaveMemories({ userId: 'offline', userText: candidate.evidence })).toEqual([]);
  expect(JSON.parse(callChatCompletion.mock.calls[0][0][1].content).candidates[0].evidence).toBe(candidate.evidence);
  expect(saveMemory).not.toHaveBeenCalled();
});
