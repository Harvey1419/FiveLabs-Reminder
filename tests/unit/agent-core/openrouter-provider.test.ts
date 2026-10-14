import { afterEach, describe, expect, it, vi } from 'vitest';
import { OpenRouterProvider, decodeOpenRouterResponse, openRouterPayload, reportedOpenRouterUsage,
  estimateBoundedInput, type OpenRouterAttempt, type CompletionRequest, type OpenRouterRoute } from '@templelabs/ai';
import type { AIMessage } from '@templelabs/contracts';
import { createConfiguredAIProvider } from '../../../src/adapters/agent-core/configured-ai-provider.js';

const routes: OpenRouterRoute[] = [
  { id: 'primary', model: 'fixture/primary', providers: ['fixture-primary'], timeoutMs: 1000, temperature: 0 },
  { id: 'secondary', model: 'fixture/secondary', providers: ['fixture-secondary'], timeoutMs: 1000 },
];
function request(messages: AIMessage[] = [{ role: 'user', content: 'Crea una tarea' }]): CompletionRequest {
  return { messages, tools: [{ name: 'task_create', description: 'Create task', inputSchema: { type: 'object' } }],
    maxOutputTokens: 100, deadlineMs: Date.now() + 10000, signal: new AbortController().signal };
}
function wire(overrides: Record<string, unknown> = {}) {
  return { choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: 'local', type: 'function',
    function: { name: 'task_create', arguments: '{"title":"Propuesta","scheduleReminder":false}' } }] }, finish_reason: 'tool_calls' }],
  usage: { prompt_tokens: 20, completion_tokens: 10 }, ...overrides };
}
function transport(responses: Response[]) {
  return vi.fn<typeof fetch>(async () => { const next = responses.shift(); if (!next) throw new Error('Unexpected fetch'); return next; });
}
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
const body = (mock: ReturnType<typeof transport>, index = 0) => JSON.parse(String(mock.mock.calls[index]?.[1]?.body));
afterEach(() => vi.useRealTimers());

describe('native OpenRouter wire protocol', () => {
  it('maps closed host call/result pairs to short wire IDs and preserves structured error observations', () => {
    const history: AIMessage[] = [{ role: 'user', content: 'Busca' }, { role: 'assistant', content: '', toolCalls: [
      { id: 'request:step:1:host', name: 'task_create', arguments: { title: 'Propuesta' } },
      { id: 'request:step:1:other', name: 'task_create', arguments: { title: 'Otra' } },
    ] }, { role: 'tool', toolCallId: 'request:step:1:other', content: { status: 'failed', observation: 'Invalid details' }, isError: true },
    { role: 'tool', toolCallId: 'request:step:1:host', content: { status: 'success' }, isError: false }];
    const payload = openRouterPayload(request(history), routes[0]!, 100);
    const messages = payload.messages as Record<string, unknown>[];
    expect(messages[1]?.tool_calls).toMatchObject([{ id: 'call_0', function: { arguments: '{"title":"Propuesta"}' } }, { id: 'call_1' }]);
    expect(messages[2]).toEqual({ role: 'tool', tool_call_id: 'call_1', content: '{"status":"failed","observation":"Invalid details"}' });
    expect(payload.provider).toEqual({ order: ['fixture-primary'], only: ['fixture-primary'], allow_fallbacks: false, require_parameters: true });
    expect(payload).not.toHaveProperty('response_format');
    expect(payload.tools).toEqual([{ type: 'function', function: { name: 'task_create', description: 'Create task', parameters: { type: 'object' } } }]);
  });
  it('rejects unresolved pairs and duplicate advertised tools before transport', async () => {
    const fetch = transport([]);
    const provider = new OpenRouterProvider({ apiKey: 'fixture-key', routes, fetch });
    await expect(provider.complete(request([{ role: 'assistant', content: '', toolCalls: [{ id: 'pending', name: 'task_create', arguments: {} }] }]))).rejects.toThrow();
    const req = request();
    await expect(provider.complete({ ...req, tools: [...req.tools, ...req.tools] })).rejects.toThrow('Duplicate tools');
    expect(fetch).not.toHaveBeenCalled();
  });
  it('decodes arguments as object JSON and normalizes reported usage', () => {
    expect(decodeOpenRouterResponse(wire())).toMatchObject({ stopReason: 'tool_calls', usage: { inputTokens: 20, outputTokens: 10 },
      message: { content: '', toolCalls: [{ id: 'local', name: 'task_create', arguments: { title: 'Propuesta' } }] } });
    expect(reportedOpenRouterUsage({})).toBeNull();
    expect(reportedOpenRouterUsage({ usage: { prompt_tokens: '20', completion_tokens: 10 } })).toBeNull();
  });
  it.each(['truncated', 'duplicate', 'arguments', 'finish', 'error envelope', 'usage'] as const)('rejects incomplete native decision: %s', kind => {
    const value = wire(); const choice = value.choices[0]!;
    if (kind === 'truncated') choice.finish_reason = 'length';
    if (kind === 'duplicate') choice.message.tool_calls.push(choice.message.tool_calls[0]!);
    if (kind === 'arguments') choice.message.tool_calls[0]!.function.arguments = '[]';
    if (kind === 'finish') choice.finish_reason = 'stop';
    if (kind === 'error envelope') Object.assign(value, { error: { message: 'private detail' } });
    if (kind === 'usage') Object.assign(value, { usage: null });
    expect(() => decodeOpenRouterResponse(value)).toThrow();
  });
  it('returns a terminal refusal without exposing refusal prose or malformed tool calls', () => {
    const raw = wire({ choices: [{ message: { role: 'assistant', content: 'private policy', refusal: 'refused', tool_calls: 'malformed' }, finish_reason: 'content_filter' }] });
    expect(decodeOpenRouterResponse(raw)).toMatchObject({ stopReason: 'refused', message: { content: '', toolCalls: [] } });
  });
});

