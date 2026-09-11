import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { callChatCompletion, callMemoryExtraction } from '../../../src/agent/providers/client.js';

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

function response(content, status = 200) {
  return new Response(typeof content === 'string' ? content : JSON.stringify(content), {
    status, headers: { 'Content-Type': 'application/json' },
  });
}

function success(content = JSON.stringify(reply)) {
  return response({ provider: 'BaseTen', choices: [{ finish_reason: 'stop', message: { content } }] });
}

function wrapper(raw) {
  return { error: { message: 'Provider returned error', code: 400, metadata: { provider_name: 'Groq', raw } } };
}

function failureDetail() {
  const line = console.warn.mock.calls.map(([text]) => text).find((text) => text.includes('status=400'));
  expect(line).toBeDefined();
  return line.split(' detail="')[1].slice(0, -1);
}

async function foregroundFailure(body) {
  const fetchMock = vi.spyOn(globalThis, 'fetch')
    .mockResolvedValueOnce(response(body, 400))
    .mockResolvedValueOnce(success());
  const result = await callChatCompletion([{ role: 'user', content: 'Hola hola' }], {
    responseFormat, purpose: 'initial', returnMessage: true,
  });
  expect(fetchMock).toHaveBeenCalledTimes(2);
  expect(JSON.parse(result.content)).toEqual(reply);
  const payloads = fetchMock.mock.calls.map(([, options]) => JSON.parse(options.body));
  expect(payloads[0].model).toBe('openai/gpt-oss-120b');
  expect(payloads[0].provider).toEqual({
    order: ['groq'], only: ['groq'], allow_fallbacks: false, require_parameters: true,
  });
  expect(payloads[1].provider.only).toEqual(['baseten/fp8']);
  for (const payload of payloads) {
    expect(payload.response_format).toEqual(responseFormat);
    expect(payload.response_format.json_schema.strict).toBe(true);
    expect(payload).not.toHaveProperty('tools');
    expect(payload).not.toHaveProperty('tool_choice');
  }
}

describe('strict foreground provider error diagnostics', () => {
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
    expect(JSON.parse(failureDetail())).toEqual({
      provider: 'Groq', type: 'invalid_request_error', code: 'invalid_json_schema',
      param: 'response_format', message: raw.error.message,
    });
  });

  it('keeps a plain-text nested provider error without treating it as a TurnIntent', async () => {
    await foregroundFailure(wrapper('Provider parameter rejected.'));
    expect(JSON.parse(failureDetail()).message).toBe('Provider parameter rejected.');
  });

  it('classifies provider schema compilation failures separately from availability', async () => {
    await foregroundFailure(wrapper({ error: {
      message: 'The specified schema produces a constraint that has too many states for serving.',
      type: 'invalid_request_error', code: '400',
    } }));
    expect(console.warn.mock.calls.flat().join('\n')).toContain('reason=schema_rejection');
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
    const payloads = fetchMock.mock.calls.map(([, init]) => JSON.parse(init.body));
    expect(payloads.map((payload) => payload.provider.only)).toEqual([
      ['groq'], ['baseten/fp8'], ['openai'],
    ]);
    expect(payloads.every((payload) => payload.response_format.json_schema.strict === true)).toBe(true);
    const logs = [...console.warn.mock.calls, ...console.log.mock.calls].flat().join('\n');
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
    expect(console.warn.mock.calls.flat().join('\n')).toContain('reason=invalid_structured_output');
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
    expect(JSON.parse(failureDetail())).toEqual({
      provider: 'Groq', type: 'invalid_request', code: 'invalid_parameter', message: 'Provider returned error',
    });
  });

  it('bounds diagnostic fields, redacts the configured key and never dumps unrelated payload fields', async () => {
    const body = wrapper(JSON.stringify({ error: {
      message: `Diagnostic ${process.env.OPENROUTER_API_KEY}\n${'x'.repeat(4000)}`,
      type: 'invalid_request_error',
      failed_generation: 'PRIVATE_GENERATION', request: { messages: ['PRIVATE_PROMPT'] },
      headers: { Authorization: 'OTHER_PRIVATE_CREDENTIAL' },
    } }));
    body.error.metadata.headers = { Authorization: 'PRIVATE_METADATA_HEADER' };
    await foregroundFailure(body);
    const detail = failureDetail();
    const parsed = JSON.parse(detail);
    expect(parsed.message).toContain('[REDACTED]');
    expect(parsed.message.length).toBeLessThanOrEqual(800);
    expect(detail.length).toBeLessThanOrEqual(1600);
    expect(detail).not.toContain('\n');
    for (const privateValue of [process.env.OPENROUTER_API_KEY, 'PRIVATE_GENERATION', 'PRIVATE_PROMPT', 'OTHER_PRIVATE_CREDENTIAL', 'PRIVATE_METADATA_HEADER']) {
      expect(detail).not.toContain(privateValue);
    }
  });

  it('handles non-JSON HTTP errors without changing the fallback result', async () => {
    await foregroundFailure('Bad request\nfrom upstream');
    expect(failureDetail()).toBe('Bad request from upstream');
  });

  it('leaves background memory error logging and request format unchanged', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(response(wrapper(JSON.stringify({ error: { message: 'Nested memory diagnostic' } })), 400))
      .mockResolvedValueOnce(success('{"memories":[]}'));
    const result = await callMemoryExtraction([{ role: 'user', content: 'context' }]);
    expect(result).toBe('{"memories":[]}');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(failureDetail()).toBe('Provider returned error');
    for (const [, options] of fetchMock.mock.calls) {
      const payload = JSON.parse(options.body);
      expect(payload).not.toHaveProperty('response_format');
      expect(payload).not.toHaveProperty('tools');
      expect(payload).not.toHaveProperty('tool_choice');
    }
  });
});
