import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { callChatCompletion, callMemoryExtraction } from '../../../src/agent/providers/client.js';

const json = { actions: [{ domain: 'conversation', action: 'reply', content: 'Hola.' }] };
const options = { purpose: 'initial', returnMessage: true, responseFormat: {
  type: 'json_schema', json_schema: { name: 'test', strict: true,
    schema: { type: 'object', properties: {}, additionalProperties: false, required: [] } },
} };
const success = () => new Response(JSON.stringify({ provider: 'Alibaba', choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(json) } }] }));
const failure = (status) => new Response(JSON.stringify({ error: { code: status, message: 'provider unavailable' } }), { status });

beforeEach(() => {
  vi.stubEnv('OPENROUTER_API_KEY', 'sk-or-capability-test');
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

describe('strict foreground endpoint eligibility', () => {
  it.each([[400, 429, 503, 'upstream_unavailable'], [429, 503, 429, 'rate_limit']])('tries every compatible strict route after %i/%i/%i', async (first, second, third, reason) => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(failure(first))
      .mockResolvedValueOnce(failure(second))
      .mockResolvedValueOnce(failure(third));
    const result = await callChatCompletion([], options);
    expect(result.unavailable).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    const payloads = fetchMock.mock.calls.map(([, init]) => JSON.parse(init.body));
    expect(payloads.map((payload) => payload.model)).toEqual([
      'openai/gpt-oss-120b', 'openai/gpt-oss-120b', 'z-ai/glm-5.3-flash',
    ]);
    expect(payloads.map((payload) => payload.provider.only)).toEqual([
      ['groq'], ['cerebras/fp16'], ['baseten/fp8'],
    ]);
    for (const payload of payloads) {
      expect(payload.response_format).toEqual(options.responseFormat);
      expect(payload.provider.require_parameters).toBe(true);
      expect(payload).not.toHaveProperty('tools');
      expect(payload).not.toHaveProperty('tool_choice');
    }
    const warnings = console.warn.mock.calls.flat().join('\n');
    expect(warnings).not.toContain('unsupported_structured_outputs');
    expect(warnings).toContain(`exhausted reason=${reason}`);
  });

  it('starts directly at the independent compatible strict fallback when requested', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(failure(503));
    const result = await callChatCompletion([], { ...options, startStage: 'last_resort' });
    expect(result.unavailable).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const payload = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(payload.model).toBe('z-ai/glm-5.3-flash');
    expect(payload.provider.only).toEqual(['baseten/fp8']);
    expect(payload.response_format).toEqual(options.responseFormat);
  });

  it('preserves the configured Alibaba route for non-schema JSON responses', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(success());
    const result = await callChatCompletion([], { returnMessage: true, startStage: 'last_resort' });
    expect(result.routeStage).toBe('last_resort');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).response_format).toEqual({ type: 'json_object' });
  });

  it('does not remove or alter background memory last-resort routing', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(failure(503)).mockResolvedValueOnce(failure(503)).mockResolvedValueOnce(success());
    expect(await callMemoryExtraction([])).toBe(JSON.stringify(json));
    expect(fetchMock).toHaveBeenCalledTimes(3);
    const payload = JSON.parse(fetchMock.mock.calls[2][1].body);
    expect(payload.model).toBe('qwen/qwen3.7-flash');
    expect(payload.provider.only).toEqual(['alibaba']);
    expect(payload).not.toHaveProperty('response_format');
  });
});