describe('bounded provider fallback and safe accounting', () => {
  it('falls back after an explicit pre-generation 429 without replaying the rejected route', async () => {
    const fetch = transport([json({ error: { code: 429, message: 'Provider returned error' } }, 429), json(wire()), json(wire())]);
    const attempts: OpenRouterAttempt[] = [];
    const provider = new OpenRouterProvider({ apiKey: 'fixture-key', routes, fetch, onAttempt: a => attempts.push(a) });
    expect((await provider.complete(request())).usage).toEqual({ inputTokens: 20, outputTokens: 10 });
    await provider.complete(request());
    expect(fetch.mock.calls.map((_, index) => body(fetch, index).model)).toEqual(['fixture/primary', 'fixture/secondary', 'fixture/secondary']);
    expect(attempts[0]).toMatchObject({ status: 429, usage: { inputTokens: 0, outputTokens: 0 }, generationId: null });
  });
  it.each([{ error: { code: 429 }, id: 'generated' }, { error: { code: 429 }, choices: [] }, { error: {} }])('never treats an ambiguous 429 as a certified rejection: %j', async raw => {
    const fetch = transport([json(raw, 429), json(wire())]);
    await expect(new OpenRouterProvider({ apiKey: 'fixture-key', routes, fetch }).complete(request())).rejects.toMatchObject({ code: 'UNVERIFIED_USAGE' });
    expect(fetch).toHaveBeenCalledOnce();
  });
  it('uses a single explicit native route and leaves caller output cap unchanged', async () => {
    const fetch = transport([json(wire())]);
    const provider = new OpenRouterProvider({ apiKey: 'fixture-key', routes, fetch });
    expect(await provider.complete(request())).toMatchObject({ usage: { inputTokens: 20, outputTokens: 10 } });
    expect(body(fetch)).toMatchObject({ model: 'fixture/primary', max_tokens: 100, stream: false, tool_choice: 'auto' });
    expect(fetch.mock.calls[0]?.[1]?.headers).toMatchObject({ Authorization: 'Bearer fixture-key' });
    expect(provider.capabilities.structuredOutput).toBe(false);
    expect(JSON.stringify(provider)).not.toContain('fixture-key');
  });
  it('sums metered failed attempts and reduces the remaining output allowance before fallback', async () => {
    const failed = wire({ choices: [{ message: { role: 'assistant', content: '' }, finish_reason: 'error' }] });
    const fetch = transport([json(failed), json(wire())]);
    const provider = new OpenRouterProvider({ apiKey: 'fixture-key', routes, fetch });
    expect((await provider.complete(request())).usage).toEqual({ inputTokens: 40, outputTokens: 20 });
    expect(body(fetch, 1)).toMatchObject({ model: 'fixture/secondary', max_tokens: 90 });
    expect(body(fetch, 1).provider.allow_fallbacks).toBe(false);
  });
  it('never revisits a failed route within a turn, while a fresh turn starts at primary', async () => {
    const fetch = transport([json({ error: {}, usage: { prompt_tokens: 3, completion_tokens: 0 } }, 429), json(wire()), json(wire()), json(wire())]);
    const base = new OpenRouterProvider({ apiKey: 'fixture-key', routes, fetch });
    const first = base.forTurn();
    await first.complete(request()); await first.complete(request()); await base.forTurn().complete(request());
    expect(fetch.mock.calls.map((_, index) => body(fetch, index).model)).toEqual(['fixture/primary', 'fixture/secondary', 'fixture/secondary', 'fixture/primary']);
  });
  it.each(['missing usage', 'network', 'body parse'] as const)('stops on %s without inventing spend or calling another route', async kind => {
    const fetch = transport(kind === 'missing usage' ? [json(wire({ usage: null }))] : kind === 'body parse' ? [new Response('{')] : []);
    if (kind === 'network') fetch.mockRejectedValueOnce(new Error('private-key network detail'));
    const provider = new OpenRouterProvider({ apiKey: 'private-key', routes, fetch });
    await expect(provider.complete(request())).rejects.toMatchObject({ code: 'UNVERIFIED_USAGE', accountingComplete: false });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('reports prior known usage when a later attempt loses accounting', async () => {
    const fetch = transport([json({ error: {}, usage: { prompt_tokens: 30, completion_tokens: 5 } }, 503), json(wire({ usage: null }))]);
    await expect(new OpenRouterProvider({ apiKey: 'fixture-key', routes, fetch }).complete(request())).rejects.toMatchObject({
      code: 'UNVERIFIED_USAGE', usage: { inputTokens: 30, outputTokens: 5 }, accountingComplete: false,
    });
  });
  it('does not dispatch a fallback when known output spend exhausts its shared allowance', async () => {
    const fetch = transport([json({ error: {}, usage: { prompt_tokens: 20, completion_tokens: 100 } }, 503)]);
    await expect(new OpenRouterProvider({ apiKey: 'fixture-key', routes, fetch }).complete(request())).rejects.toMatchObject({
      code: 'GATEWAY_BUDGET', usage: { inputTokens: 20, outputTokens: 100 }, accountingComplete: true,
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('preserves known spend when all compatible metered routes are exhausted', async () => {
    const failed = { error: {}, usage: { prompt_tokens: 10, completion_tokens: 5 } };
    const fetch = transport([json(failed, 503), json(failed, 503)]);
    await expect(new OpenRouterProvider({ apiKey: 'fixture-key', routes, fetch }).complete(request()))
      .rejects.toMatchObject({ code: 'ROUTES_EXHAUSTED', usage: { inputTokens: 20, outputTokens: 10 }, accountingComplete: true });
  });
  it('rejects a partial or invalid runtime spend contract before fetching', async () => {
    const fetch = transport([]);
    const provider = new OpenRouterProvider({ apiKey: 'fixture-key', routes, fetch });
    await expect(provider.complete({ ...request(), spendLimit: { maxUsd: 1 } } as CompletionRequest))
      .rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    expect(fetch).not.toHaveBeenCalled();
  });
  it('requires reservation room for another complete input after a failed attempt', async () => {
    const fetch = transport([json({ error: {}, usage: { prompt_tokens: 1000, completion_tokens: 1 } }, 503)]);
    const provider = new OpenRouterProvider({ apiKey: 'fixture-key', routes, fetch });
    await expect(provider.complete({ ...request(), maxInputTokens: 1300 })).rejects.toMatchObject({ code: 'GATEWAY_BUDGET' });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('reserves a new input against the same spend ceiling before attempting fallback', async () => {
    const fetch = transport([json({ error: {}, usage: { prompt_tokens: 1000, completion_tokens: 0 } }, 503)]);
    const provider = new OpenRouterProvider({ apiKey: 'fixture-key', routes, fetch });
    await expect(provider.complete({ ...request(), spendLimit: { maxUsd: 0.0014, inputUsdPerMillion: 1, outputUsdPerMillion: 0 } }))
      .rejects.toMatchObject({ code: 'GATEWAY_BUDGET', usage: { inputTokens: 1000, outputTokens: 0 } });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('rejects reported priced overspend before returning a tool decision', async () => {
    const fetch = transport([json(wire({ usage: { prompt_tokens: 2000, completion_tokens: 10 } }))]);
    await expect(new OpenRouterProvider({ apiKey: 'fixture-key', routes, fetch }).complete({
      ...request(), spendLimit: { maxUsd: 0.0014, inputUsdPerMillion: 1, outputUsdPerMillion: 0 },
    })).rejects.toMatchObject({ code: 'GATEWAY_BUDGET' });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('caps wire output against the remaining total budget and refuses reported overspend', async () => {
    const fetch = transport([json(wire({ usage: { prompt_tokens: 1200, completion_tokens: 30 } }))]);
    const req = request();
    const estimate = new TextEncoder().encode(JSON.stringify(openRouterPayload(req, routes[0]!, 100))).length + 256;
    const provider = new OpenRouterProvider({ apiKey: 'fixture-key', routes, fetch });
    await expect(provider.complete({ ...req, maxTotalTokens: estimate + 20 })).rejects.toMatchObject({ code: 'GATEWAY_BUDGET' });
    expect(body(fetch).max_tokens).toBe(20);
  });
  it('skips a route whose minimum output cannot fit instead of raising the caller cap', async () => {
    const fetch = transport([json(wire())]);
    const provider = new OpenRouterProvider({ apiKey: 'fixture-key', routes: [{ ...routes[0]!, minOutputTokens: 2800 }, routes[1]!], fetch });
    await provider.complete(request());
    expect(body(fetch).model).toBe('fixture/secondary'); expect(body(fetch).max_tokens).toBe(100);
  });
  it('does not fall back on a refusal or an authentication rejection', async () => {
    const fetch = transport([json(wire({ choices: [{ message: { role: 'assistant', content: null, refusal: 'policy' }, finish_reason: 'content_filter' }] }))]);
    expect((await new OpenRouterProvider({ apiKey: 'fixture-key', routes, fetch }).complete(request())).stopReason).toBe('refused');
    expect(fetch).toHaveBeenCalledTimes(1);
    const denied = transport([json({ error: {} }, 401)]);
    await expect(new OpenRouterProvider({ apiKey: 'fixture-key', routes, fetch: denied }).complete(request())).rejects.toMatchObject({ code: 'AUTHENTICATION_FAILED' });
    expect(denied).toHaveBeenCalledTimes(1);
  });
  it('checks cancellation and the whole-turn deadline before fetching', async () => {
    const fetch = transport([]); const controller = new AbortController(); controller.abort();
    const provider = new OpenRouterProvider({ apiKey: 'fixture-key', routes, fetch });
    await expect(provider.complete({ ...request(), signal: controller.signal })).rejects.toMatchObject({ code: 'GATEWAY_ABORTED' });
    await expect(provider.complete({ ...request(), deadlineMs: 1 })).rejects.toMatchObject({ code: 'GATEWAY_DEADLINE' });
    expect(fetch).not.toHaveBeenCalled();
  });
  it('stops an abort-ignoring fetch on host cancellation without another route', async () => {
    const controller = new AbortController();
    const fetch = vi.fn<typeof globalThis.fetch>(() => new Promise(() => {}));
    const provider = new OpenRouterProvider({ apiKey: 'fixture-key', routes, fetch });
    const result = provider.complete({ ...request(), signal: controller.signal });
    await Promise.resolve(); controller.abort();
    await expect(result).rejects.toMatchObject({ code: 'GATEWAY_ABORTED', accountingComplete: false });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('checks cancellation again before a queued transport starts', async () => {
    const controller = new AbortController();
    const fetch = transport([]);
    const result = new OpenRouterProvider({ apiKey: 'fixture-key', routes, fetch }).complete({ ...request(), signal: controller.signal });
    controller.abort();
    await expect(result).rejects.toMatchObject({ code: 'GATEWAY_ABORTED' });
    expect(fetch).not.toHaveBeenCalled();
  });
  it('retains reported usage even if the turn deadline expires while reading a complete body', async () => {
    let now = 100;
    const res = json(wire());
    vi.spyOn(res, 'json').mockImplementation(async () => { now = 300; return wire(); });
    const fetch = transport([res]);
    const provider = new OpenRouterProvider({ apiKey: 'fixture-key', routes, fetch, now: () => now });
    await expect(provider.complete({ ...request(), deadlineMs: 200 })).rejects.toMatchObject({
      code: 'GATEWAY_DEADLINE', usage: { inputTokens: 20, outputTokens: 10 }, accountingComplete: true,
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('bounds a hanging JSON-body read with the route timeout and releases timers', async () => {
    vi.useFakeTimers();
    const res = json(wire()); vi.spyOn(res, 'json').mockImplementation(() => new Promise(() => {}));
    const fetch = transport([res]);
    const provider = new OpenRouterProvider({ apiKey: 'fixture-key', routes: [{ ...routes[0]!, timeoutMs: 20 }], fetch });
    const result = expect(provider.complete(request())).rejects.toMatchObject({ code: 'UNVERIFIED_USAGE', accountingComplete: false });
    await vi.advanceTimersByTimeAsync(20); await result;
    expect(vi.getTimerCount()).toBe(0);
  });
  it('rejects shared providers across routes and detaches caller-owned route configuration', async () => {
    expect(() => new OpenRouterProvider({ apiKey: 'fixture-key', routes: [routes[0]!, { ...routes[1]!, providers: routes[0]!.providers }] }))
      .toThrow('INVALID_REQUEST');
    const configured = structuredClone(routes);
    const fetch = transport([json(wire())]);
    const provider = new OpenRouterProvider({ apiKey: 'fixture-key', routes: configured, fetch });
    (configured[0] as { model: string }).model = 'mutated/model';
    await provider.complete(request()); expect(body(fetch).model).toBe('fixture/primary');
  });
  it('adapts the current native route configuration, timeout and reasoning settings without reading live credentials', async () => {
    const fetch = transport([json(wire())]);
    const config = { primary: 'fixture/configured', primaryProviders: ['fixture-primary'], secondary: 'fixture/second', secondaryProviders: ['fixture-second'],
      lastResort: 'fixture/last', lastResortProviders: ['fixture-last'] };
    const provider = createConfiguredAIProvider({ apiKey: 'fixture-key', config, env: { OPENROUTER_PRIMARY_TIMEOUT_MS: '50', OPENROUTER_PRIMARY_REASONING_EFFORT: 'low' }, fetch });
    await provider.complete(request());
    expect(body(fetch)).toMatchObject({ model: 'fixture/configured', reasoning: { effort: 'low', exclude: true } });
  });
});


describe('bounded V2 wire estimation and generation telemetry', () => {
  it('estimates the actual route payload and keeps preflight below 1800 including schemas', async () => {
    const fetch = transport([json(wire({ id: 'gen-fixture-1', model: 'fixture/actual', provider: 'Google AI Studio' }))]);
    const attempts: OpenRouterAttempt[] = [];
    const provider = new OpenRouterProvider({ apiKey: 'fixture-secret', routes, fetch,
      estimateInputTokens: estimateBoundedInput, onAttempt: attempt => attempts.push(attempt) });
    const req = { ...request(), maxInputTokens: 1800, maxTotalTokens: 3000 };
    expect(provider.estimateNativeInput(req)).toBeLessThanOrEqual(1800);
    await provider.forTurn().complete(req);
    expect(estimateBoundedInput(body(fetch))).toBeLessThanOrEqual(1800);
    expect(attempts).toEqual([expect.objectContaining({ generationId: 'gen-fixture-1', model: 'fixture/actual', provider: 'Google AI Studio',
      usage: { inputTokens: 20, outputTokens: 10 }, requestedProviders: ['fixture-primary'], outcome: 'response', status: 200 })]);
    expect(JSON.stringify(attempts)).not.toContain('fixture-secret'); expect(JSON.stringify(attempts)).not.toContain('Crea una tarea');
  });
  it('logs metered failed attempts and successful fallback separately without inventing an actual provider', async () => {
    const fetch = transport([json({ id: 'gen-failed', error: {}, usage: { prompt_tokens: 3, completion_tokens: 0 } }, 502), json(wire({ id: 'gen-fallback' }))]);
    const attempts: OpenRouterAttempt[] = [];
    const provider = new OpenRouterProvider({ apiKey: 'fixture', routes, fetch, estimateInputTokens: estimateBoundedInput,
      onAttempt: attempt => attempts.push(attempt) });
    expect((await provider.complete({ ...request(), maxInputTokens: 1800 })).usage.inputTokens).toBe(23);
    expect(attempts.map(attempt => [attempt.generationId, attempt.route, attempt.provider, attempt.status])).toEqual([
      ['gen-failed', 'primary', null, 502], ['gen-fallback', 'secondary', null, 200],
    ]);
  });
  it('never sends an over-budget wire payload, including multilingual input and tool schema bytes', async () => {
    const fetch = transport([]);
    const provider = new OpenRouterProvider({ apiKey: 'fixture', routes, fetch, estimateInputTokens: estimateBoundedInput });
    const req = { ...request([{ role: 'user', content: '🧬 中文 '.repeat(2000) }]), maxInputTokens: 1800 };
    await expect(provider.complete(req)).rejects.toMatchObject({ code: 'GATEWAY_BUDGET' }); expect(fetch).not.toHaveBeenCalled();
    expect(() => estimateBoundedInput({ content: '<|endoftext|> <|im_start|>' })).not.toThrow();
  });
  it('records authoritative over-budget usage then rejects the response before execution', async () => {
    const fetch = transport([json(wire({ id: 'gen-over', usage: { prompt_tokens: 1801, completion_tokens: 10 } }))]);
    const attempts: OpenRouterAttempt[] = [];
    const provider = new OpenRouterProvider({ apiKey: 'fixture', routes, fetch, estimateInputTokens: estimateBoundedInput, onAttempt: attempt => attempts.push(attempt) });
    await expect(provider.complete({ ...request(), maxInputTokens: 1800 })).rejects.toMatchObject({ code: 'GATEWAY_BUDGET' });
    expect(attempts[0]?.usage?.inputTokens).toBe(1801); expect(fetch).toHaveBeenCalledOnce();
  });
  it('does not retry successful inference when telemetry logging throws', async () => {
    const fetch = transport([json(wire())]);
    const provider = new OpenRouterProvider({ apiKey: 'fixture', routes, fetch, onAttempt: () => { throw new Error('logger failed'); } });
    expect((await provider.forTurn().complete(request())).usage.inputTokens).toBe(20); expect(fetch).toHaveBeenCalledOnce();
  });
});
