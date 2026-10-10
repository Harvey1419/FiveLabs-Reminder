import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { callChatCompletion, callMemoryExtraction } from '../../../src/agent/providers/client.js';

const replyIntent = { actions: [{ domain: 'conversation', action: 'reply', content: '¡Hola!' }] };
const responseFormat = {
  type: 'json_schema',
  json_schema: {
    name: 'hermes_turn_intent',
    strict: true,
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        actions: {
          type: 'array', minItems: 1, maxItems: 12,
          items: {
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

// Exercise the production pure normalizer without importing the router's DB,
// integration and tool graph. The boundary fails loudly if the function moves.
const routerSource = readFileSync(new URL('../../../src/agent/orchestration/router-core.js', import.meta.url), 'utf8');
const normalizerSource = routerSource.match(/function normalizeModelResponse\(modelResponse\) \{[\s\S]*?\n\}\n\nfunction collectIntent/);
if (!normalizerSource) throw new Error('Router normalization boundary not found');
const normalizeModelResponse = runInNewContext(`(${normalizerSource[0].replace(/\n\nfunction collectIntent$/, '')})`);

function successEvents() {
  return console.log.mock.calls
    .map(([line]) => line)
    .filter(line => typeof line === 'string' && line.includes(' outcome=success ') && line.includes(' metadata='))
    .map(line => JSON.parse(line.slice(line.indexOf(' metadata=') + ' metadata='.length)));
}

function structuredResponse(provider = 'Groq', intent = replyIntent) {
  return new Response(JSON.stringify({
    provider,
    choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(intent) } }],
    usage: { prompt_tokens: 1200, completion_tokens: 30 },
  }), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

function finishError(provider = 'Groq') {
  return new Response(JSON.stringify({
    provider,
    choices: [{
      finish_reason: 'error',
      native_finish_reason: 'error',
      message: { content: '' },
      error: { message: 'provider generation error' },
    }],
  }), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

function expectStructuredPayload(payload, providers) {
  expect(payload.response_format).toEqual(responseFormat);
  expect(payload.response_format.type).toBe('json_schema');
  expect(payload.response_format.json_schema.strict).toBe(true);
  expect(payload.provider).toEqual({
    order: providers, only: providers, allow_fallbacks: false, require_parameters: true,
  });
  expect(payload).not.toHaveProperty('tools');
  expect(payload).not.toHaveProperty('tool_choice');
}

describe('foreground provider latency policy', () => {
  const originalKey = process.env.OPENROUTER_API_KEY;

  beforeEach(() => {
    process.env.OPENROUTER_API_KEY = 'sk-or-test';
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (originalKey === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = originalKey;
  });

  it('keeps the exact live acceptance counter compatible with one success line and excludes memory and failures', async () => {
    const requestId = '12345678-1234-1234-1234-123456789abc';
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(finishError())
      .mockResolvedValueOnce(structuredResponse('Baseten'))
      .mockResolvedValueOnce(structuredResponse('Groq'));
    await callChatCompletion([], { responseFormat, returnMessage: true, purpose: 'initial', correlationId: requestId });
    // Copy the unchanged acceptance consumer's predicate, not a new JSON predicate.
    const countAcceptedInitial = () => console.log.mock.calls
      .map(args => args.join(' '))
      .filter(line => line.includes('attempt purpose=initial') && line.includes('outcome=success')).length;
    expect(countAcceptedInitial()).toBe(1);
    const initialLines = console.log.mock.calls.map(([line]) => line);
    expect(initialLines).toHaveLength(2); // One route transition and one success, not duplicate success logs.
    const successLine = initialLines.find(line => line.includes('outcome=success'));
    expect(successLine).toContain(`[ai-client req=${requestId}] attempt purpose=initial stage=secondary model=openai/gpt-oss-120b provider=Baseten outcome=success finishReason=stop toolCalls=0 promptTokens=1200 completionTokens=30 latencyMs=`);
    const failures = console.warn.mock.calls.map(args => args.join(' '));
    expect(failures.some(line => line.includes('attempt purpose=initial') && line.includes('outcome=failed'))).toBe(true);
    expect(failures.some(line => line.includes('outcome=success'))).toBe(false);
    await callMemoryExtraction([]);
    expect(countAcceptedInitial()).toBe(1);
    expect(successEvents()).toHaveLength(2);
    expect(console.log.mock.calls.at(-1)[0]).toContain('[ai-memory] attempt purpose=memory');
    expect(successEvents()[1].requestId).toBeNull();
  });

  it('retains correlated generation and cache/reasoning usage through router normalization', async () => {
    const usage = { prompt_tokens: 1200, completion_tokens: 80,
      prompt_tokens_details: { cached_tokens: 900 },
      completion_tokens_details: { reasoning_tokens: 50 } };
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response(JSON.stringify({
      id: 'gen-test-1', provider: 'Groq', model: 'openai/gpt-oss-120b', usage,
      choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(replyIntent) } }],
    })));
    const result = await callChatCompletion([{ role: 'user', content: 'private prompt marker' }], {
      responseFormat, returnMessage: true, correlationId: '12345678-1234-1234-1234-123456789abc', purpose: 'initial',
    });
    expect(result.generationId).toBe('gen-test-1');
    expect(result.usage).toEqual({ promptTokens: 1200, completionTokens: 80, reasoningTokens: 50, cachedTokens: 900 });
    const normalized = normalizeModelResponse(result);
    expect(normalized.usage).toBe(result.usage);
    expect(normalized).toMatchObject({ generationId: 'gen-test-1', model: result.model, provider: 'Groq', routeStage: 'primary' });
    expect(normalized.content).toBe(result.content);
    expect(normalized.toolCalls).toEqual([]);
    expect(successEvents()).toEqual([expect.objectContaining({
      outcome: 'success', requestId: '12345678-1234-1234-1234-123456789abc', generationId: 'gen-test-1',
      promptTokens: 1200, completionTokens: 80, reasoningTokens: 50, cachedTokens: 900,
      purpose: 'initial', stage: 'primary', model: 'openai/gpt-oss-120b', provider: 'Groq',
    })]);
    // Completion already includes reasoning: do not report 80 + 50.
    expect(successEvents()[0].completionTokens).toBe(80);
    const logs = JSON.stringify(console.log.mock.calls);
    expect(logs).not.toContain('private prompt marker');
    expect(logs).not.toContain(JSON.stringify(replyIntent));
    expect(logs).not.toContain('sk-or-test');
  });

  it('retains metadata on a nonstructured fallback without changing tool-call normalization', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(finishError())
      .mockResolvedValueOnce(new Response(JSON.stringify({
        id: 'gen-fallback', provider: 'Baseten', usage: { prompt_tokens: 0, completion_tokens: 5,
          prompt_tokens_details: { cached_tokens: 0 }, completion_tokens_details: { reasoning_tokens: 0 } },
        choices: [{ finish_reason: 'tool_calls', message: { content: '', tool_calls: [{
          id: 'call-test', function: { name: 'execute_turn', arguments: '{}' },
        }] } }],
      })));
    const result = await callChatCompletion([], { tools: [{ type: 'function', function: { name: 'execute_turn' } }],
      returnMessage: true, correlationId: 'req-fallback', purpose: 'initial' });
    expect(result).toMatchObject({ generationId: 'gen-fallback', routeStage: 'secondary',
      usage: { promptTokens: 0, completionTokens: 5, cachedTokens: 0, reasoningTokens: 0 } });
    expect(normalizeModelResponse(result).toolCalls).toEqual([{ id: 'call-test', name: 'execute_turn', arguments: '{}' }]);
    expect(successEvents()).toEqual([expect.objectContaining({ generationId: 'gen-fallback', requestId: null,
      stage: 'secondary', cachedTokens: 0, reasoningTokens: 0 })]);
  });

  it.each([undefined, null, {}, { prompt_tokens: 0 }])('keeps missing usage unknown rather than zero: %j', async usage => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response(JSON.stringify({
      choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(replyIntent) } }], usage,
    })));
    const result = await callChatCompletion([], { responseFormat, returnMessage: true });
    expect(result.generationId).toBeNull();
    expect(result.usage).toEqual({ promptTokens: usage?.prompt_tokens,
      completionTokens: undefined, reasoningTokens: undefined, cachedTokens: undefined });
    expect(normalizeModelResponse(result).usage).toBe(result.usage);
    expect(successEvents()[0]).toMatchObject({ generationId: null, requestId: null,
      promptTokens: usage?.prompt_tokens ?? null, completionTokens: null, reasoningTokens: null, cachedTokens: null,
      provider: 'groq' });
    const line = console.log.mock.calls.find(([line]) => line.includes('outcome=success'))[0];
    expect(line).toContain(`promptTokens=${usage?.prompt_tokens ?? 'unknown'} completionTokens=unknown`);
    expect(line).toContain('toolCalls=0');
  });

  it('bounds success telemetry and excludes credential/freeform metadata and invalid counters', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response(JSON.stringify({
      id: 'gen-sk-or-test', provider: 'private@example.test', model: 'x'.repeat(200),
      usage: { prompt_tokens: 'raw private marker', completion_tokens: -1,
        prompt_tokens_details: { cached_tokens: 'sk-or-test' }, completion_tokens_details: { reasoning_tokens: 1.5 } },
      choices: [{ finish_reason: 'stop', message: { content: 'raw private output marker' } }],
    })));
    const result = await callChatCompletion([{ role: 'user', content: 'raw private input marker' }], {
      returnMessage: true, correlationId: 'unsafe\nrequest marker', purpose: 'initial',
    });
    expect(result.content).toBe('raw private output marker');
    // Returned provider metadata is not rewritten just to sanitize logging.
    expect(result.usage.promptTokens).toBe('raw private marker');
    const [event] = successEvents();
    expect(event).toMatchObject({ generationId: null, provider: null, requestId: null,
      model: 'openai/gpt-oss-120b', promptTokens: null, completionTokens: null, reasoningTokens: null, cachedTokens: null });
    const logs = JSON.stringify(console.log.mock.calls);
    for (const secret of ['sk-or-test', 'raw private', 'private@example.test', 'request marker']) expect(logs).not.toContain(secret);
    // The same bounded event now includes byte counts, phases and nullable rate-limit fields.
    expect(logs.length).toBeLessThan(1800);
  });

  it.each(['15550001234', 'Synthetic Person', 'Synthetic-Person', undefined])('omits freeform header correlation from the entire success line: %j', async correlationId => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(structuredResponse());
    await callChatCompletion([], { responseFormat, returnMessage: true, correlationId, purpose: 'initial' });
    expect(successEvents()).toHaveLength(1);
    expect(successEvents()[0].requestId).toBeNull();
    const lines = console.log.mock.calls.map(([line]) => line);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('[ai-client] attempt purpose=initial');
    expect(lines[0]).not.toContain(' req=');
    if (correlationId) expect(lines[0]).not.toContain(correlationId);
    expect(lines[0].length).toBeLessThan(1800);
  });

  it('logs background memory usage with no invented foreground ownership and keeps string returns', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response(JSON.stringify({
      id: 'gen-memory', provider: 'Groq', usage: { prompt_tokens: 100, completion_tokens: 20,
        prompt_tokens_details: { cached_tokens: 60 }, completion_tokens_details: { reasoning_tokens: 10 } },
      choices: [{ finish_reason: 'stop', message: { content: '<think>private reasoning</think>{"memories":[]}' } }],
    })));
    expect(await callMemoryExtraction([{ role: 'user', content: 'private memory input' }])).toBe('{"memories":[]}');
    expect(successEvents()).toEqual([expect.objectContaining({ requestId: null, generationId: 'gen-memory',
      purpose: 'memory', stage: 'memory_primary', promptTokens: 100, completionTokens: 20, reasoningTokens: 10, cachedTokens: 60 })]);
    const logs = JSON.stringify(console.log.mock.calls);
    expect(logs).not.toContain('private');
    expect(logs).not.toContain('memories');
  });

  it('keeps unavailable and legacy normalization free of invented usage', () => {
    const unavailable = normalizeModelResponse({ content: 'unavailable', unavailable: true, unavailableReason: 'timeout' });
    expect(unavailable).toMatchObject({ unavailable: true, unavailableReason: 'timeout', toolCalls: [] });
    expect(unavailable).not.toHaveProperty('usage');
    expect(unavailable).not.toHaveProperty('generationId');
    for (const input of [null, undefined, ' legacy text ', []]) {
      const normalized = normalizeModelResponse(input);
      expect(normalized).not.toHaveProperty('usage');
      expect(normalized).not.toHaveProperty('generationId');
      expect(normalized.toolCalls).toEqual([]);
    }
    expect(normalizeModelResponse(' legacy text ').content).toBe('legacy text');
  });

  it('sends strict structured output to Groq without tools', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(structuredResponse('Groq'));
    const result = await callChatCompletion([{ role: 'user', content: 'Hola hola' }], {
      responseFormat, returnMessage: true, purpose: 'initial',
    });

    expect(JSON.parse(result.content)).toEqual(replyIntent);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const payload = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(payload.model).toBe('openai/gpt-oss-120b');
    expectStructuredPayload(payload, ['groq']);
  });

  it('measures the exact fetch body and exposes reached phases on success', async () => {
    const messages = [{ role: 'system', content: 'context é😀' }, { role: 'user', content: 'history 日本語' }];
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(structuredResponse());
    const result = await callChatCompletion(messages, { responseFormat, returnMessage: true, purpose: 'initial' });
    const body = fetchMock.mock.calls[0][1].body;
    const wire = JSON.parse(body);
    expect(result.attemptDiagnostics).toMatchObject({ requestBytes: Buffer.byteLength(body, 'utf8'),
      messagesBytes: Buffer.byteLength(JSON.stringify(wire.messages), 'utf8'), messageCount: 2,
      schemaBytes: Buffer.byteLength(JSON.stringify(wire.response_format.json_schema.schema), 'utf8'),
      responseFormatBytes: Buffer.byteLength(JSON.stringify(wire.response_format), 'utf8') });
    for (const key of ['preparationMs', 'fetchMs', 'parseValidationMs']) expect(result.attemptDiagnostics[key]).toBeGreaterThanOrEqual(0);
    expect(successEvents()[0]).toMatchObject(result.attemptDiagnostics);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('measures component bytes from the wire without invoking message serialization twice', async () => {
    const toJSON = vi.fn(() => ({ role: 'system', content: 'actual wire é😀' }));
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(structuredResponse());
    const result = await callChatCompletion([{ toJSON }], { responseFormat, returnMessage: true });
    expect(toJSON).toHaveBeenCalledTimes(1);
    const wire = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(result.attemptDiagnostics.messagesBytes).toBe(Buffer.byteLength(JSON.stringify(wire.messages), 'utf8'));
  });

  it('does not retry the same foreground provider after finish_reason=error and immediately tries the independent fallback', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(finishError('Groq'))
      .mockResolvedValueOnce(structuredResponse('Baseten'));

    const result = await callChatCompletion([{ role: 'user', content: 'Hola hola' }], {
      responseFormat, returnMessage: true, purpose: 'initial',
    });

    expect(JSON.parse(result.content)).toEqual(replyIntent);
    expect(result.routeStage).toBe('secondary');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const payloads = fetchMock.mock.calls.map(([, options]) => JSON.parse(options.body));
    expectStructuredPayload(payloads[0], ['groq']);
    expectStructuredPayload(payloads[1], ['cerebras/fp16']);
  });

  it('keeps strict structured output on the independent fallback after a primary HTTP failure', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response('primary unavailable', { status: 503 }))
      .mockResolvedValueOnce(structuredResponse('Baseten'));

    const result = await callChatCompletion([{ role: 'user', content: 'Hola hola' }], {
      responseFormat, returnMessage: true, purpose: 'initial',
    });

    expect(JSON.parse(result.content)).toEqual(replyIntent);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const payloads = fetchMock.mock.calls.map(([, options]) => JSON.parse(options.body));
    expectStructuredPayload(payloads[0], ['groq']);
    expectStructuredPayload(payloads[1], ['cerebras/fp16']);
  });

  it('preserves literal string values inside strict JSON instead of applying prose cleanup', async () => {
    const intent = { actions: [{ domain: 'memory', action: 'save', content: 'Conservar <think>texto literal</think> y la palabra null.' }] };
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(structuredResponse('Groq', intent));

    const result = await callChatCompletion([{ role: 'user', content: 'Guarda este texto literalmente' }], {
      responseFormat, returnMessage: true, purpose: 'initial',
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.content).toBe(JSON.stringify(intent));
  });

  it('skips optional proactive advice after one failed provider attempt', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(finishError());
    const result = await callChatCompletion([], { responseFormat, returnMessage: true, purpose: 'next_best_action' });
    expect(result.unavailable).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each(['policy_compilation', 'memory_admission'])('bounds %s to two provider attempts', async purpose => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(finishError());
    const result = await callChatCompletion([], { responseFormat, returnMessage: true, purpose });
    expect(result.unavailable).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('does not migrate the background memory request or change its existing text cleanup', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response(JSON.stringify({
      provider: 'Groq',
      choices: [{ finish_reason: 'stop', message: { content: '<think>internal</think>{"memories":[]}' } }],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));

    const result = await callMemoryExtraction([{ role: 'user', content: 'contexto' }]);

    expect(result).toBe('{"memories":[]}');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const payload = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(payload).not.toHaveProperty('response_format');
    expect(payload).not.toHaveProperty('tools');
    expect(payload).not.toHaveProperty('tool_choice');
  });
});
