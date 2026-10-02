import 'dotenv/config';
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
