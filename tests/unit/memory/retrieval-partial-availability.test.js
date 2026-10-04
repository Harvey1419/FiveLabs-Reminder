import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  ftsError: null,
  vectorError: null,
  verificationError: null,
  empty: false,
  malformed: false,
  row: { id: 'known-memory', user_id: 'u1', is_active: true, valid_until: null, superseded_by: null,
    content: 'La reunión es por Zoom.', category: 'preference', topic_key: 'preference/meeting', confidence: 1, similarity: 0.9 },
}));
vi.mock('../../../src/integrations/ai/embeddings.js', () => ({
  generateEmbedding: vi.fn().mockResolvedValue([0.1, 0.2]),
}));
vi.mock('../../../src/infrastructure/database/index.js', () => ({ supabase: {
  from: vi.fn(() => {
    let mode = 'verification';
    const filters = [];
    const q = {
      select: () => q,
      eq: (key, value) => { filters.push([key, value]); return q; },
      is: () => q,
      textSearch: () => { mode = 'fts'; return q; },
      order: () => q, limit: () => q,
      update: () => { mode = 'access'; return q; },
      in: () => q,
      then: (resolve, reject) => {
        const error = mode === 'fts' ? state.ftsError : mode === 'verification' ? state.verificationError : null;
        if (mode === 'verification') {
          expect(filters).toContainEqual(['user_id', 'u1']);
          expect(filters).toContainEqual(['is_active', true]);
        }
        return Promise.resolve({ data: error || state.malformed ? null : state.empty ? [] : [state.row], error }).then(resolve, reject);
      },
    };
    return q;
  }),
  rpc: vi.fn(async () => ({ data: state.vectorError ? null : [state.row], error: state.vectorError })),
} }));
import { searchMemories, getActiveMemories } from '../../../src/infrastructure/database/memories.js';

beforeEach(() => { state.ftsError = null; state.vectorError = null; state.verificationError = null; state.empty = false; state.malformed = false; });
describe('memory partial availability', () => {
  it('distinguishes healthy empty list and no-query search from failed storage', async () => {
    state.empty = true;
    expect(await getActiveMemories({ userId: 'u1' })).toEqual([]);
    expect(await searchMemories({ userId: 'u1', withStatus: true })).toEqual({ status: 'available', memories: [] });
    state.verificationError = new Error('private storage failure');
    expect(await getActiveMemories({ userId: 'u1', withStatus: true })).toEqual({ status: 'unavailable', memories: [] });
    await expect(searchMemories({ userId: 'u1', throwOnError: true, withStatus: true })).rejects.toThrow('Memory storage is unavailable');
  });
  it('rejects malformed list data and missing owner without a query', async () => {
    state.malformed = true;
    expect(await getActiveMemories({ userId: 'u1', withStatus: true })).toEqual({ status: 'unavailable', memories: [] });
    expect(await searchMemories({ withStatus: true })).toEqual({ status: 'unavailable', memories: [] });
  });
  it('status-only retrieval reports all-channel failures as unavailable', async () => {
    state.ftsError = state.vectorError = new Error('Unavailable');
    expect(await searchMemories({ userId: 'u1', query: 'Zoom', withStatus: true })).toEqual({ status: 'unavailable', memories: [] });
  });
  it('reports unavailable when both retrieval channels fail', async () => {
    state.ftsError = state.vectorError = new Error('Unavailable');
    await expect(searchMemories({ userId: 'u1', query: 'Zoom', throwOnError: true })).rejects.toThrow('All memory retrieval channels');
  });
  it.each(['fts', 'vector'])('keeps owner-verified memories when only %s retrieval fails', async source => {
    state[source + 'Error'] = { message: 'simulated retrieval failure' };
    const result = await searchMemories({ userId: 'u1', query: 'Zoom', limit: 3, throwOnError: true });
    expect(result).toContainEqual(state.row);
    const statusResult = await searchMemories({ userId: 'u1', query: 'Zoom', limit: 3, throwOnError: true, withStatus: true });
    expect(statusResult).toEqual({ status: 'partial', memories: [state.row] });
  });
  it('does not label unverified candidates as available when final verification fails', async () => {
    state.verificationError = new Error('Verification unavailable');
    const result = await searchMemories({ userId: 'u1', query: 'Zoom', withStatus: true });
    expect(result).toEqual({ status: 'unavailable', memories: [] });
    await expect(searchMemories({ userId: 'u1', query: 'Zoom', throwOnError: true })).rejects.toThrow();
  });
});
