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
  it('fails closed without a valid model answer', async () => {
    expect(await validateMemoryCandidates({ userText: 'First', candidates, complete: vi.fn().mockRejectedValue(new Error('unavailable')) })).toEqual([]);
  });
});
