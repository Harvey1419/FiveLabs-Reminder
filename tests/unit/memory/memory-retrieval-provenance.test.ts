import type { MemoryRow } from '../../../src/infrastructure/database/memory-persistence-client.js';
type CapturedRead = { table: string; predicates: Array<[string, ...unknown[]]> };
type QueryMethod = 'select' | 'eq' | 'in' | 'order' | 'limit' | 'or' | 'ilike' | 'textSearch' | 'update';
type QueryFixture = { [K in QueryMethod]: (...args: unknown[]) => QueryFixture } & PromiseLike<{ data: unknown; error: unknown }>;
type RowFixture = { id: string; [field: string]: unknown };
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { from, rpc, embedding, requests, state } = vi.hoisted(() => ({
  from: vi.fn(), rpc: vi.fn(), embedding: vi.fn(), requests: [] as CapturedRead[],
  state: { rows: [] as RowFixture[], sparse: [] as RowFixture[], error: null as Error | null },
}));
vi.mock('../../../src/infrastructure/database/index.js', () => ({ supabase: { from, rpc } }));
vi.mock('../../../src/integrations/ai/embeddings.js', () => ({ generateEmbedding: embedding }));
const { searchMemories, getActiveMemories, getStandingMemories } = await import('../../../src/infrastructure/database/memories.js');
const { buildPersonalKnowledge: buildKnowledge } = await import('../../../src/agent/orchestration/personal-knowledge.js');
function buildPersonalKnowledge(owner: string, memories: readonly MemoryRow[]) {
  return buildKnowledge(owner, memories as unknown as Parameters<typeof buildKnowledge>[1]);
}
const owner = 'owner';
const row = (id: string, patch: Record<string, unknown> = {}) => ({ id, user_id: owner, is_active: true, superseded_by: null, valid_until: null,
  category: 'fact', topic_key: `profile/${id}`, content: `Actual ${id}`, ...patch });

beforeEach(() => {
  vi.clearAllMocks(); requests.length = 0; state.rows = []; state.sparse = []; state.error = null;
  embedding.mockResolvedValue([0.1]); rpc.mockResolvedValue({ data: [], error: null });
  from.mockImplementation((table: string) => {
    const request: CapturedRead = { table, predicates: [] }; requests.push(request);
    const q = {} as QueryFixture;
    for (const method of ['select', 'eq', 'in', 'order', 'limit', 'or', 'ilike', 'textSearch', 'update'] as const) {
      q[method] = vi.fn((...args) => { request.predicates.push([method, ...args]); return q; });
    }
    q.then = (resolve, reject) => Promise.resolve((request.predicates.some(p => p[0] === 'in')
      && !request.predicates.some(p => p[0] === 'update')) || request.predicates.some(p => p[0] === 'or')
      ? { data: state.rows, error: state.error }
      : { data: request.predicates.some(p => p[0] === 'textSearch') ? state.sparse : [], error: null }).then(resolve, reject);
    return q;
  });
});
const retrieve = (extra = {}) => searchMemories({ userId: owner, query: 'profile', withStatus: true, ...extra });
const has = (request: CapturedRead, predicate: [string, ...unknown[]]) => request.predicates.some(p => JSON.stringify(p) === JSON.stringify(predicate));

describe('retrieval producer provenance', () => {
  it('hydrates missing RPC flags/content from actual rows, preserving similarity rank', async () => {
    rpc.mockResolvedValue({ data: [
      { id: 'second', similarity: 0.88, content: 'untrusted', category: 'episode' },
      { id: 'first', similarity: 0.9 },
    ], error: null });
    state.rows = [row('second'), row('first')];
    const result = await retrieve();
    expect(result.status).toBe('available');
    expect(result.memories.map(m => [m.id, m.content, m.similarity])).toEqual([
      ['first', 'Actual first', 0.9], ['second', 'Actual second', 0.88],
    ]);
    expect(buildPersonalKnowledge(owner, result.memories).lookup.size).toBe(2);
    const hydration = requests.filter(r => has(r, ['in', 'id', ['second', 'first']]) && !r.predicates.some(p => p[0] === 'update'));
    expect(hydration).toHaveLength(1);
    expect(has(hydration[0]!, ['eq', 'user_id', owner])).toBe(true);
    expect(has(hydration[0]!, ['eq', 'is_active', true])).toBe(true);
    const update = requests.find(r => r.predicates.some(p => p[0] === 'update'));
    expect(has(update!, ['eq', 'user_id', owner])).toBe(true);
  });

  it('excludes foreign, inactive, superseded, missing-provenance and invalid rows', async () => {
    state.rows = [row('foreign', { user_id: 'other' }), row('inactive', { is_active: false }),
      row('old', { superseded_by: 'new' }), row('missing', { is_active: undefined }),
      row('invalid', { content: '' }), row('good')];
    rpc.mockResolvedValue({ data: state.rows.map(m => ({ id: m.id, similarity: 0.9 })), error: null });
    expect((await retrieve()).memories.map(m => m.id)).toEqual(['good']);
  });

  it('verifies mixed vector and FTS candidates in the same read, keeping vector priority', async () => {
    rpc.mockResolvedValue({ data: [{ id: 'vector', similarity: 0.9 }], error: null });
    state.sparse = [row('sparse', { content: 'stale sparse content' }), row('foreign')];
    state.rows = [row('sparse'), row('vector'), row('foreign', { user_id: 'other' })];
    const result = await retrieve();
    expect(result.memories.map(m => [m.id, m.content])).toEqual([
      ['vector', 'Actual vector'], ['sparse', 'Actual sparse'],
    ]);
    const hydration = requests.filter(r => has(r, ['in', 'id', ['vector', 'sparse', 'foreign']]));
    expect(hydration).toHaveLength(1);
    expect(has(hydration[0]!, ['eq', 'user_id', owner])).toBe(true);
  });

  it('fails closed on hydration failure with status or requested throw', async () => {
    rpc.mockResolvedValue({ data: [{ id: 'first', similarity: 0.9 }], error: null });
    state.error = new Error('verification unavailable');
    expect(await retrieve()).toEqual({ status: 'unavailable', memories: [] });
    await expect(retrieve({ throwOnError: true })).rejects.toThrow('verification unavailable');
    expect(requests.some(r => r.predicates.some(p => p[0] === 'update'))).toBe(false);
  });

  it('does not treat future standing facts as current personal knowledge', async () => {
    state.rows = [row('future', { valid_from: '2099-01-01T00:00:00Z' }), row('good', { valid_from: '2000-01-01T00:00:00Z' }), row('foreign', { user_id: 'other' })];
    const result = await getStandingMemories({ userId: owner });
    expect(result.error).toBeNull();
    expect(result.data!.map(memory => memory.id)).toEqual(['good']);
    expect(buildPersonalKnowledge(owner, result.data!).lookup.size).toBe(1);
  });
  it('projects real provenance on direct active, standing, FTS and topic routes', async () => {
    await getActiveMemories({ userId: owner });
    await getStandingMemories({ userId: owner });
    await retrieve({ topicKey: 'profile' });
    const selects = requests.filter(r => r.predicates.some(p => p[0] === 'select'));
    expect(selects).toHaveLength(4);
    for (const request of selects) {
      expect(has(request, ['eq', 'user_id', owner])).toBe(true);
      expect(has(request, ['eq', 'is_active', true])).toBe(true);
      const columns = (request.predicates.find(p => p[0] === 'select')![1] as string).split(',').map(s => s.trim());
      for (const column of ['user_id', 'is_active', 'valid_from', 'valid_until', 'superseded_by']) expect(columns).toContain(column);
    }
  });
});
