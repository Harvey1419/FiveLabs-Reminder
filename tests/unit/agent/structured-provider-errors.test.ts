import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { performance } from 'node:perf_hooks';
import { callChatCompletion as callChat, callMemoryExtraction } from '../../../src/agent/providers/client.js';

// Every call below requests returnMessage; inspect its existing message/diagnostic fields.
type MessageFixture = { content: string; routeStage?: unknown; attemptDiagnostics: Record<string, unknown> };
function callChatCompletion(...args: Parameters<typeof callChat>) {
  return callChat(...args) as Promise<MessageFixture>;
}
const reply = { actions: [{ domain: 'conversation', action: 'reply', content: 'Hola.' }] };
const responseFormat = {
  type: 'json_schema',
  json_schema: {
    name: 'diagnostic_test', strict: true,
    schema: {
      type: 'object', additionalProperties: false,
      properties: {
        actions: {
          type: 'array', items: {
            type: 'object', additionalProperties: false,
            properties: {
              domain: { type: 'string', enum: ['conversation'] },
              action: { type: 'string', enum: ['reply'] },
              content: { type: 'string' },
            },
            required: ['domain', 'action', 'content'],
          },
        },
      },
      required: ['actions'],
    },
  },
};

function response(content: unknown, status = 200) {
  return new Response(typeof content === 'string' ? content : JSON.stringify(content), {
    status, headers: { 'Content-Type': 'application/json' },
  });
}

function success(content = JSON.stringify(reply)) {
  return response({ provider: 'BaseTen', choices: [{ finish_reason: 'stop', message: { content } }] });
}

function wrapper(raw: unknown) {
  return { error: { message: 'Provider returned error', code: 400, metadata: { provider_name: 'Groq', raw } as { provider_name: string; raw: unknown; headers?: Record<string, string> } } };
}

function failureDetail() {
  const line = vi.mocked(console.warn).mock.calls.map(([text]) => text).find((text) => text.includes('status=400'));
  expect(line).toBeDefined();
  return JSON.parse(line.slice(line.indexOf(' metadata=') + ' metadata='.length));
}

async function foregroundFailure(body: unknown) {
  const fetchMock = vi.spyOn(globalThis, 'fetch')
    .mockResolvedValueOnce(response(body, 400))
    .mockResolvedValueOnce(success());
  const result = await callChatCompletion([{ role: 'user', content: 'Hola hola' }], {
    responseFormat, purpose: 'initial', returnMessage: true,
  });
  expect(fetchMock).toHaveBeenCalledTimes(2);
  expect(JSON.parse(result.content)).toEqual(reply);
  const payloads = fetchMock.mock.calls.map(([, options]) => JSON.parse(options!.body as string));
  expect(payloads[0].model).toBe('openai/gpt-oss-120b');
  expect(payloads[0].provider).toEqual({
    order: ['groq'], only: ['groq'], allow_fallbacks: false, require_parameters: true,
  });
  expect(payloads[1].provider.only).toEqual(['cerebras/fp16']);
  for (const payload of payloads) {
    expect(payload.response_format).toEqual(responseFormat);
    expect(payload.response_format.json_schema.strict).toBe(true);
    expect(payload).not.toHaveProperty('tools');
    expect(payload).not.toHaveProperty('tool_choice');
  }
}

