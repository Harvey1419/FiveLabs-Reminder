import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as embeddings from '../../../dist/runtime/integrations/ai/embeddings.js';

const vector = () => Array<number>(768).fill(0.25);
const reply = () => new Response(JSON.stringify({ data: [{ index: 0, embedding: vector() }] }));

beforeEach(() => {
  vi.stubEnv('OPENROUTER_API_KEY', 'synthetic-embedding-key');
  vi.stubEnv('AI_API_KEY', '');
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

describe('compiled public embedding adapter', () => {
  it('coalesces owned queries, isolates returned vectors and discards scope state after the turn', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => reply());
    await embeddings.withQueryEmbeddingScope('compiled-owner', async () => {
      const [a, b] = await Promise.all([
        embeddings.generateEmbedding(' same ', { queryOwner: 'compiled-owner' }),
        embeddings.generateEmbedding('same', { queryOwner: 'compiled-owner' }),
      ]);
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(a).toEqual(vector());
      expect(b).toEqual(vector());
      expect(a).not.toBe(b);
      a![0] = 99;
      expect(await embeddings.generateEmbedding('same', { queryOwner: 'compiled-owner' })).toEqual(vector());
      expect(fetch).toHaveBeenCalledTimes(1);
    });
    await embeddings.withQueryEmbeddingScope('compiled-owner', () =>
      embeddings.generateEmbedding('same', { queryOwner: 'compiled-owner' }));
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls[0]![0]).toBe('https://openrouter.ai/api/v1/embeddings');
    expect(JSON.parse(fetch.mock.calls[0]![1]!.body as string)).toEqual({
      model: embeddings.MEMORY_EMBEDDING_MODEL, dimensions: 768, encoding_format: 'float', input: 'same',
    });
  });

  it('evicts an invalid provider vector so an owned query can recover and then reuse its result', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: [{ index: 0, embedding: [0] }] })))
      .mockImplementation(async () => reply());
    await embeddings.withQueryEmbeddingScope('compiled-recovery', async () => {
      expect(await embeddings.generateEmbedding('retry', { queryOwner: 'compiled-recovery' })).toBeNull();
      expect(await embeddings.generateEmbedding('retry', { queryOwner: 'compiled-recovery' })).toEqual(vector());
      expect(await embeddings.generateEmbedding('retry', { queryOwner: 'compiled-recovery' })).toEqual(vector());
    });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('reads current credentials at request time and skips transport when no supported key is configured', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => reply());
    vi.stubEnv('OPENROUTER_API_KEY', '');
    expect(await embeddings.generateEmbedding('no key')).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
    vi.stubEnv('OPENROUTER_API_KEY', ' "synthetic-first" ');
    expect(await embeddings.generateEmbedding('first')).toEqual(vector());
    vi.stubEnv('OPENROUTER_API_KEY', '');
    vi.stubEnv('AI_API_KEY', ' sk-or-synthetic-second ');
    // The existing fallback checks the prefix before trimming.
    expect(await embeddings.generateEmbedding('leading space')).toBeNull();
    expect(fetch).toHaveBeenCalledTimes(1);
    vi.stubEnv('AI_API_KEY', 'sk-or-synthetic-second');
    expect(await embeddings.generateEmbedding('second')).toEqual(vector());
    expect(fetch).toHaveBeenCalledTimes(2);
    const headers = fetch.mock.calls.map(([, options]) => options!.headers as Record<string, string>);
    expect(headers.map(header => header.Authorization)).toEqual(['Bearer synthetic-first', 'Bearer sk-or-synthetic-second']);
  });
});
