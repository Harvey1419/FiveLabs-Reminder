import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { callChatCompletion, callMemoryExtraction } from '../../../src/agent/providers/client.js';

const intent = { actions: [{ domain: 'conversation', action: 'reply', content: 'Hola.' }] };
const options = { returnMessage: true, purpose: 'initial', responseFormat: { type: 'json_schema', json_schema: { name: 'test', strict: true, schema: { type: 'object', properties: {}, additionalProperties: false, required: [] } } } };
const envelope = (content = JSON.stringify(intent), finish = 'stop') => ({ id: 'gen-test', provider: 'Groq', choices: [{ finish_reason: finish, message: { content } }] });
const response = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const warning = () => console.warn.mock.calls.map((args) => args.join(' ')).join('\n');

beforeEach(() => {
  vi.stubEnv('OPENROUTER_API_KEY', 'sk-or-protocol-secret');
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

describe('foreground provider protocol, not HTTP status alone', () => {
  it.each([
    [{ id: 'gen-error', error: { code: 400, message: 'generation failed', metadata: { error_type: 'max_tokens_exceeded' } } }, 'provider_error'],
    [{ ...envelope(), error: { message: 'top-level failure overrides content' } }, 'provider_error'],
    [{ choices: [{ ...envelope().choices[0], error: { message: 'choice-level failure' } }] }, 'provider_error'],
    [{}, 'invalid_response_envelope'], [null, 'invalid_response_envelope'], [[], 'invalid_response_envelope'],
    [{ choices: [] }, 'invalid_response_envelope'],
    [{ choices: [{ message: { content: '' } }] }, 'missing_finish_reason'],
    [{ choices: [{ finish_reason: 'stop' }] }, 'invalid_response_message'],
    [envelope(123), 'invalid_response_content'],
    [envelope([{ type: 'image_url', image_url: 'not text' }]), 'invalid_response_content'],
    [envelope(JSON.stringify(intent), 'length'), 'truncated_structured_output'],
    [envelope('{"actions":[', 'length'), 'truncated_structured_output'],
    [envelope('', 'length'), 'truncated_structured_output'],
    [envelope('', 'error'), 'provider_finish_error'],
    [envelope(JSON.stringify(intent), 'unknown'), 'unexpected_finish_reason'],
  ])('classifies %j as %s and skips the identical Groq retry', async (body, reason) => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(response(body)).mockResolvedValueOnce(response({ ...envelope(), provider: 'BaseTen' }));
    const result = await callChatCompletion([{ role: 'user', content: 'Hola' }], options);
    expect(result.routeStage).toBe('secondary');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(warning()).toContain(`reason=${reason}`);
    expect(warning()).not.toContain('reason=empty_content');
    expect(warning()).not.toContain('retry purpose=initial');
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).provider.only).toEqual(['groq']);
  });

  it('treats a non-JSON HTTP-200 body as protocol failure rather than a network exception', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response('<html>bad gateway</html>')).mockResolvedValueOnce(response(envelope()));
    await callChatCompletion([], options);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(warning()).toContain('reason=invalid_response_json');
    expect(warning()).not.toContain('reason=network_error');
  });

  it('retains the bounded retry only for a genuine complete-but-empty message', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(response(envelope(''))).mockResolvedValueOnce(response(envelope()));
    const result = await callChatCompletion([], options);
    expect(result.routeStage).toBe('primary');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(warning()).toContain('reason=empty_content');
    expect(warning()).toContain('retry purpose=initial');
  });

  it.each([
    [{ ...envelope(), choices: [{ finish_reason: 'stop', message: { content: '', refusal: 'not allowed' } }] }, 200],
    [envelope(JSON.stringify(intent), 'content_filter'), 200],
    [envelope([{ type: 'refusal', refusal: 'not allowed' }]), 200],
    [{ error: { metadata: { error_type: 'content_policy_violation' } } }, 200],
    [{ error: { metadata: { error_type: 'refusal' } } }, 403],
    [{ error: { metadata: { raw: JSON.stringify({ error: { code: 'content_policy_violation' } }) } } }, 400],
  ])('stops on an explicit refusal without evading it through another provider', async (body, status) => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(response(body, status));
    const result = await callChatCompletion([], options);
    expect(result.unavailable).toBe(true);
    expect(result.refused).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(warning()).toContain('stopped reason=provider_refusal');
  });

  it('logs metadata and usage without leaking content, reasoning, request payloads or credentials', async () => {
    const body = {
      ...envelope('PRIVATE_CONTENT'), model: 'openai/gpt-oss-120b',
      error: { code: 400, metadata: { error_type: 'invalid_request', raw: JSON.stringify({ error: { message: 'Failed sk-or-protocol-secret', failed_generation: 'PRIVATE_GENERATION' } }) } },
      usage: { prompt_tokens: 100, completion_tokens: 1400, completion_tokens_details: { reasoning_tokens: 1390 } },
      request: { messages: ['PRIVATE_PROMPT'] }, reasoning: 'PRIVATE_REASONING',
    };
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(response(body)).mockResolvedValueOnce(response(envelope()));
    await callChatCompletion([], options);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(warning()).toContain('gen-test');
    expect(warning()).toContain('"reasoningTokens":1390');
    expect(warning()).toContain('[REDACTED]');
    for (const secret of ['PRIVATE_CONTENT', 'PRIVATE_GENERATION', 'PRIVATE_PROMPT', 'PRIVATE_REASONING', 'sk-or-protocol-secret']) expect(warning()).not.toContain(secret);
  });

  it('redacts the configured key from thrown foreground transport errors as well', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(new Error('network sk-or-protocol-secret')).mockResolvedValueOnce(response(envelope()));
    await callChatCompletion([], options);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(warning()).toContain('[REDACTED]');
    expect(warning()).not.toContain('sk-or-protocol-secret');
  });

  it('does not impose the foreground finish contract on background memory', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(response(envelope('<think>hidden</think>{"memories":[]}', null)));
    expect(await callMemoryExtraction([])).toBe('{"memories":[]}');
  });

  it('fails over instead of accepting truncated background memory JSON', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(response(envelope('[{"topicKey":"profile/work"', 'length')))
      .mockResolvedValueOnce(response({
        ...envelope('[{"topicKey":"profile/work","category":"fact"}]'),
        provider: 'BaseTen',
      }));

    expect(await callMemoryExtraction([])).toBe('[{"topicKey":"profile/work","category":"fact"}]');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).provider.only).toEqual(['groq']);
    expect(JSON.parse(fetchMock.mock.calls[1][1].body).provider.only).toEqual(['baseten/fp8']);
    expect(warning()).toContain('reason=truncated_memory_output');
    expect(console.log.mock.calls.flat().join('\n')).toContain('trigger=truncated_memory_output');
  });
});
