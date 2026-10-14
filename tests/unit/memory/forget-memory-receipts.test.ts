import { beforeEach, describe, expect, it, vi } from 'vitest';
const from = vi.fn();
const rpc = vi.fn();
const generateEmbedding = vi.fn();
vi.mock('../../../src/infrastructure/database/index.js', () => ({ supabase: { from, rpc } }));
vi.mock('../../../src/integrations/ai/embeddings.js', () => ({ generateEmbedding }));
const { forgetMemories } = await import('../../../src/infrastructure/database/memories.js');
function query<T>(result: T) {
  type Method = 'select' | 'eq' | 'ilike' | 'textSearch' | 'delete' | 'in';
  type Chain = { [K in Method]: ReturnType<typeof vi.fn<(...args: unknown[]) => Chain>> } & PromiseLike<T>;
  const chain = {} as Chain;
  for (const key of ['select', 'eq', 'ilike', 'textSearch', 'delete', 'in'] as const) chain[key] = vi.fn(() => chain);
  chain.then = (resolve, reject) => Promise.resolve(result).then(resolve, reject);
  return chain;
}
const budget = { id: 'budget', topic_key: 'project/qa/hardware', content: 'Hardware budget: 120' };
const project = { id: 'project', topic_key: 'project/qa/description', content: 'The user has project QA' };
beforeEach(() => { vi.clearAllMocks(); generateEmbedding.mockResolvedValue([0.1]); rpc.mockResolvedValue({ data: [project, budget] }); });

describe('memory deletion scoped to observed selection and returned rows', () => {
  it('deletes only selected facts, scoped to owner, and logs actual returned content', async () => {
    const remove = query({ data: [budget] });
    from.mockReturnValueOnce(query({ data: [] })).mockReturnValueOnce(query({ data: [] })).mockReturnValueOnce(remove);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const result = await forgetMemories({ userId: 'owner', query: 'Forget QA budgets', correlationId: 'req-1', selectCandidates: async () => ['budget'] });
    expect(remove.eq).toHaveBeenCalledWith('user_id', 'owner');
    expect(remove.in).toHaveBeenCalledWith('id', ['budget']);
    expect(remove.select).toHaveBeenCalledWith('id, content, topic_key, category');
    expect(result).toEqual({ success: true, deletedCount: 1, deletedMemories: [budget] });
    expect(log.mock.calls.flat().join(' ')).toContain('Hardware budget: 120');
    log.mockRestore();
  });
  it.each([{ ids: null }, { ids: ['foreign'] }, { ids: ['budget', 'budget'] }])('never deletes an unvalidated selection $ids', async ({ ids }) => {
    from.mockReturnValue(query({ data: [] }));
    const result = await forgetMemories({ userId: 'owner', query: 'budget', selectCandidates: async () => ids });
    expect(result).toMatchObject({ success: false, errorCode: 'MEMORY_SELECTION_UNAVAILABLE', deletedCount: 0 });
    expect(from).toHaveBeenCalledTimes(2);
  });
  it('does not count retrieved candidates as deleted when the write returns zero rows', async () => {
    from.mockReturnValueOnce(query({ data: [budget] })).mockReturnValueOnce(query({ data: [] }));
    expect(await forgetMemories({ userId: 'owner', topicKey: budget.topic_key })).toEqual({ success: true, deletedCount: 0, deletedMemories: [] });
  });
  it('uses exact topic identity without widening to a semantic neighborhood', async () => {
    const lookup = query({ data: [budget] });
    from.mockReturnValueOnce(lookup).mockReturnValueOnce(query({ data: [budget] }));
    await forgetMemories({ userId: 'owner', topicKey: budget.topic_key });
    expect(lookup.eq).toHaveBeenCalledWith('topic_key', budget.topic_key);
    expect(lookup.ilike).not.toHaveBeenCalled();
    expect(rpc).not.toHaveBeenCalled();
  });
  it('reports a failed delete as failure', async () => {
    from.mockReturnValueOnce(query({ data: [budget] })).mockReturnValueOnce(query({ error: { message: 'unavailable' } }));
    expect(await forgetMemories({ userId: 'owner', topicKey: budget.topic_key })).toMatchObject({ success: false, errorCode: 'DATABASE_ERROR', deletedCount: 0 });
  });
  it('does not attempt a delete after a failed lookup', async () => {
    from.mockReturnValueOnce(query({ error: { message: 'unavailable' } }));
    expect(await forgetMemories({ userId: 'owner', topicKey: budget.topic_key })).toMatchObject({ success: false });
    expect(from).toHaveBeenCalledTimes(1);
  });
  it('treats missing write receipts as unknown, never as zero confirmed changes', async () => {
    from.mockReturnValueOnce(query({ data: [budget] })).mockReturnValueOnce(query({ data: null }));
    expect(await forgetMemories({ userId: 'owner', topicKey: budget.topic_key })).toMatchObject({ success: false, outcome: 'unknown' });
  });
});
