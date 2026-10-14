import { afterEach, describe, expect, it, vi } from 'vitest';
import { AIProviderError, HttpTranscriptionProvider, OpenRouterEmbeddingProvider, type EmbeddingProvider, type TextAIProvider } from '@templelabs/ai';
import { createConfiguredEmbeddingProvider, createConfiguredTranscriptionProvider, LEGACY_MEMORY_SPACE } from '../../../src/adapters/agent-core/configured-endpoint-providers.js';
import { MemoryEmbeddingClient, withMemoryEmbeddingScope, captureMemoryEmbeddingScope } from '../../../src/adapters/agent-core/memory-embedding-client.js';
import { synthesizeExcludedFraming } from '../../../src/adapters/agent-core/response-synthesis.js';
import { createConfiguredSynthesisAIProvider } from '../../../src/adapters/agent-core/configured-ai-provider.js';
import { buildResponseSynthesisMessages, normalizeResponseSynthesis } from '../../../src/agent/providers/client.js';
import { transcribeUserAudio } from '../../../src/adapters/agent-core/audio-transcription.js';

const instant = 100;
function request() { return { deadlineMs: 10100, signal: new AbortController().signal }; }
function transport(responses: unknown[]) { return vi.fn<typeof fetch>(async () => new Response(JSON.stringify(responses.shift()))); }
function body(fetch: ReturnType<typeof transport>, index = 0) { return JSON.parse(String(fetch.mock.calls[index]?.[1]?.body)); }
const vector = () => Array.from({ length: 768 }, () => 0.1);
function embedding(data: unknown = [{ index: 0, embedding: vector() }]) { return { model: LEGACY_MEMORY_SPACE.model, data, usage: { prompt_tokens: 10, total_tokens: 10 } }; }
function embedder(fetch: typeof globalThis.fetch) { return createConfiguredEmbeddingProvider({ apiKey: 'fixture-only', fetch, now: () => instant }); }
const audio = () => ({ bytes: new Uint8Array([1, 2, 3]), format: 'ogg' as const, language: 'es' as const });
afterEach(() => vi.useRealTimers());

