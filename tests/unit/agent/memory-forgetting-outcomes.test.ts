import { beforeEach, describe, expect, it, vi } from 'vitest';
const { forgetMemories, selectMemoriesToForget } = vi.hoisted(() => ({ forgetMemories: vi.fn(), selectMemoriesToForget: vi.fn() }));
vi.mock('../../../src/infrastructure/database/index.js', () => ({
  forgetMemories, saveMemory: vi.fn(), searchMemories: vi.fn(), getActiveMemories: vi.fn(),
}));
vi.mock('../../../src/agent/orchestration/select-memory-forgetting.js', () => ({ selectMemoriesToForget }));
import { executeMemoryTool } from '../../../src/agent/tools/memory.js';
const options = { action: 'forget', params: { query: 'Forget only the hardware budget', topicKey: 'project/qa' }, user: { id: 'owner' }, correlationId: 'req-1' };
beforeEach(() => vi.clearAllMocks());
describe('memory forgetting user-visible receipts', () => {
  it('does not announce deletion when nothing matched', async () => {
    vi.mocked(forgetMemories, { partial: true }).mockResolvedValue({ success: true, deletedCount: 0, deletedMemories: [] });
    const result = await executeMemoryTool(options);
    expect(result).toMatchObject({ success: false, action: 'memory_not_found', errorCode: 'NOT_FOUND' });
    expect(result.rawSummary).toContain('No eliminé ninguna memoria');
  });
  it('preserves unknown write outcomes instead of claiming no change', async () => {
    vi.mocked(forgetMemories, { partial: true }).mockResolvedValue({ success: false, outcome: 'unknown', errorCode: 'DATABASE_ERROR', deletedCount: 0 });
    const result = await executeMemoryTool(options);
    expect(result).toMatchObject({ success: false, outcome: 'unknown' });
    expect(result.rawSummary).toContain('No pude confirmar');
  });
  it('exposes only the returned facts and uses the full query when a topic is also present', async () => {
    const deletedMemories = [{ id: 'hardware', content: 'Hardware budget: 120' }];
    vi.mocked(forgetMemories, { partial: true }).mockImplementation(async ({ selectCandidates }) => {
      await selectCandidates(deletedMemories);
      return { success: true, deletedCount: 1, deletedMemories };
    });
    const result = await executeMemoryTool({ ...options, language: 'en' });
    expect(selectMemoriesToForget).toHaveBeenCalledWith(expect.objectContaining({ query: options.params.query, correlationId: 'req-1' }));
    expect(result).toMatchObject({ success: true, data: { deletedCount: 1, deletedMemories } });
    expect(result.formattedCard).toContain('1 memory deleted');
    expect(result.formattedCard).toContain('Hardware budget: 120');
  });
});
