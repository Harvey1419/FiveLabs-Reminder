import { describe, expect, it, vi } from 'vitest';
import { selectMemoriesToForget } from '../../../src/agent/orchestration/select-memory-forgetting.js';
const candidates = [{ id: 'project', topic_key: 'project/qa/description', content: 'User has QA project' }, { id: 'hardware', content: 'QA hardware budget 120' }];
const options = { candidates, query: 'Forget the hardware and software budgets of QA' };
describe('semantic forgetting selection', () => {
  it('binds model positions to observed IDs only', async () => {
    const complete = vi.fn().mockResolvedValue({ content: '{"positions":[2]}' });
    expect(await selectMemoriesToForget({ ...options, complete })).toEqual(['hardware']);
    expect(complete.mock.calls[0][1]).toMatchObject({ tools: null, toolChoice: 'none' });
  });
  it.each(['{"positions":[3]}', '{"positions":[1,1]}', '{"positions":[1],"deleteAll":true}', 'bad'])('rejects invalid selections %s', async content => {
    expect(await selectMemoriesToForget({ ...options, complete: vi.fn().mockResolvedValue({ content }) })).toBeNull();
  });
  it('permits no matching whole facts', async () => {
    expect(await selectMemoriesToForget({ ...options, complete: vi.fn().mockResolvedValue({ content: '{"positions":[]}' }) })).toEqual([]);
  });
});
