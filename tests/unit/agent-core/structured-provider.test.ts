import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { OpenRouterProvider, type StructuredCompletionRequest, type StructuredAIProvider, type OpenRouterRoute } from '@templelabs/ai';
import { jsonObjectSchema, type JsonObject } from '@templelabs/contracts';
import { createConfiguredStructuredAIProvider } from '../../../src/adapters/agent-core/configured-ai-provider.js';
import { completeForegroundDecision } from '../../../src/adapters/agent-core/foreground-ai-decision.js';
import { getStructuredTurnSchema } from '../../../src/agent/contracts/foreground-turn-schema.js';

const routes: OpenRouterRoute[] = [
  { id: 'primary', model: 'fixture/first', providers: ['first'], timeoutMs: 1000, structuredOutput: true },
  { id: 'secondary', model: 'fixture/second', providers: ['second'], timeoutMs: 1000, structuredOutput: true },
];
const resultSchema = z.strictObject({ answer: z.string() });
function request(): StructuredCompletionRequest {
  return { messages: [{ role: 'user', content: 'Pregunta' }], maxOutputTokens: 200, deadlineMs: Date.now() + 10000,
    signal: new AbortController().signal,
    output: { name: 'answer', schema: { type: 'object', properties: { answer: { type: 'string' } }, required: ['answer'], additionalProperties: false } },
    validate: value => resultSchema.parse(value) };
}
function wire(content: string, finish = 'stop') {
  return { choices: [{ message: { role: 'assistant', content }, finish_reason: finish }],
    usage: { prompt_tokens: 30, completion_tokens: 10 } };
}
function transport(values: unknown[]) {
  return vi.fn<typeof fetch>(async () => new Response(JSON.stringify(values.shift()), { status: 200 }));
}
function body(mock: ReturnType<typeof transport>, index = 0) { return JSON.parse(String(mock.mock.calls[index]?.[1]?.body)); }
function decision(operation = 'task.list', fields: JsonObject = {}, attachmentOnly = false): JsonObject {
  const schema = getStructuredTurnSchema({ attachmentOnly });
  const props = schema.properties as JsonObject;
  const actionsSchema = props.actions as JsonObject;
  const actionProps = (actionsSchema.items as JsonObject).properties as JsonObject;
  return { ...Object.fromEntries(Object.keys(props).map(key => [key, null])),
    responseLanguage: 'es', responseCapability: 'general', learningCandidates: [],
    actions: [{ ...Object.fromEntries(Object.keys(actionProps).map(key => [key, null])), operation, ...(operation === 'task.list' ? { status: 'pending' } : {}), ...fields }] };
}
afterEach(() => vi.useRealTimers());

