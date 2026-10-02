import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  ftsError: null,
  vectorError: null,
  row: { id: 'known-memory', content: 'La reunión es por Zoom.', category: 'preference', topic_key: 'preference/meeting', confidence: 1, similarity: 0.9 },
}));
vi.mock('../../../src/integrations/ai/embeddings.js', () => ({
  generateEmbedding: vi.fn().mockResolvedValue([0.1, 0.2]),
}));
vi.mock('../../../src/infrastructure/database/index.js', () => {
  const q = {
    select: () => q, eq: () => q, textSearch: () => q, order: () => q, limit: () => q, update: () => q, in: () => q,
    then: (resolve, reject) => Promise.resolve({ data: state.ftsError ? null : [state.row], error: state.ftsError }).then(resolve, reject),
  };
  return { supabase: {
    from: vi.fn(() => q),
    rpc: vi.fn(async () => ({ data: state.vectorError ? null : [state.row], error: state.vectorError })),
  } };
});
import { searchMemories } from '../../../src/infrastructure/database/memories.js';

beforeEach(() => { state.ftsError = null; state.vectorError = null; });
describe('memory partial availability', () => {
  it('reports unavailable when both retrieval channels fail', async () => {
    state.ftsError = state.vectorError = new Error('Unavailable');
    await expect(searchMemories({ userId: 'u1', query: 'Zoom', throwOnError: true })).rejects.toThrow('All memory retrieval channels');
  });
  it.each(['fts', 'vector'])('keeps verified memories when only %s retrieval fails', async (source) => {
    state[source + 'Error'] = { message: 'simulated retrieval failure' };
    const result = await searchMemories({ userId: 'u1', query: 'Zoom', limit: 3, throwOnError: true });
    expect(result).toContainEqual(state.row);
    const statusResult = await searchMemories({ userId: 'u1', query: 'Zoom', limit: 3, throwOnError: true, withStatus: true });
    expect(statusResult).toEqual({ status: 'partial', memories: [state.row] });
  });
});
