import { untrustedResultMock } from '../../support/unit/contract-boundary.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('../../../src/infrastructure/database/index.js', () => ({
  searchMemories: vi.fn(), getActiveMemories: vi.fn(), forgetMemories: vi.fn(),
}));
vi.mock('../../../src/features/memory/service.js', () => ({ extractAndSaveMemories: vi.fn() }));
vi.mock('../../../src/agent/orchestration/select-memory-forgetting.js', () => ({ selectMemoriesToForget: vi.fn() }));
import { searchMemories, getActiveMemories } from '../../../src/infrastructure/database/index.js';
import { executeMemoryTool } from '../../../src/agent/tools/memory.js';
const user = { id: 'u1' };
beforeEach(() => vi.resetAllMocks());
describe('truthful memory reads', () => {
  for (const action of ['search', 'list']) {
    const producer = () => action === 'search' ? searchMemories : getActiveMemories;
    it(`${action}: healthy empty succeeds with status requested`, async () => {
      untrustedResultMock(producer()).mockResolvedValue({ status: 'available', memories: [] });
      const result = await executeMemoryTool({ action, user });
      expect(result).toMatchObject({ success: true, data: { memories: [] } });
      expect(producer()).toHaveBeenCalledWith(expect.objectContaining({ userId: 'u1', withStatus: true, throwOnError: true }));
    });
    it.each([undefined, [], { status: 'unavailable', memories: [] }, { status: 'unknown', memories: [] }, { status: 'available', memories: null }, { status: 'available', memories: [{}] }])(`${action}: rejects malformed/unavailable result %j`, async value => {
      untrustedResultMock(producer()).mockResolvedValue(value);
      expect(await executeMemoryTool({ action, user })).toMatchObject({ success: false, errorCode: 'MEMORY_UNAVAILABLE' });
    });
    it(`${action}: storage errors stay private`, async () => {
      untrustedResultMock(producer()).mockRejectedValue(new Error('secret SQL credentials'));
      const result = await executeMemoryTool({ action, user });
      expect(result.errorCode).toBe('MEMORY_UNAVAILABLE');
      expect(JSON.stringify(result)).not.toMatch(/secret|SQL|credentials/);
    });
    it(`${action}: missing user never queries`, async () => {
      expect((await executeMemoryTool({ action })).success).toBe(false);
      expect(producer()).not.toHaveBeenCalled();
    });
  }
  it('publishes a verified partial subset with a notice', async () => {
    vi.mocked(searchMemories, { partial: true }).mockResolvedValue({ status: 'partial', memories: [{ id: 'm1', content: 'Prefers calls.' }] });
    const result = await executeMemoryTool({ action: 'search', user, language: 'en' });
    expect(result.success).toBe(true);
    expect(result.rawSummary).toMatch(/partial/i);
    expect(result.data!.memories).toHaveLength(1);
  });
  it('partial empty is not presented as confirmed empty', async () => {
    vi.mocked(searchMemories, { partial: true }).mockResolvedValue({ status: 'partial', memories: [] });
    expect((await executeMemoryTool({ action: 'search', user })).errorCode).toBe('MEMORY_UNAVAILABLE');
  });
});
