import { describe, expect, it, vi } from 'vitest';
import { createConservativeEvaluationTransport } from '../../../scripts/evals/conservative-evaluation-transport.js';
const url = 'https://openrouter.ai/api/v1/chat/completions';
const request = { method: 'POST', body: JSON.stringify({ model: 'primary', max_tokens: 10, messages: [{ role: 'user', content: 'hi' }] }) };
const rates = { primary: { prompt: 0.000001, completion: 0.000002 } };
const known = () => new Response(JSON.stringify({ id: 'generation', model: 'primary', usage: { prompt_tokens: 5, completion_tokens: 2, cost: 0.000009 } }));
describe('conservative live evaluation transport', () => {
  it('keeps unknown costs reserved while permitting the product next request without retrying', async () => {
    const network = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(JSON.stringify({ error: { code: 502, message: 'validation error' } }))).mockResolvedValueOnce(known());
    const budget = createConservativeEvaluationTransport({ fetch: network, rates, maxCalls: 2, maxUsd: 0.01 });
    await budget.fetch(url, request);
    const reserved = budget.report().reservedUsd;
    expect(reserved).toBeGreaterThan(0); expect(network).toHaveBeenCalledOnce();
    await budget.fetch(url, request);
    expect(budget.report()).toMatchObject({ calls: 2, reservedUsd: reserved, chargedUsd: 0.000009, accountingComplete: false });
    await expect(budget.fetch(url, request)).rejects.toThrow('exhausted');
    expect(network).toHaveBeenCalledTimes(2);
  });
  it('serializes concurrent admission so global call limits cannot race', async () => {
    const network = vi.fn<typeof fetch>(async () => known());
    const budget = createConservativeEvaluationTransport({ fetch: network, rates, maxCalls: 1, maxUsd: 0.01 });
    const results = await Promise.allSettled([budget.fetch(url, request), budget.fetch(url, request)]);
    expect(results.map(r => r.status)).toEqual(['fulfilled', 'rejected']);
    expect(network).toHaveBeenCalledOnce();
  });
  it('prevents dispatch when the next reservation would exceed remaining spend', async () => {
    const network = vi.fn<typeof fetch>(async () => new Response('{}'));
    const budget = createConservativeEvaluationTransport({ fetch: network, rates, maxCalls: 3, maxUsd: 0.0004 });
    await budget.fetch(url, request);
    await expect(budget.fetch(url, request)).rejects.toThrow();
    expect(network).toHaveBeenCalledOnce();
    expect(budget.report().reservedUsd).toBeGreaterThan(0);
  });
});
