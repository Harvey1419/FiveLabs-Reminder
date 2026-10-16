import { describe, expect, it, vi } from 'vitest';
import { createBudgetedTransport, type Rate } from '../../../scripts/evals/live-evaluation-budget.js';

const url = 'https://openrouter.ai/api/v1/chat/completions';
const rates: Record<string, Rate> = { primary: { prompt: 0.000001, completion: 0.000002 }, fallback: { prompt: 0.000002, completion: 0.000003 } };
const body = (model = 'primary', max_tokens = 10) => JSON.stringify({ model, max_tokens, messages: [{ role: 'user', content: 'hi' }] });
const request = (model = 'primary') => ({ method: 'POST', body: body(model) });
const response = (usage: unknown = { cost: 0.001, prompt_tokens: 5, completion_tokens: 2 }, status = 200) => new Response(JSON.stringify({ id: 'generation-1', model: 'primary', usage }), { status });
function setup(reply: () => Promise<Response> = async () => response(), maxUsd = 0.25, maxCalls = 60) {
  const network = vi.fn<typeof fetch>(reply);
  const transport = createBudgetedTransport({ fetch: network, rates, maxCalls, maxUsd });
  return { network, ...transport };
}
async function rejectedWithoutDispatch(transport: ReturnType<typeof setup>, input: RequestInfo | URL, init?: RequestInit) {
  const before = transport.report();
  await expect(transport.fetch(input, init)).rejects.toThrow();
  expect(transport.network).not.toHaveBeenCalled();
  expect(transport.report()).toMatchObject({ calls: before.calls, chargedUsd: before.chargedUsd, reservedUsd: before.reservedUsd, attempts: before.attempts });
}