describe('portable endpoint embeddings', () => {
  it('keeps scalar wire parity and the 768 dimensional memory contract', async () => {
    const fetch = transport([embedding()]);
    const result = await embedder(fetch).embed({ ...request(), input: ' Hola ', space: LEGACY_MEMORY_SPACE });
    expect(body(fetch)).toEqual({ model: LEGACY_MEMORY_SPACE.model, input: 'Hola', dimensions: 768, encoding_format: 'float' });
    expect(result).toMatchObject({ space: LEGACY_MEMORY_SPACE, usage: { inputTokens: 10 } });
    expect(result.vectors[0]).toHaveLength(768);
  });
  it('reorders a complete batch by exact unique index', async () => {
    const fetch = transport([embedding([{ index: 1, embedding: vector().map(() => 0.2) }, { index: 0, embedding: vector() }])]);
    const result = await embedder(fetch).embed({ ...request(), input: ['Uno', 'Dos'], space: LEGACY_MEMORY_SPACE });
    expect(result.vectors.map(v => v[0])).toEqual([0.1, 0.2]); expect(body(fetch).input).toEqual(['Uno', 'Dos']);
  });
  it.each([
    { data: [{ index: 0, embedding: [0.1] }] }, { data: [{ index: 1, embedding: vector() }] },
    { data: [{ index: 0, embedding: vector().map(() => '0.1') }] },
    { data: [{ index: 0, embedding: vector().map(() => null) }] },
  ])('rejects malformed embedding vectors/index %j', async ({ data }) => {
    await expect(embedder(transport([embedding(data)])).embed({ ...request(), input: 'Uno', space: LEGACY_MEMORY_SPACE })).rejects.toThrow();
  });
  it('rejects duplicate indexes even when vector count and dimensions match', async () => {
    const fetch = transport([embedding([{ index: 0, embedding: vector() }, { index: 0, embedding: vector() }])]);
    await expect(embedder(fetch).embed({ ...request(), input: ['Uno', 'Dos'], space: LEGACY_MEMORY_SPACE })).rejects.toThrow('INVALID_EMBEDDING_RESPONSE');
  });
  it('does not silently use another space or another reported model', async () => {
    const fetch = transport([{ ...embedding(), model: 'fixture/other' }]); const p = embedder(fetch);
    await expect(p.embed({ ...request(), input: 'Uno', space: { ...LEGACY_MEMORY_SPACE, id: 'other' } })).rejects.toThrow('INVALID_REQUEST');
    expect(fetch).not.toHaveBeenCalled();
    await expect(p.embed({ ...request(), input: 'Uno', space: LEGACY_MEMORY_SPACE })).rejects.toThrow('INVALID_EMBEDDING_RESPONSE');
  });
  it('never invents missing usage and retains known usage on malformed vectors', async () => {
    const { usage: _usage, ...missing } = embedding();
    await expect(embedder(transport([missing])).embed({ ...request(), input: 'Uno', space: LEGACY_MEMORY_SPACE })).rejects.toMatchObject({ code: 'UNVERIFIED_USAGE', accountingComplete: false });
    await expect(embedder(transport([embedding([])])).embed({ ...request(), input: 'Uno', space: LEGACY_MEMORY_SPACE })).rejects.toMatchObject({ usage: { inputTokens: 10, outputTokens: 0 }, accountingComplete: true });
  });
  it('reserves bounded input before transport and rejects overreported input usage', async () => {
    const fetch = transport([embedding()]); const p = embedder(fetch);
    await expect(p.embed({ ...request(), input: 'Uno', space: LEGACY_MEMORY_SPACE, maxInputTokens: 1 })).rejects.toThrow('GATEWAY_BUDGET');
    expect(fetch).not.toHaveBeenCalled();
    fetch.mockResolvedValue(new Response(JSON.stringify({ ...embedding(), usage: { prompt_tokens: 100000 } })));
    await expect(p.embed({ ...request(), input: 'Uno', space: LEGACY_MEMORY_SPACE, maxInputTokens: 1000 })).rejects.toThrow('GATEWAY_BUDGET');
  });
  it('preserves reported usage when the host deadline expires after the response', async () => {
    let clock = instant; const fetch = vi.fn<typeof globalThis.fetch>(async () => { clock = 10100; return new Response(JSON.stringify(embedding())); });
    const p = new OpenRouterEmbeddingProvider({ apiKey: 'fixture', space: LEGACY_MEMORY_SPACE, timeoutMs: 6000, fetch, now: () => clock });
    await expect(p.embed({ ...request(), input: 'Uno', space: LEGACY_MEMORY_SPACE })).rejects.toMatchObject({ code: 'GATEWAY_DEADLINE', usage: { inputTokens: 10 } });
  });
  it('query reuse stays inside its owner, returns detached vectors and bypasses save/batch embeddings', async () => {
    const fetch = transport(Array.from({ length: 6 }, () => embedding()));
    const client = new MemoryEmbeddingClient(embedder(fetch), request(), () => instant);
    await withMemoryEmbeddingScope('owner', async () => {
      const [first, reused] = await Promise.all([client.embedOne('Uno', 'owner'), client.embedOne('Uno', 'owner')]);
      expect(reused.reused).toBe(true); expect(first.reused).toBe(false);
      (first.vector as number[])[0] = 999;
      expect((await client.embedOne('Uno', 'owner')).vector[0]).toBe(0.1);
      await client.embedOne('Uno', 'foreign'); await client.embedOne('Uno'); await client.embedMany(['Uno']);
    });
    await client.embedOne('Uno', 'owner'); expect(fetch).toHaveBeenCalledTimes(5);
  });
  it('removes failed pending queries and captures only the enqueue scope', async () => {
    const fetch = transport([embedding([]), embedding()]); const client = new MemoryEmbeddingClient(embedder(fetch), request(), () => instant);
    const work = withMemoryEmbeddingScope('owner', () => captureMemoryEmbeddingScope(async () => {
      await expect(client.embedOne('Uno', 'owner')).rejects.toBeInstanceOf(AIProviderError);
      await client.embedOne('Uno', 'owner'); return client.embedOne('Uno', 'owner');
    }));
    expect((await withMemoryEmbeddingScope('foreign', work)).reused).toBe(true); expect(fetch).toHaveBeenCalledTimes(2);
  });
  it('checks a vendor-neutral adapter at the final memory boundary', async () => {
    const p: EmbeddingProvider = { space: LEGACY_MEMORY_SPACE, embed: async () => ({ space: LEGACY_MEMORY_SPACE, vectors: [[1]], usage: { inputTokens: 1 } }) };
    await expect(new MemoryEmbeddingClient(p, request(), () => instant).embedOne('Uno')).rejects.toThrow('INVALID_MEMORY_EMBEDDING');
    expect(() => new MemoryEmbeddingClient({ ...p, space: { ...LEGACY_MEMORY_SPACE, model: 'other' } }, request())).toThrow('MEMORY_EMBEDDING_SPACE_MISMATCH');
  });
});

