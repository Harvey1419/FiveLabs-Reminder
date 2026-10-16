import { describe, expect, it, vi } from 'vitest';
import { OpenRouterProvider, type OpenRouterAttempt } from '../../../packages/ai/src/openrouter-provider.js';
import { ToolSelectionError } from '../../../packages/ai/src/provider-error.js';
import type { CompletionRequest } from '@templelabs/ai';
import type { JsonObject } from '@templelabs/contracts';

const routes = [
  { id: 'primary', model: 'fixture/primary', providers: ['fixture-primary'], timeoutMs: 1000 },
  { id: 'secondary', model: 'fixture/secondary', providers: ['fixture-secondary'], timeoutMs: 1000 },
];
const usage = { prompt_tokens: 12, completion_tokens: 3 };
const accounted = { inputTokens: 12, outputTokens: 3 };
const healthy = () => ({ usage, choices: [{ message: { role: 'assistant', content: 'Done' }, finish_reason: 'stop' }] });
const rejection = (name = 'reminder_cancel') => `attempted to call tool '${name}' which was not in request.tools`;
const request = (): CompletionRequest => ({ messages: [{ role: 'user', content: 'PRIVATE_USER' }],
  tools: [{ name: 'tools_select', description: 'Select', inputSchema: { type: 'object' } }],
  maxOutputTokens: 100, deadlineMs: Date.now() + 10000, signal: new AbortController().signal });
function fixture(raw: unknown, status = 200) {
  const attempts: OpenRouterAttempt[] = [];
  const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(new Response(JSON.stringify(raw), { status }))
    .mockResolvedValueOnce(new Response(JSON.stringify(healthy())));
  const provider = new OpenRouterProvider({ apiKey: 'fixture-key', routes, fetch, onAttempt: a => attempts.push(a) });
  return { provider, fetch, attempts };
}
function safe(attempts: OpenRouterAttempt[]) {
  expect(JSON.stringify(attempts)).not.toMatch(/PRIVATE_USER|PRIVATE_VENDOR|failed_generation|PRIVATE_ARGS/);
}

