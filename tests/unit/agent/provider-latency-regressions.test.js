import 'dotenv/config';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { callChatCompletion } from '../../../src/agent/providers/client.js';

function toolResponse(provider = 'Baseten') {
  return new Response(JSON.stringify({
    provider,
    choices: [{
      finish_reason: 'tool_calls',
      message: {
        content: null,
        tool_calls: [{
          id: 'turn-1',
          type: 'function',
          function: {
            name: 'execute_turn',
            arguments: '{"actions":[{"domain":"conversation","action":"reply","content":"¡Hola!"}]}',
          },
        }],
      },
    }],
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

  it('does not retry the same foreground provider after finish_reason=error and immediately tries the independent fallback', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(finishError('Groq'))
      .mockResolvedValueOnce(toolResponse('Baseten'));

    const result = await callChatCompletion([{ role: 'user', content: 'Hola hola' }], {
      tools: [{ type: 'function', function: { name: 'execute_turn', parameters: { type: 'object' } } }],
      toolChoice: 'required',
      returnMessage: true,
      purpose: 'initial',
    });

    expect(result.tool_calls).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const payloads = fetchMock.mock.calls.map(([, options]) => JSON.parse(options.body));
    expect(payloads[0].provider.only).toEqual(['groq']);
    expect(payloads[1].provider.only).toEqual(['baseten/fp8']);
  });

  it('uses auto only for the Baseten fallback while still requiring execute_turn at the Hermes protocol boundary', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response('primary unavailable', { status: 503 }))
      .mockResolvedValueOnce(toolResponse('Baseten'));

    const result = await callChatCompletion([{ role: 'user', content: 'Hola hola' }], {
      tools: [{ type: 'function', function: { name: 'execute_turn', parameters: { type: 'object' } } }],
      toolChoice: 'required',
      returnMessage: true,
      purpose: 'initial',
    });

    expect(result.tool_calls).toHaveLength(1);
    const secondaryPayload = JSON.parse(fetchMock.mock.calls[1][1].body);
    expect(secondaryPayload.tool_choice).toBe('auto');
  });

  it('does not return to a provider that already failed after all independent foreground fallbacks are exhausted', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response('primary unavailable', { status: 503 }))
      .mockResolvedValueOnce(new Response('secondary unavailable', { status: 503 }))
      .mockResolvedValueOnce(new Response('last resort unavailable', { status: 503 }));

    const result = await callChatCompletion([{ role: 'user', content: 'Hola' }], {
      tools: [{ type: 'function', function: { name: 'execute_turn', parameters: { type: 'object' } } }],
      toolChoice: 'required',
      returnMessage: true,
      purpose: 'initial',
    });

    expect(result.unavailable).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});