describe('strict foreground provider error diagnostics', () => {
  it.each(['approval_decision', 'continuation_decision'])('validates %s at the same provider boundary as the initial decision', async (purpose) => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(success('{"relation":"invented"}'))
      .mockResolvedValueOnce(success('{"relation":"cancel"}'));
    const validate = vi.fn((content: string) => ({ valid: JSON.parse(content).relation === 'cancel' }));
    const result = await callChatCompletion([], { responseFormat, purpose, returnMessage: true, validateStructuredContent: validate });
    expect(result.routeStage).toBe('secondary');
    expect(validate).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls.map(([, init]) => JSON.parse(init!.body as string).stream)).toEqual([false, false]);
  });

  it.each(['approval_decision', 'continuation_decision'])('rejects a parseable but truncated %s', async (purpose) => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(response({ choices: [{ finish_reason: 'length', message: { content: '{"relation":"approval","decision":"approve_all"}' } }] }))
      .mockResolvedValueOnce(success('{"relation":"unrelated"}'));
    const result = await callChatCompletion([], { responseFormat, purpose, returnMessage: true });
    expect(result.routeStage).toBe('secondary');
    expect(vi.mocked(console.warn).mock.calls.flat().join('\n')).toContain('truncated_structured_output');
  });
  beforeEach(() => {
    vi.stubEnv('OPENROUTER_API_KEY', 'sk-or-diagnostic-test-secret');
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it.each(['string', 'object'])('keeps nested provider diagnostics when metadata.raw is a JSON %s without retrying or changing the request', async (format) => {
    // Synthetic error fixture; this is not a claim about which schema keyword Groq rejects.
    const raw = { error: {
      message: 'Schema validation failed at properties.actions.',
      type: 'invalid_request_error', code: 'invalid_json_schema', param: 'response_format',
    } };
    await foregroundFailure(wrapper(format === 'string' ? JSON.stringify(raw) : raw));
    expect(failureDetail()).toMatchObject({ observedProvider: 'Groq', errorType: 'invalid_request_error',
      errorCode: 'invalid_json_schema', errorParam: 'response_format' });
    expect(JSON.stringify(failureDetail())).not.toContain(raw.error.message);
  });

  it('keeps a plain-text nested provider error without treating it as a TurnIntent', async () => {
    await foregroundFailure(wrapper('Provider parameter rejected.'));
    expect(JSON.stringify(failureDetail())).not.toContain('Provider parameter rejected.');
  });

  it('classifies provider schema compilation failures separately from availability', async () => {
    await foregroundFailure(wrapper({ error: {
      message: 'The specified schema produces a constraint that has too many states for serving.',
      type: 'invalid_request_error', code: '400',
    } }));
    expect(vi.mocked(console.warn).mock.calls.flat().join('\n')).toContain('reason=schema_rejection');
  });

  it('classifies generated-schema rejection, survives a rate-limited secondary, and succeeds on a compatible strict fallback', async () => {
    const generatedMismatch = wrapper({ error: {
      message: "Generated JSON does not match the expected schema: missing properties: 'limit'",
      type: 'invalid_request_error', code: 'json_validate_failed', param: 'response_format',
    } });
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(response(generatedMismatch, 400))
      .mockResolvedValueOnce(response({ error: { message: 'rate limited' } }, 429))
      .mockResolvedValueOnce(success());

    const result = await callChatCompletion([{ role: 'user', content: 'Hola' }], {
      responseFormat, purpose: 'initial', returnMessage: true,
      validateStructuredContent: (content) => ({ valid: JSON.parse(content).actions?.length > 0 }),
    });

    expect(result.routeStage).toBe('last_resort');
    expect(JSON.parse(result.content)).toEqual(reply);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    const payloads = fetchMock.mock.calls.map(([, init]) => JSON.parse(init!.body as string));
    expect(payloads.map((payload) => payload.provider.only)).toEqual([
      ['groq'], ['cerebras/fp16'], ['baseten/fp8'],
    ]);
    expect(payloads.every((payload) => payload.response_format.json_schema.strict === true)).toBe(true);
    const logs = [...vi.mocked(console.warn).mock.calls, ...vi.mocked(console.log).mock.calls].flat().join('\n');
    expect(logs).toContain('reason=structured_generation_rejection');
    expect(logs).toContain('trigger=rate_limit');
  });

  it('treats HTTP-200 invalid structured content as a failed attempt and accepts a valid compatible fallback', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(success('{"actions":[]}'))
      .mockResolvedValueOnce(success());

    const result = await callChatCompletion([{ role: 'user', content: 'Hola' }], {
      responseFormat, purpose: 'initial', returnMessage: true,
      validateStructuredContent: (content) => ({ valid: JSON.parse(content).actions?.length > 0 }),
    });

    expect(result.routeStage).toBe('secondary');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(vi.mocked(console.warn).mock.calls.flat().join('\n')).toContain('reason=invalid_structured_output');
  });

  it('returns infrastructure-neutral degradation after all compatible strict routes fail', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(response({ error: { message: 'offline' } }, 503))
      .mockResolvedValueOnce(response({ error: { message: 'busy' } }, 429))
      .mockResolvedValueOnce(response({ error: { message: 'busy' } }, 429));

    const result = await callChatCompletion([], {
      responseFormat, purpose: 'initial', returnMessage: true,
    });

    expect(result).toMatchObject({ unavailable: true, unavailableReason: 'rate_limit' });
    expect(result.content).toContain('No pude completar esa acción');
    expect(result.content.toLowerCase()).not.toMatch(/groq|openrouter|baseten|proveedor|modelo/);
  });

  it('keeps typed metadata when no raw provider error is supplied', async () => {
    await foregroundFailure({ error: {
      message: 'Provider returned error', code: 400,
      metadata: { provider_name: 'Groq', error_type: 'invalid_request', provider_code: 'invalid_parameter' },
    } });
    expect(failureDetail()).toMatchObject({ observedProvider: 'Groq', errorType: 'invalid_request', errorCode: 'invalid_parameter' });
  });

  it('keeps typed diagnostics and excludes freeform text, configured keys and unrelated payload fields', async () => {
    const body = wrapper(JSON.stringify({ error: {
      message: `Diagnostic ${process.env.OPENROUTER_API_KEY}\n${'x'.repeat(4000)}`,
      type: 'invalid_request_error',
      failed_generation: 'PRIVATE_GENERATION', request: { messages: ['PRIVATE_PROMPT'] },
      headers: { Authorization: 'OTHER_PRIVATE_CREDENTIAL' },
    } }));
    body.error.metadata.headers = { Authorization: 'PRIVATE_METADATA_HEADER' };
    await foregroundFailure(body);
    const detail = failureDetail();
    expect(detail.errorType).toBe('invalid_request_error');
    expect(detail).not.toHaveProperty('message');
    for (const privateValue of [process.env.OPENROUTER_API_KEY, 'PRIVATE_GENERATION', 'PRIVATE_PROMPT', 'OTHER_PRIVATE_CREDENTIAL', 'PRIVATE_METADATA_HEADER']) {
      expect(JSON.stringify(detail)).not.toContain(privateValue);
    }
  });

  it('handles non-JSON HTTP errors without changing the fallback result', async () => {
    await foregroundFailure('Bad request\nfrom upstream');
    expect(failureDetail()).toMatchObject({ status: 400, errorCode: null });
    expect(JSON.stringify(failureDetail())).not.toContain('Bad request');
  });

  it.each([
    [429, { code: 429, metadata: { provider_name: 'Groq' } }, 'upstream', 'rate_limit'],
    [429, { code: 429, metadata: { provider_name: 'OpenRouter' } }, 'openrouter_platform', 'rate_limit'],
    [429, { code: 429 }, 'uncertain', 'rate_limit'],
    [200, { code: 429, metadata: { provider_name: 'Groq' } }, 'upstream', 'provider_error'],
  ])('adds rate-limit diagnostics without changing control or attempt counts: %j %j', async (status, error, source, reason) => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({ error }), { status, headers: {
        'Retry-After': '42', 'X-RateLimit-Limit': '100', 'X-RateLimit-Remaining': '0', 'X-RateLimit-Reset': '1900000000',
      } }))
      .mockResolvedValueOnce(success());
    const result = await callChatCompletion([], { responseFormat, purpose: 'initial', returnMessage: true });
    expect(result.routeStage).toBe('secondary');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const line = vi.mocked(console.warn).mock.calls.find(([line]) => line.includes(' metadata='))![0];
    const event = JSON.parse(line.split(' metadata=')[1]);
    expect(event).toMatchObject({ status, reason, failureClass: 'rate_limit', rateLimitSource: source,
      retryAfterSeconds: 42, rateLimitLimit: 100, rateLimitRemaining: 0, rateLimitReset: 1900000000 });
    expect(vi.mocked(console.log).mock.calls.flat().join('\n')).toContain(`trigger=${reason}`);
    expect(fetchMock.mock.calls.map(([, init]) => JSON.parse(init!.body as string).provider.only)).toEqual([['groq'], ['cerebras/fp16']]);
  });

  it('never logs malicious freeform provider fields, exception text or correlation headers', async () => {
    const privateText = 'PRIVATE_USER sk-or-diagnostic-test-secret private@example.test';
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockRejectedValueOnce(Object.assign(new Error(privateText), { name: 'PRIVATE_EXCEPTION' }))
      .mockResolvedValueOnce(response({ error: { message: privateText, code: privateText, type: privateText,
        param: privateText, metadata: { provider_name: 'PRIVATE_PROJECT', raw: JSON.stringify({ error: { message: privateText, type: privateText } }),
          headers: { 'X-Request-ID': privateText } } } }, 429))
      .mockResolvedValueOnce(success());
    await callChatCompletion([], { responseFormat, returnMessage: true, purpose: 'initial', correlationId: 'PRIVATE_CORRELATION' });
    const logs = [...vi.mocked(console.warn).mock.calls, ...vi.mocked(console.log).mock.calls].flat().join('\n');
    for (const marker of ['PRIVATE_USER', 'sk-or-diagnostic-test-secret', 'private@example.test', 'PRIVATE_PROJECT', 'PRIVATE_EXCEPTION', 'PRIVATE_CORRELATION']) expect(logs).not.toContain(marker);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    const events = vi.mocked(console.warn).mock.calls.filter(([line]) => line.includes(' metadata=')).map(([line]) => JSON.parse(line.split(' metadata=')[1]));
    expect(events[0]).toMatchObject({ reason: 'network_error', exceptionClass: null, parseValidationMs: null, status: null });
    expect(events[1]).toMatchObject({ rateLimitSource: 'uncertain', errorCode: null, errorType: null, errorParam: null, observedProvider: null });
  });

  it('keeps all wire measurements unknown when local serialization fails', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(() => { throw new Error('unexpected fetch'); });
    const messages = [{ role: 'user', content: 'PRIVATE_PROMPT', toJSON() { throw new Error('PRIVATE_SERIALIZATION'); } }];
    vi.spyOn(performance, 'now').mockReturnValueOnce(10).mockReturnValueOnce(15);
    const result = await callChatCompletion(messages, { responseFormat, returnMessage: true, purpose: 'next_best_action' });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(result).toMatchObject({ unavailable: true, unavailableReason: 'network_error', attemptDiagnostics: {
      requestBytes: null, messagesBytes: null, schemaBytes: null, responseFormatBytes: null, messageCount: null,
      preparationMs: 5, fetchMs: null, parseValidationMs: null, exceptionClass: 'Error',
    } });
    expect(vi.mocked(console.warn).mock.calls.flat().join('\n')).not.toContain('PRIVATE_');
  });

  it('measures deterministic parse-validation failure phases without moving the timeout boundary', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(success());
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    const clock = vi.spyOn(performance, 'now');
    [10, 12, 13, 20, 21, 28].forEach(value => clock.mockReturnValueOnce(value));
    const result = await callChatCompletion([], { responseFormat, returnMessage: true, purpose: 'next_best_action',
      validateStructuredContent: () => ({ valid: false, errorCode: 'INVALID_PARAMETERS', error: 'PRIVATE_VALIDATION' }) });
    expect(result.attemptDiagnostics).toMatchObject({ preparationMs: 2, fetchMs: 7, parseValidationMs: 7,
      validationCode: 'INVALID_PARAMETERS', status: 200, reason: 'invalid_structured_output' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(timeout).toHaveBeenCalledExactlyOnceWith(2000);
    expect(vi.mocked(console.warn).mock.calls.flat().join('\n')).not.toContain('PRIVATE_VALIDATION');
  });

  it('retains nullable parse timing and typed timeout on a rejected fetch', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(Object.assign(new Error('PRIVATE_TIMEOUT'), { name: 'TimeoutError' }));
    const result = await callChatCompletion([], { responseFormat, returnMessage: true, purpose: 'next_best_action' });
    expect(result.attemptDiagnostics).toMatchObject({ reason: 'timeout', exceptionClass: 'TimeoutError', parseValidationMs: null,
      status: null, promptTokens: null, completionTokens: null, reasoningTokens: null, cachedTokens: null });
    expect(result.attemptDiagnostics.fetchMs).toBeGreaterThanOrEqual(0);
    expect(result.attemptDiagnostics.requestBytes).toBeGreaterThan(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('records JSON parsing failure with typed root cause but never the malformed body', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(response('PRIVATE_INVALID_JSON'));
    const result = await callChatCompletion([], { responseFormat, returnMessage: true, purpose: 'next_best_action' });
    expect(result.attemptDiagnostics).toMatchObject({ reason: 'invalid_response_json', exceptionClass: 'SyntaxError', status: 200 });
    expect(result.attemptDiagnostics.parseValidationMs).toBeGreaterThanOrEqual(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(vi.mocked(console.warn).mock.calls.flat().join('\n')).not.toContain('PRIVATE_INVALID_JSON');
  });

  it('sanitizes background memory error logging while keeping request format unchanged', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(response(wrapper(JSON.stringify({ error: { message: 'Nested memory diagnostic' } })), 400))
      .mockResolvedValueOnce(success('{"memories":[]}'));
    const result = await callMemoryExtraction([{ role: 'user', content: 'context' }]);
    expect(result).toBe('{"memories":[]}');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(failureDetail()).toMatchObject({ observedProvider: 'Groq', status: 400 });
    expect(JSON.stringify(failureDetail())).not.toContain('Nested memory diagnostic');
    for (const [, options] of fetchMock.mock.calls) {
      const payload = JSON.parse(options!.body as string);
      expect(payload).not.toHaveProperty('response_format');
      expect(payload).not.toHaveProperty('tools');
      expect(payload).not.toHaveProperty('tool_choice');
    }
  });
});
