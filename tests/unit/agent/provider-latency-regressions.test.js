import 'dotenv/config';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { callChatCompletion } from '../../../src/agent/providers/client.js';

function structuredResponse(provider = 'Groq') {
  return new Response(JSON.stringify({ provider, choices: [{ finish_reason: 'stop', message: { content: '{\"actions\":[{\"domain\":\"conversation\",\"action\":\"reply\",\"content\":\"¡Hola!\"}]}' } }], usage: { prompt_tokens: 1200, completion_tokens: 30 } }), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

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

  it('sends strict structured output to Groq without tools', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(structuredResponse('Groq'));
    const responseFormat = { type: 'json_schema', json_schema: { name: 'turn', strict: true, schema: { type: 'object', additionalProperties: false, properties: { actions: { type: 'array', items: { type: 'object' } } }, required: ['actions'] } } };
    const result = await callChatCompletion([{ role: 'user', content: 'Hola hola' }], { tools: null, toolChoice: 'none', responseFormat, returnMessage: true, purpose: 'initial' });
    expect(result.content).toContain('actions');
    const payload = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(payload.provider.only).toEqual(['groq']);
    expect(payload.response_format).toEqual(responseFormat);
    expect(payload).not.toHaveProperty('tools');
    expect(payload).not.toHaveProperty('tool_choice');
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
});