describe('portable strict JSON completion', () => {
  it('emits a strict schema without native tools and requires the local validator before success', async () => {
    const fetch = transport([wire('{"answer":"Listo"}')]); const req = request();
    const validate = vi.fn(req.validate);
    const provider = new OpenRouterProvider({ apiKey: 'fixture-key', routes, fetch });
    expect(await provider.completeStructured({ ...req, validate })).toEqual({ status: 'success', data: { answer: 'Listo' },
      usage: { inputTokens: 30, outputTokens: 10 } });
    expect(validate).toHaveBeenCalledTimes(1);
    expect(body(fetch)).toMatchObject({ stream: false,
      response_format: { type: 'json_schema', json_schema: { name: 'answer', strict: true, schema: req.output.schema } } });
    expect(body(fetch)).not.toHaveProperty('tools');
    expect(body(fetch)).not.toHaveProperty('tool_choice');
    expect(provider.capabilities.structuredOutput).toBe(true);
  });
  it('can replace the model/provider without changing the portable schema or validated result', async () => {
    const outputs = [];
    for (const route of routes) {
      const fetch = transport([wire('{"answer":"Mismo contrato"}')]);
      const provider = new OpenRouterProvider({ apiKey: 'fixture-key', routes: [route], fetch });
      outputs.push(await provider.completeStructured(request()));
      expect(body(fetch).model).toBe(route.model);
    }
    expect(outputs[0]).toEqual(outputs[1]);
  });
  it('preserves literal think tags and whitespace inside JSON strings instead of cleaning protocol data', async () => {
    const fetch = transport([wire(' {"answer":"  <think>literal</think>  "} ')]);
    expect((await new OpenRouterProvider({ apiKey: 'fixture-key', routes, fetch }).completeStructured(request())).data)
      .toEqual({ answer: '  <think>literal</think>  ' });
  });
  it('skips unsupported routes and rejects a provider lacking declared strict capability before fetching', async () => {
    const fetch = transport([wire('{"answer":"Sí"}')]);
    const provider = new OpenRouterProvider({ apiKey: 'fixture-key', routes: [{ ...routes[0]!, structuredOutput: false }, routes[1]!], fetch });
    await provider.completeStructured(request());
    expect(body(fetch).model).toBe('fixture/second');
    const unsupported = new OpenRouterProvider({ apiKey: 'fixture-key', routes: [{ ...routes[0]!, structuredOutput: false }], fetch });
    await expect(unsupported.completeStructured(request())).rejects.toMatchObject({ code: 'UNSUPPORTED_CAPABILITY' });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it.each(['truncated', 'prose', 'markdown', 'extra field', 'missing field', 'wrong type', 'array', 'native calls'] as const)
    ('rejects metered invalid %s and uses the next independent compatible route', async kind => {
      let invalid = wire('{"answer":"bad"}');
      if (kind === 'truncated') invalid = wire('{"answer":"parseable prefix"}', 'length');
      if (kind === 'prose') invalid = wire('Here is JSON: {"answer":"bad"}');
      if (kind === 'markdown') invalid = wire('```json\n{"answer":"bad"}\n```');
      if (kind === 'extra field') invalid = wire('{"answer":"bad","extra":true}');
      if (kind === 'missing field') invalid = wire('{}');
      if (kind === 'wrong type') invalid = wire('{"answer":42}');
      if (kind === 'array') invalid = wire('[]');
      if (kind === 'native calls') Object.assign(invalid.choices[0]!.message, { tool_calls: [{ id: 'unexpected' }] });
      const fetch = transport([invalid, wire('{"answer":"validated"}')]);
      const result = await new OpenRouterProvider({ apiKey: 'fixture-key', routes, fetch }).completeStructured(request());
      expect(result).toEqual({ status: 'success', data: { answer: 'validated' }, usage: { inputTokens: 60, outputTokens: 20 } });
      expect(body(fetch, 1).max_tokens).toBe(190);
    });
  it('returns terminal refusal without calling the validator or another route', async () => {
    const fetch = transport([{ ...wire('private', 'content_filter'), choices: [{ message: { role: 'assistant', refusal: 'policy', content: null },
      finish_reason: 'content_filter' }] }]);
    const validate = vi.fn(request().validate);
    expect(await new OpenRouterProvider({ apiKey: 'fixture-key', routes, fetch }).completeStructured({ ...request(), validate }))
      .toMatchObject({ status: 'refused', data: null });
    expect(validate).not.toHaveBeenCalled(); expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('does not retry unknown usage and keeps the accounting failure safe', async () => {
    const fetch = transport([{ ...wire('{"answer":"ok"}'), usage: null }]);
    await expect(new OpenRouterProvider({ apiKey: 'fixture-key', routes, fetch }).completeStructured(request()))
      .rejects.toMatchObject({ code: 'UNVERIFIED_USAGE', accountingComplete: false });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('detaches caller schema, messages and validator from asynchronous mutation', async () => {
    const req = request(); const validate = req.validate;
    let attempt = 0;
    const fetch = vi.fn<typeof globalThis.fetch>(async () => {
      attempt++;
      req.output.schema.properties = {};
      (req.messages[0] as { content: string }).content = 'mutated';
      (req as { validate: StructuredCompletionRequest['validate'] }).validate = () => { throw new Error('mutated'); };
      return new Response(JSON.stringify(wire(attempt === 1 ? '{}' : '{"answer":"ok"}')));
    });
    const result = await new OpenRouterProvider({ apiKey: 'fixture-key', routes, fetch }).completeStructured(req);
    expect(result.data).toEqual(validate({ answer: 'ok' }));
    expect(fetch).toHaveBeenCalledTimes(2);
    for (const call of fetch.mock.calls) {
      const sent = JSON.parse(String(call[1]?.body));
      expect(sent.messages[0].content).toBe('Pregunta');
      expect(sent.response_format.json_schema.schema.properties).toHaveProperty('answer');
    }
  });
  it('rechecks the deadline after local host validation before accepting a decision', async () => {
    let now = 100;
    const fetch = transport([wire('{"answer":"too late"}')]);
    const provider = new OpenRouterProvider({ apiKey: 'fixture-key', routes, fetch, now: () => now });
    await expect(provider.completeStructured({ ...request(), deadlineMs: 200, validate: value => { now = 300; return value; } }))
      .rejects.toMatchObject({ code: 'GATEWAY_DEADLINE', usage: { inputTokens: 30, outputTokens: 10 }, accountingComplete: true });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('rejects a validator returning a Promise instead of a validated JSON object', async () => {
    const fetch = transport([wire('{"answer":"one"}')]);
    const provider = new OpenRouterProvider({ apiKey: 'fixture-key', routes: [routes[0]!], fetch });
    await expect(provider.completeStructured({ ...request(), validate: (() => Promise.resolve({ answer: 'async' })) as unknown as StructuredCompletionRequest['validate'] }))
      .rejects.toMatchObject({ code: 'ROUTES_EXHAUSTED' });
  });
  it('keeps failed-route scope across successive strict completions and resets for independent turns', async () => {
    const fetch = transport([wire('{}'), wire('{"answer":"one"}'), wire('{"answer":"two"}'), wire('{"answer":"new turn"}')]);
    const base = new OpenRouterProvider({ apiKey: 'fixture-key', routes, fetch }); const scoped = base.forTurn();
    await scoped.completeStructured(request()); await scoped.completeStructured(request()); await base.forTurn().completeStructured(request());
    expect(fetch.mock.calls.map((_, index) => body(fetch, index).model)).toEqual(['fixture/first', 'fixture/second', 'fixture/second', 'fixture/first']);
  });
  it('shares the output allowance across strict fallback attempts', async () => {
    const fetch = transport([wire('{}')]);
    await expect(new OpenRouterProvider({ apiKey: 'fixture-key', routes, fetch }).completeStructured({
      ...request(), maxOutputTokens: 10,
    })).rejects.toMatchObject({ code: 'GATEWAY_BUDGET', usage: { inputTokens: 30, outputTokens: 10 } });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('reserves the strict schema against the input budget before sending', async () => {
    const fetch = transport([]);
    await expect(new OpenRouterProvider({ apiKey: 'fixture-key', routes, fetch }).completeStructured({
      ...request(), maxInputTokens: 100,
    })).rejects.toMatchObject({ code: 'GATEWAY_BUDGET' });
    expect(fetch).not.toHaveBeenCalled();
  });
  it('uses the same cancellation and timeout boundary while reading structured bodies', async () => {
    vi.useFakeTimers();
    const res = new Response('{}'); vi.spyOn(res, 'json').mockImplementation(() => new Promise(() => {}));
    const fetch = vi.fn<typeof globalThis.fetch>(async () => res);
    const provider = new OpenRouterProvider({ apiKey: 'fixture-key', routes: [{ ...routes[0]!, timeoutMs: 20 }], fetch });
    const outcome = expect(provider.completeStructured(request())).rejects.toMatchObject({ code: 'UNVERIFIED_USAGE', accountingComplete: false });
    await vi.advanceTimersByTimeAsync(20); await outcome;
    expect(fetch).toHaveBeenCalledTimes(1); expect(vi.getTimerCount()).toBe(0);
  });
  it('validates the strict output specification before any transport work', async () => {
    const fetch = transport([]);
    await expect(new OpenRouterProvider({ apiKey: 'fixture-key', routes, fetch }).completeStructured({
      ...request(), output: { name: 'invalid name', schema: {} },
    })).rejects.toThrow('Invalid structured contract');
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('existing foreground contract through the model-neutral structured port', () => {
  it('uses the same foreground rules with a provider implementation independent of OpenRouter', async () => {
    const alternative: StructuredAIProvider = {
      capabilities: { toolCalling: true, structuredOutput: true },
      complete: vi.fn(async () => { throw new Error('Native tools not requested'); }),
      completeStructured: vi.fn(async (req: StructuredCompletionRequest) => ({ status: 'success' as const, data: req.validate(decision()),
        usage: { inputTokens: 12, outputTokens: 4 } })),
    };
    const { output: _output, validate: _validate, ...req } = request();
    const result = await completeForegroundDecision(alternative, req,
      { isAdmin: false, hasHistoricalEvidence: false, currentUserText: 'Mis tareas' });
    expect(result.data).toMatchObject({ actions: [{ domain: 'task', action: 'list', status: 'pending' }] });
    expect(alternative.complete).not.toHaveBeenCalled();
  });
  it('rejects a provider ignoring the eager validator and returning unauthorized canonical operations', async () => {
    const alternative: StructuredAIProvider = {
      capabilities: { toolCalling: true, structuredOutput: true },
      complete: async () => { throw new Error('Unused native mode'); },
      completeStructured: async () => ({ status: 'success', data: { responseLanguage: 'es', responseCapability: 'general',
        learningCandidates: [], actions: [{ domain: 'admin', action: 'metrics' }] },
      usage: { inputTokens: 12, outputTokens: 4 } }),
    };
    const { output: _output, validate: _validate, ...req } = request();
    await expect(completeForegroundDecision(alternative, req,
      { isAdmin: false, hasHistoricalEvidence: false, currentUserText: 'Mis tareas' })).rejects.toThrow('Invalid foreground decision');
  });
  it('rejects canonical operational actions returned by an attachment-only adapter bypassing eager validation', async () => {
    const alternative: StructuredAIProvider = {
      capabilities: { toolCalling: true, structuredOutput: true },
      complete: async () => { throw new Error('Unused native mode'); },
      completeStructured: async () => ({ status: 'success', data: { responseLanguage: 'es', responseCapability: 'general',
        learningCandidates: [], actions: [{ domain: 'task', action: 'list', status: 'pending' }] },
      usage: { inputTokens: 12, outputTokens: 4 } }),
    };
    const { output: _output, validate: _validate, ...req } = request();
    await expect(completeForegroundDecision(alternative, req,
      { isAdmin: false, hasHistoricalEvidence: false, currentUserText: '', attachmentOnly: true })).rejects.toThrow('Invalid canonical operation scope');
  });
  it('preserves current strict route configuration, projects qualified operations and validates locally', async () => {
    const fetch = transport([wire(JSON.stringify(decision()))]);
    const provider = createConfiguredStructuredAIProvider({ apiKey: 'fixture-key', fetch, env: {},
      config: { primary: 'fixture/strict-primary', primaryProviders: ['first'], secondary: 'fixture/native-second', secondaryProviders: ['native-second'],
        lastResort: 'fixture/native-last', lastResortProviders: ['native-last'], strictSecondary: 'fixture/strict-second', strictSecondaryProviders: ['second'],
        strictLastResort: 'fixture/strict-last', strictLastResortProviders: ['last'] } });
    const { output: _output, validate: _validate, ...req } = request();
    const result = await completeForegroundDecision(provider, req, { isAdmin: false, hasHistoricalEvidence: false, currentUserText: 'Mis tareas' });
    expect(result.data).toMatchObject({ responseLanguage: 'es', actions: [{ domain: 'task', action: 'list' }] });
    expect(body(fetch).response_format.json_schema.schema).toEqual(getStructuredTurnSchema({ isAdmin: false }));
    expect(body(fetch).response_format.json_schema.name).toBe('hermes_turn_decision');
  });
  it('enforces attachment-only operation scope locally even when the endpoint ignores its schema', async () => {
    const fetch = transport([wire(JSON.stringify(decision())), wire(JSON.stringify(decision('conversation.reply', { content: 'Descripción del adjunto' }, true)))]);
    const provider = new OpenRouterProvider({ apiKey: 'fixture-key', routes, fetch });
    const { output: _output, validate: _validate, ...req } = request();
    const result = await completeForegroundDecision(provider, req, { isAdmin: false, hasHistoricalEvidence: false,
      currentUserText: '', attachmentOnly: true });
    expect(result.data).toMatchObject({ actions: [{ domain: 'conversation', action: 'reply', content: 'Descripción del adjunto' }] });
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it('does not accept model-generated learning from attachment-only evidence', async () => {
    const value = decision('conversation.reply', { content: 'Adjunto' }, true);
    value.learningCandidates = [{ topicKey: 'profile/work', category: 'fact', content: 'Supuesto', evidence: 'Adjunto' }];
    const fetch = transport([wire(JSON.stringify(value))]);
    const { output: _output, validate: _validate, ...req } = request();
    await expect(completeForegroundDecision(new OpenRouterProvider({ apiKey: 'fixture-key', routes: [routes[0]!], fetch }), req,
      { isAdmin: false, hasHistoricalEvidence: false, currentUserText: '', attachmentOnly: true }))
      .rejects.toMatchObject({ code: 'ROUTES_EXHAUSTED' });
  });
  it('rejects a non-admin model decision attempting admin privileges and accepts the fallback read', async () => {
    const fetch = transport([wire(JSON.stringify(decision('admin.metrics'))), wire(JSON.stringify(decision()))]);
    const provider = new OpenRouterProvider({ apiKey: 'fixture-key', routes, fetch });
    const { output: _output, validate: _validate, ...req } = request();
    const result = await completeForegroundDecision(provider, req, { isAdmin: false, hasHistoricalEvidence: false, currentUserText: 'Mis tareas' });
    expect(result.data).toMatchObject({ actions: [{ domain: 'task', action: 'list' }] });
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it('rejects a lasting profile update with foreign current-user evidence before accepting a mutation', async () => {
    const bad = { ...decision('task.create', { title: 'Propuesta', projectless: true }), profileUpdate: { sourceQuote: 'English always', language: 'en' } };
    const fetch = transport([wire(JSON.stringify(bad)), wire(JSON.stringify(decision()))]);
    const provider = new OpenRouterProvider({ apiKey: 'fixture-key', routes, fetch });
    const { output: _output, validate: _validate, ...req } = request();
    const result = await completeForegroundDecision(provider, req, { isAdmin: false, hasHistoricalEvidence: false, currentUserText: 'Crea propuesta' });
    expect(result.data).not.toHaveProperty('profileUpdate');
    expect(result.data).toMatchObject({ actions: [{ domain: 'task', action: 'list' }] });
  });
  it('requires the original non-null learning/capability semantics rather than trusting schema enforcement', async () => {
    const invalid = { ...decision(), learningCandidates: null, responseCapability: null };
    const fetch = transport([wire(JSON.stringify(invalid)), wire(JSON.stringify(decision()))]);
    const { output: _output, validate: _validate, ...req } = request();
    const result = await completeForegroundDecision(new OpenRouterProvider({ apiKey: 'fixture-key', routes, fetch }), req,
      { isAdmin: false, hasHistoricalEvidence: false, currentUserText: 'Mis tareas' });
    expect(jsonObjectSchema.parse(result.data).learningCandidates).toEqual([]);
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
