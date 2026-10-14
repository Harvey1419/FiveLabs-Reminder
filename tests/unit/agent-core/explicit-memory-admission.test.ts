import { afterEach, describe, expect, it, vi } from 'vitest';
import { estimateBoundedInput } from '@templelabs/ai';
import { admitExplicitMemory } from '../../../src/adapters/agent-core/memory-admission.js';
import { context } from './productivity-fixtures.js';
const text = 'Recuerda que vivo en Bogotá';
const request = { operation: 'save' as const, input: { content: 'vivo en Bogotá', category: 'fact' as const, evidenceStart: 13, evidenceEnd: text.length } };
afterEach(() => vi.unstubAllGlobals());
describe('bounded model-agnostic semantic admission for explicit memories', () => {
  it.each([true, false])('returns semantic admission=%s from a strict positions result without tools or storage authority', async admitted => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: JSON.stringify({ positions: admitted ? [1] : [] }) }, finish_reason: 'stop' }], usage: { prompt_tokens: 1000, completion_tokens: 5 } })));
    vi.stubGlobal('fetch', fetch);
    expect(await admitExplicitMemory(text, request, context)).toBe(admitted);
    expect(fetch).toHaveBeenCalledOnce();
    const body = JSON.parse(String(fetch.mock.calls[0]?.[1]?.body));
    expect(body.response_format.type).toBe('json_schema'); expect(body.max_tokens).toBe(1024); expect(body.tools).toBeUndefined();
    expect(body.messages[0].content).toContain('negates its attribution');
    expect(body.messages[1].content).toContain(text);
    expect(estimateBoundedInput(body)).toBeLessThanOrEqual(1800);
  });
  it('refuses malformed selection positions instead of treating them as permission', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: '{"positions":[99]}' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1000, completion_tokens: 5 } })));
    vi.stubGlobal('fetch', fetch);
    await expect(admitExplicitMemory(text, request, context)).rejects.toThrow();
  });
});