describe('safe provider attempt failure classification', () => {
  it('leaves a healthy response unclassified', async () => {
    const { provider, attempts, fetch } = fixture(healthy());
    expect((await provider.complete(request())).usage).toEqual(accounted);
    expect(attempts).toHaveLength(1);
    expect(attempts[0]).not.toHaveProperty('failureClass');
    expect(fetch).toHaveBeenCalledOnce();
  });
  it.each([true, false])('classifies only the narrow native rejection, metered=%s', async metered => {
    const { provider, attempts, fetch } = fixture({ error: { code: 502, message: rejection(),
      metadata: { failed_generation: 'PRIVATE_ARGS' } }, ...(metered ? { usage } : {}) });
    const error = await provider.complete(request()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ToolSelectionError);
    expect(error).toMatchObject({ toolName: 'reminder_cancel', usage: metered ? accounted : { inputTokens: 0, outputTokens: 0 },
      accountingComplete: metered });
    expect(error).not.toHaveProperty('arguments');
    expect(attempts).toHaveLength(1);
    expect(attempts[0]).toMatchObject({ failureClass: 'unadvertised_tool_rejection', usage: metered ? accounted : null });
    expect(fetch).toHaveBeenCalledOnce(); safe(attempts);
  });
  it.each([
    ['generic', 'PRIVATE_VENDOR', 502, undefined],
    ['loaded', rejection('tools_select'), 502, undefined],
    ['multiple', `${rejection()} ${rejection('task_delete')}`, 502, undefined],
    ['wrong code', rejection(), 500, undefined],
    ['choices present', rejection(), 502, []],
    ['unknown envelope', 'Unknown tool PRIVATE_VENDOR', 502, undefined],
  ])('keeps %s errors nonrecoverable with existing metered fallback', async (_label, message, code, choices) => {
    const { provider, attempts, fetch } = fixture({ error: { code, message }, usage,
      ...(choices === undefined ? {} : { choices }) });
    expect((await provider.complete(request())).usage).toEqual({ inputTokens: 24, outputTokens: 6 });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(attempts).toHaveLength(2);
    expect(attempts[0]).toMatchObject({ failureClass: 'provider_error', providerErrorCode: code });
    expect(attempts[1]).not.toHaveProperty('failureClass'); safe(attempts);
  });
  it('does not claim a generic unmetered 502 is a safe rejection', async () => {
    const { provider, attempts, fetch } = fixture({ error: { code: 502, message: 'PRIVATE_VENDOR' } }, 502);
    await expect(provider.complete(request())).rejects.toMatchObject({ code: 'UNVERIFIED_USAGE', accountingComplete: false });
    expect(attempts[0]).toMatchObject({ failureClass: 'provider_error', usage: null });
    expect(fetch).toHaveBeenCalledOnce(); safe(attempts);
  });
  it('classifies missing usage without retry or invented spend', async () => {
    const { provider, attempts, fetch } = fixture({ ...healthy(), usage: null });
    await expect(provider.complete(request())).rejects.toMatchObject({ code: 'UNVERIFIED_USAGE', accountingComplete: false });
    expect(attempts[0]).toMatchObject({ failureClass: 'missing_usage', usage: null });
    expect(fetch).toHaveBeenCalledOnce();
  });
  it('classifies decode failure on its single attempt event and preserves metered fallback', async () => {
    const { provider, attempts, fetch } = fixture({ usage, choices: [] });
    expect((await provider.complete(request())).usage).toEqual({ inputTokens: 24, outputTokens: 6 });
    expect(attempts).toHaveLength(2);
    expect(attempts[0]).toMatchObject({ failureClass: 'invalid_response', usage: accounted });
    expect(attempts[1]).not.toHaveProperty('failureClass');
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it.each(['network', 'json'])('classifies %s uncertainty without retry or complete accounting', async kind => {
    const { provider, attempts, fetch } = fixture(healthy());
    // Replace the queued healthy fixtures so the first call observes the failure.
    fetch.mockReset();
    if (kind === 'network') fetch.mockRejectedValue(new Error('PRIVATE_VENDOR'));
    else fetch.mockResolvedValue(new Response('{'));
    await expect(provider.complete(request())).rejects.toMatchObject({ code: 'UNVERIFIED_USAGE', accountingComplete: false });
    expect(attempts).toHaveLength(1);
    expect(attempts[0]).toMatchObject({ failureClass: 'transport_uncertainty', usage: null, outcome: 'transport_unknown' });
    expect(fetch).toHaveBeenCalledOnce(); safe(attempts);
  });
  it.each([401, 403])('classifies HTTP %s authentication without fallback', async status => {
    const { provider, attempts, fetch } = fixture({ error: { code: status }, usage }, status);
    await expect(provider.complete(request())).rejects.toMatchObject({ code: 'AUTHENTICATION_FAILED', usage: accounted });
    expect(attempts[0]).toMatchObject({ failureClass: 'authentication' });
    expect(fetch).toHaveBeenCalledOnce();
  });
  it('classifies the existing explicit 429 rejection without changing its zero-accounted fallback', async () => {
    const { provider, attempts, fetch } = fixture({ error: { code: 429 } }, 429);
    expect((await provider.complete(request())).usage).toEqual(accounted);
    expect(attempts[0]).toMatchObject({ failureClass: 'rate_limit', usage: { inputTokens: 0, outputTokens: 0 } });
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it('does not interpret structured output rejection as a native selection hint', async () => {
    const attempts: OpenRouterAttempt[] = [];
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(JSON.stringify({ error: { code: 502, message: rejection() }, usage })));
    const provider = new OpenRouterProvider({ apiKey: 'fixture-key', routes: [{ ...routes[0]!, structuredOutput: true }], fetch,
      onAttempt: a => attempts.push(a) });
    await expect(provider.completeStructured({ ...request(), output: { name: 'fixture', schema: { type: 'object', properties: {}, additionalProperties: false } },
      validate: value => value as JsonObject })).rejects.toMatchObject({ code: 'ROUTES_EXHAUSTED' });
    expect(attempts[0]).toMatchObject({ failureClass: 'provider_error' });
    expect(fetch).toHaveBeenCalledOnce();
  });
  it('keeps telemetry detached and swallows callback failures without another inference', async () => {
    const { fetch } = fixture(healthy());
    const provider = new OpenRouterProvider({ apiKey: 'fixture-key', routes, fetch, onAttempt: a => {
      (a.usage as { inputTokens: number }).inputTokens = 999;
      (a.requestedProviders as string[])[0] = 'mutated';
      throw new Error('telemetry');
    } });
    expect((await provider.complete(request())).usage).toEqual(accounted);
    expect(fetch).toHaveBeenCalledOnce();
    expect(routes[0]!.providers).toEqual(['fixture-primary']);
  });
});
