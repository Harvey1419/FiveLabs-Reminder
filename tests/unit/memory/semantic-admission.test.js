import { describe, expect, it, vi } from 'vitest';
import { validateMemoryCandidates } from '../../../src/features/memory/validate-candidates.js';
const candidates = [{ content: 'First', evidence: 'First' }, { content: 'Second', evidence: 'Second' }];
describe('semantic memory admission boundary', () => {
  it('persists only admitted observed candidates and carries mixed operational context', async () => {
    const complete = vi.fn().mockResolvedValue({ content: '{"positions":[2]}' });
    const result = await validateMemoryCandidates({ userText: 'First; Second', candidates, executionFacts: [{ tool: 'manage_project', success: true }], complete });
    expect(result).toEqual([candidates[1]]);
    const [messages, options] = complete.mock.calls[0];
    expect(JSON.parse(messages[1].content).executionFacts[0].tool).toBe('manage_project');
    expect(options.tools).toBeNull();
    expect(options.validateStructuredContent('{"positions":[9]}').valid).toBe(false);
  });
  it.each(['{"positions":[3]}', '{"positions":[1,1]}', '{"positions":["1"]}', 'broken', '{"positions":[1],"extra":true}'])('rejects malformed or ungrounded selections: %s', async content => {
    expect(await validateMemoryCandidates({ userText: 'First', candidates, complete: vi.fn().mockResolvedValue({ content }) })).toEqual([]);
  });
  it.each([
    ['quoted negation', 'La frase "usar Meet" está citada, no es mi preferencia.', 'No le gusta usar Meet.', 'usar Meet'],
    ['direct preference', 'Prefiero llamadas por teléfono en vez de video.', 'Prefiere llamadas por teléfono en vez de video.', 'Prefiero llamadas por teléfono en vez de video.'],
  ])('packages %s with source and candidate for semantic attribution', async (_case, userText, content, evidence) => {
    const candidate = { topicKey: 'preference/communication', category: 'preference', content, evidence };
    const complete = vi.fn().mockResolvedValue({ content: '{"positions":[]}' });
    await validateMemoryCandidates({ userText, candidates: [candidate], complete });
    const [messages] = complete.mock.calls[0];
    const payload = JSON.parse(messages[1].content);
    expect(payload.userText).toBe(userText);
    expect(payload.candidates).toEqual([{ ...candidate, position: 1 }]);
    expect(messages[0].content).toMatch(/quoted or mentioned words.*not.*preference/i);
    expect(messages[0].content).toMatch(/explicitly asserts.*preference/i);
    expect(messages[0].content).toMatch(/negat.*attribution/i);
  });
  it('keeps a quoted disclaimer out when the semantic reviewer rejects it, but does not override a bad approval', async () => {
    const userText = 'La frase "usar Meet" está citada, no es mi preferencia.';
    const candidate = { category: 'preference', content: 'No le gusta usar Meet.', evidence: 'usar Meet' };
    const complete = vi.fn().mockResolvedValueOnce({ content: '{"positions":[]}' }).mockResolvedValueOnce({ content: '{"positions":[1]}' });
    expect(await validateMemoryCandidates({ userText, candidates: [candidate], complete })).toEqual([]);
    expect(await validateMemoryCandidates({ userText, candidates: [candidate], complete })).toEqual([candidate]);
  });
  it('retains a directly asserted preference when the semantic reviewer approves it', async () => {
    const candidate = { category: 'preference', content: 'Prefiere llamadas telefónicas.', evidence: 'Prefiero llamadas telefónicas.' };
    expect(await validateMemoryCandidates({ userText: candidate.evidence, candidates: [candidate], complete: vi.fn().mockResolvedValue({ content: '{"positions":[1]}' }) })).toEqual([candidate]);
  });
  it('states the language inference exclusions while retaining the entire source turn', async () => {
    const userText = 'Mi colega dijo "responde en inglés"; no es mi instrucción. No cambies mi idioma.';
    const complete = vi.fn().mockResolvedValue({ content: '{"positions":[]}' });
    await validateMemoryCandidates({ userText, candidates, complete });
    const [messages] = complete.mock.calls[0];
    expect(JSON.parse(messages[1].content).userText).toBe(userText);
    expect(messages[0].content).toContain('current utterance language');
    expect(messages[0].content).toContain('refusal to change');
    expect(messages[0].content).toContain('unnamed alternative');
  });
  it('fails closed without a valid model answer', async () => {
    expect(await validateMemoryCandidates({ userText: 'First', candidates, complete: vi.fn().mockRejectedValue(new Error('unavailable')) })).toEqual([]);
  });
});