describe('isolated evaluator transport budget', () => {
  it('reserves before dispatch, settles exact cost, preserves provider response and hides secrets', async () => {
    const transport = setup();
    const result = await transport.fetch(url, { ...request(), headers: { authorization: 'Bearer secret' } });
    expect(await result.json()).toMatchObject({ id: 'generation-1' });
    expect(transport.network).toHaveBeenCalledWith(url, expect.objectContaining({ redirect: 'error' }));
    expect(transport.report()).toMatchObject({ calls: 1, chargedUsd: 0.001, reservedUsd: 0, blockedReason: null });
    expect(JSON.stringify(transport.report())).not.toMatch(/secret|authorization|messages|Bearer/);
  });
  it('counts primary and fallback equally and blocks before the next dispatch', async () => {
    const transport = setup(undefined, 0.25, 2);
    await transport.fetch(url, request());
    await transport.fetch(url, request('fallback'));
    const before = transport.report();
    await expect(transport.fetch(url, request())).rejects.toThrow();
    expect(transport.network).toHaveBeenCalledTimes(2);
    expect(transport.report()).toMatchObject({ calls: 2, chargedUsd: before.chargedUsd, reservedUsd: 0, attempts: before.attempts });
  });
  it('enforces the absolute 60-call ceiling even when configured higher', async () => {
    const transport = setup(async () => response({ cost: 0 }), 1, 100);
    for (let i = 0; i < 60; i++) await transport.fetch(url, request());
    const before = transport.report();
    await expect(transport.fetch(url, request())).rejects.toThrow();
    expect(transport.network).toHaveBeenCalledTimes(60);
    expect(transport.report()).toMatchObject({ calls: 60, chargedUsd: 0, reservedUsd: 0, attempts: before.attempts });
  });
  it.each([
    ['wrong origin', 'https://example.com/api/v1/chat/completions', request()],
    ['wrong path', `${url}/`, request()],
    ['GET', url, { ...request(), method: 'GET' }],
    ['invalid JSON', url, { method: 'POST', body: '{' }],
    ['missing model', url, { method: 'POST', body: '{"max_tokens":1}' }],
    ['missing output cap', url, { method: 'POST', body: '{"model":"primary"}' }],
    ['zero cap', url, { method: 'POST', body: body('primary', 0) }],
    ['fractional cap', url, { method: 'POST', body: body('primary', 1.5) }],
    ['unknown model', url, request('unpriced')],
  ])('rejects %s without I/O or accounting mutation', async (_label, input, init) => {
    await rejectedWithoutDispatch(setup(), input, init);
  });
  it.each([undefined, { prompt: -1, completion: 1 }, { prompt: Number.NaN, completion: 1 }, { prompt: 1, completion: Number.POSITIVE_INFINITY }])('rejects absent/invalid pricing before dispatch (%j)', async (rate) => {
    const transport = setup();
    const guarded = createBudgetedTransport({ fetch: transport.network, rates: rate ? { primary: rate } : {}, maxCalls: 60, maxUsd: 0.25 });
    await rejectedWithoutDispatch({ ...guarded, network: transport.network }, url, request());
  });
  it('uses UTF8 bytes plus 256 and max_tokens for the exact reservation boundary', async () => {
    const payload = JSON.stringify({ model: 'primary', max_tokens: 10, text: '🧪' });
    const reservation = (new TextEncoder().encode(payload).length + 256) * rates.primary!.prompt + 10 * rates.primary!.completion;
    const below = setup(undefined, reservation - 1e-10);
    await rejectedWithoutDispatch(below, url, { method: 'POST', body: payload });
    const exact = setup(undefined, reservation);
    await exact.fetch(url, { method: 'POST', body: payload });
    expect(exact.report().calls).toBe(1);
  });
  it('enforces the absolute USD ceiling even when configured higher', async () => {
    const transport = setup();
    const guarded = createBudgetedTransport({ fetch: transport.network, rates: { primary: { prompt: 0.001, completion: 0.001 } }, maxCalls: 60, maxUsd: 100 });
    await rejectedWithoutDispatch({ ...guarded, network: transport.network }, url, request());
  });
  it('atomically prevents concurrent over-reservation and keeps the first reservation', async () => {
    let resolve: (value: Response) => void = () => { throw new Error('not started'); };
    const transport = setup(() => new Promise<Response>((done) => { resolve = done; }), 0.0006);
    const first = transport.fetch(url, request());
    await vi.waitFor(() => expect(transport.network).toHaveBeenCalledTimes(1));
    const before = transport.report();
    expect(before.reservedUsd).toBeGreaterThan(0);
    await expect(transport.fetch(url, request())).rejects.toThrow();
    expect(transport.network).toHaveBeenCalledTimes(1);
    expect(transport.report()).toMatchObject({ calls: 1, chargedUsd: 0, reservedUsd: before.reservedUsd, attempts: before.attempts });
    resolve(response({ cost: 0.0001 }));
    await first;
    expect(transport.report()).toMatchObject({ calls: 1, chargedUsd: 0.0001, reservedUsd: 0 });
  });
  it('atomically enforces the call ceiling while a response is pending', async () => {
    let resolve: (value: Response) => void = () => { throw new Error('not started'); };
    const transport = setup(() => new Promise<Response>((done) => { resolve = done; }), 0.25, 1);
    const first = transport.fetch(url, request());
    await vi.waitFor(() => expect(transport.network).toHaveBeenCalledTimes(1));
    const before = transport.report();
    await expect(transport.fetch(url, request('fallback'))).rejects.toThrow();
    expect(transport.network).toHaveBeenCalledTimes(1);
    expect(transport.report()).toMatchObject({ calls: 1, chargedUsd: 0, reservedUsd: before.reservedUsd, attempts: before.attempts });
    resolve(response());
    await first;
    expect(transport.report()).toMatchObject({ calls: 1, chargedUsd: 0.001, reservedUsd: 0 });
  });
  it('computes cost only from valid full usage including cached and reasoning token totals', async () => {
    const transport = setup(async () => response({ prompt_tokens: 20, completion_tokens: 10, prompt_tokens_details: { cached_tokens: 12 }, completion_tokens_details: { reasoning_tokens: 7 } }));
    await transport.fetch(url, request());
    expect(transport.report()).toMatchObject({ chargedUsd: 20 * rates.primary!.prompt + 10 * rates.primary!.completion, reservedUsd: 0, blockedReason: null });
  });
  it.each([
    ['missing usage', () => response(null)],
    ['invalid explicit cost', () => response({ cost: -1, prompt_tokens: 1, completion_tokens: 1 })],
    ['null explicit cost', () => response({ cost: null, prompt_tokens: 1, completion_tokens: 1 })],
    ['string explicit cost', () => response({ cost: '0', prompt_tokens: 1, completion_tokens: 1 })],
    ['invalid usage', () => response({ prompt_tokens: 1 })],
    ['input beyond bound', () => response({ prompt_tokens: 100000, completion_tokens: 1 })],
    ['reasoning not included', () => response({ prompt_tokens: 1, completion_tokens: 1, completion_tokens_details: { reasoning_tokens: 2 } })],
    ['cached input not included', () => response({ prompt_tokens: 1, completion_tokens: 1, prompt_tokens_details: { cached_tokens: 2 } })],
    ['output beyond cap', () => response({ prompt_tokens: 1, completion_tokens: 11 })],
    ['fractional token totals', () => response({ prompt_tokens: 1.5, completion_tokens: 1 })],
    ['unexpected billed model without cost', () => new Response(JSON.stringify({ model: 'fallback', usage: { prompt_tokens: 1, completion_tokens: 1 } }))],
    ['HTTP error', () => response({ cost: 0 }, 429)],
    ['envelope error', () => new Response(JSON.stringify({ error: { message: 'private' }, usage: { cost: 0 } }))],
    ['invalid JSON', () => new Response('not json')],
  ])('locks uncertain accounting for %s but preserves the response', async (_label, reply) => {
    const transport = setup(async () => reply());
    const result = await transport.fetch(url, request());
    expect(result).toBeInstanceOf(Response);
    expect(await result.text()).not.toBe('');
    const before = transport.report();
    expect(before).toMatchObject({ calls: 1, chargedUsd: 0, blockedReason: expect.any(String) });
    expect(before.reservedUsd).toBeGreaterThan(0);
    await expect(transport.fetch(url, request('fallback'))).rejects.toThrow();
    expect(transport.network).toHaveBeenCalledTimes(1);
    expect(transport.report()).toEqual(before);
  });
  it('rejects an unexpected response URL and locks accounting without retrying', async () => {
    const transport = setup(async () => {
      const result = response();
      Object.defineProperty(result, 'url', { value: 'https://example.com' });
      return result;
    });
    await expect(transport.fetch(url, request())).rejects.toThrow('unexpected response URL');
    const before = transport.report();
    expect(before).toMatchObject({ calls: 1, chargedUsd: 0, blockedReason: 'unexpected response URL' });
    expect(before.reservedUsd).toBeGreaterThan(0);
    await expect(transport.fetch(url, request())).rejects.toThrow();
    expect(transport.network).toHaveBeenCalledTimes(1);
    expect(transport.report()).toEqual(before);
  });
  it('locks on transport errors with reservation intact and never retries', async () => {
    const transport = setup(async () => { throw new Error('private transport details'); });
    await expect(transport.fetch(url, request())).rejects.toThrow('Budget transport: transport failure');
    const before = transport.report();
    expect(before.calls).toBe(1);
    expect(before.reservedUsd).toBeGreaterThan(0);
    await expect(transport.fetch(url, request())).rejects.toThrow();
    expect(transport.network).toHaveBeenCalledTimes(1);
    expect(transport.report()).toEqual(before);
  });
  it('includes settled spend when reserving the next request', async () => {
    const transport = setup(async () => response({ cost: 0.2499 }));
    await transport.fetch(url, request());
    const before = transport.report();
    await expect(transport.fetch(url, request())).rejects.toThrow();
    expect(transport.network).toHaveBeenCalledTimes(1);
    expect(transport.report()).toMatchObject({ calls: 1, chargedUsd: 0.2499, reservedUsd: 0, attempts: before.attempts });
  });
  it('accepts Request inputs and metadata.usage, and reports snapshots without mutable references', async () => {
    const transport = setup(async () => new Response(JSON.stringify({ metadata: { usage: { cost: 0.001 } } })));
    await transport.fetch(new Request(url, request()));
    const snapshot = transport.report();
    snapshot.attempts.length = 0;
    expect(transport.report()).toMatchObject({ calls: 1, chargedUsd: 0.001, reservedUsd: 0 });
    expect(transport.report().attempts).toHaveLength(1);
  });
});