describe('portable audio transcription', () => {
  it('uses a vendor-neutral transcription port with independent host validation', async () => {
    const p = { transcribe: async () => ({ text: ' hola ', accounting: { status: 'unavailable' as const } }) };
    expect(await transcribeUserAudio(p, { ...request(), audio: audio() }, () => instant)).toEqual({ text: 'hola', accounting: { status: 'unavailable' }, grantsExecution: false });
    await expect(transcribeUserAudio({ transcribe: async () => ({ text: '', accounting: { status: 'unavailable' } }) }, { ...request(), audio: audio() }, () => instant)).rejects.toThrow('INVALID_RESPONSE');
  });
  it('retains reported audio cost on a late or invalid response', async () => {
    const fetch = transport([{ text: '', usage: { seconds: 10, cost: 0.001 } }]);
    await expect(createConfiguredTranscriptionProvider('openrouter', { apiKey: 'fixture', fetch, now: () => instant }).transcribe({ ...request(), audio: audio() })).rejects.toMatchObject({ accounting: { status: 'reported', costUsd: 0.001, audioSeconds: 10 } });
    let clock = instant;
    const p = { transcribe: async () => { clock = 10100; return { text: 'hola', accounting: { status: 'reported' as const, costUsd: 0.001 } }; } };
    await expect(transcribeUserAudio(p, { ...request(), audio: audio() }, () => clock)).rejects.toMatchObject({ code: 'ENDPOINT_DEADLINE', accounting: { costUsd: 0.001 } });
  });
  it('Groq multipart preserves vocabulary/language without fabricated usage', async () => {
    const fetch = transport([{ text: ' hola ' }]);
    const result = await createConfiguredTranscriptionProvider('groq', { apiKey: 'fixture', env: {}, fetch, now: () => instant }).transcribe({ ...request(), audio: audio() });
    const form = fetch.mock.calls[0]?.[1]?.body as FormData;
    expect(form.get('model')).toBe('whisper-large-v3-turbo'); expect(form.get('language')).toBe('es'); expect(form.get('response_format')).toBe('json');
    expect(form.get('prompt')).toContain('recordatorio'); expect(result).toEqual({ text: 'hola', accounting: { status: 'unavailable' } });
  });
  it('OpenRouter uses raw base64 JSON and reported seconds/cost', async () => {
    const fetch = transport([{ text: 'hello', usage: { seconds: 12, cost: 0.001 } }]);
    const p = createConfiguredTranscriptionProvider('openrouter', { apiKey: 'fixture', env: {}, fetch, now: () => instant });
    expect(await p.transcribe({ ...request(), audio: { ...audio(), language: 'en' } })).toEqual({ text: 'hello', accounting: { status: 'reported', audioSeconds: 12, costUsd: 0.001 } });
    expect(body(fetch)).toEqual({ model: 'openai/whisper-large-v3', input_audio: { data: 'AQID', format: 'ogg' }, language: 'en', temperature: 0 });
  });
  it('preserves token-priced audio accounting independently from seconds', async () => {
    const fetch = transport([{ text: 'hello', usage: { input_tokens: 83, output_tokens: 30, cost: 0.0005 } }]);
    const p = createConfiguredTranscriptionProvider('openrouter', { apiKey: 'fixture', fetch, now: () => instant });
    expect((await p.transcribe({ ...request(), audio: audio() })).accounting).toEqual({ status: 'reported', inputTokens: 83, outputTokens: 30, costUsd: 0.0005 });
  });
  it.each(['groq', 'openrouter'] as const)('auto omits a forced language for %s', async transportName => {
    const fetch = transport([{ text: 'hola' }]);
    await createConfiguredTranscriptionProvider(transportName, { apiKey: 'fixture', env: {}, fetch, now: () => instant }).transcribe({ ...request(), audio: { ...audio(), language: 'auto' } });
    if (transportName === 'groq') expect((fetch.mock.calls[0]?.[1]?.body as FormData).has('language')).toBe(false);
    else expect(body(fetch)).not.toHaveProperty('language');
  });
  it.each([{ text: '' }, { text: 'hola', usage: { cost: -1 } }, { error: 'private upstream payload' }])('rejects invalid transcript/accounting %j without retry', async response => {
    const fetch = transport([response]);
    await expect(createConfiguredTranscriptionProvider('openrouter', { apiKey: 'fixture', fetch, now: () => instant }).transcribe({ ...request(), audio: audio() })).rejects.toThrow();
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('captures bytes before asynchronous transport and never serializes credentials', async () => {
    const source = audio(), fetch = transport([{ text: 'hola' }]);
    const p = new HttpTranscriptionProvider({ apiKey: 'secret-fixture', model: 'fixture/audio', transport: 'openrouter', timeoutMs: 100, fetch, now: () => instant });
    const work = p.transcribe({ ...request(), audio: source }); source.bytes.fill(9);
    await work; expect(body(fetch).input_audio.data).toBe('AQID'); expect(JSON.stringify(p)).not.toContain('secret-fixture');
  });
  it.each(['fetch', 'body'])('deadline bounds an ignored signal in %s', async stage => {
    vi.useFakeTimers();
    const fetch = vi.fn<typeof globalThis.fetch>(() => stage === 'fetch' ? new Promise(() => {}) : Promise.resolve({ json: () => new Promise(() => {}) } as Response));
    const p = createConfiguredTranscriptionProvider('groq', { apiKey: 'fixture', env: {}, fetch, now: () => instant });
    const work = expect(p.transcribe({ ...request(), audio: audio() })).rejects.toThrow('ENDPOINT_DEADLINE');
    await vi.advanceTimersByTimeAsync(5000); await work; expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('blocks aborted calls before network and late transcripts after network', async () => {
    const controller = new AbortController(); controller.abort(); const fetch = transport([{ text: 'hola' }]);
    const p = createConfiguredTranscriptionProvider('groq', { apiKey: 'fixture', env: {}, fetch, now: () => instant });
    await expect(p.transcribe({ ...request(), signal: controller.signal, audio: audio() })).rejects.toThrow('ENDPOINT_ABORTED'); expect(fetch).not.toHaveBeenCalled();
    let clock = instant; const late = vi.fn<typeof globalThis.fetch>(async () => { clock = 10100; return new Response('{"text":"hola"}'); });
    await expect(createConfiguredTranscriptionProvider('groq', { apiKey: 'fixture', env: {}, fetch: late, now: () => clock }).transcribe({ ...request(), audio: audio() })).rejects.toThrow('ENDPOINT_DEADLINE');
  });
});

describe('optional response synthesis', () => {
  const input = { facts: [{ tool: 'manage_task' }], excludedClauses: [{ quote: 'Envía a Pedro', reason: 'out_of_scope' }], language: 'es' as const };
  function p(text: string): TextAIProvider {
    return { capabilities: { toolCalling: false, structuredOutput: false }, complete: async () => { throw new Error('native'); },
      completeText: async () => ({ status: 'success', text, usage: { inputTokens: 10, outputTokens: 5 } }) };
  }
  it('reuses the actual prompt and normalization without replacing action cards', async () => {
    const text = JSON.stringify({ before: '  No puedo\n enviar eso.  ', after: 'Otro' });
    const provider = p(text); provider.completeText = vi.fn(provider.completeText);
    const result = await synthesizeExcludedFraming(provider, { ...request(), maxOutputTokens: 1000 }, input, () => instant);
    expect(result).toMatchObject({ ...normalizeResponseSynthesis(JSON.parse(text)), after: '', grantsExecution: false });
    expect(vi.mocked(provider.completeText).mock.calls[0]?.[0]).toMatchObject({ messages: buildResponseSynthesisMessages(input), maxOutputTokens: 180 });
  });
  it('skips synthesis when there are no facts or excluded clauses', async () => {
    const provider = p('{}'); provider.completeText = vi.fn(provider.completeText);
    expect(await synthesizeExcludedFraming(provider, { ...request(), maxOutputTokens: 180 }, { ...input, facts: [] })).toBeNull();
    expect(await synthesizeExcludedFraming(provider, { ...request(), maxOutputTokens: 180 }, { ...input, excludedClauses: [] })).toBeNull();
    expect(provider.completeText).not.toHaveBeenCalled();
  });
  it('preserves English and the legacy after-to-before fallback within 160 characters', async () => {
    const result = await synthesizeExcludedFraming(p(JSON.stringify({ after: 'x'.repeat(300) })), { ...request(), maxOutputTokens: 180 }, { ...input, language: 'en' }, () => instant);
    expect(result?.before).toHaveLength(160); expect(result?.after).toBe('');
    expect(buildResponseSynthesisMessages({ ...input, language: 'en' })?.[0]?.content).toContain('Write one tiny');
  });
  it.each(['bad', '{"before":42}'])('rejects ignored eager validation at the final host boundary %s', async text => {
    await expect(synthesizeExcludedFraming(p(text), { ...request(), maxOutputTokens: 180 }, input, () => instant)).rejects.toThrow();
  });
  it('configured synthesis uses native route identities and a 180 token cap', async () => {
    const wire = { choices: [{ message: { role: 'assistant', content: '{"before":"Hola","after":""}' }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5 } };
    const fetch = transport([wire]);
    await synthesizeExcludedFraming(createConfiguredSynthesisAIProvider({ apiKey: 'fixture', fetch, env: {}, now: () => instant }), { ...request(), maxOutputTokens: 500 }, input, () => instant);
    expect(body(fetch)).toMatchObject({ response_format: { type: 'json_object' }, max_tokens: 180, temperature: 0.2 });
    expect(body(fetch)).not.toHaveProperty('tools');
  });
});
