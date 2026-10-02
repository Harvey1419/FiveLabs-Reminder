import { describe, expect, it, vi } from 'vitest';
vi.mock('../../../src/agent/tools/task-create.js', () => ({ executeTaskCreate: vi.fn() }));
import { executeTaskCreate } from '../../../src/agent/tools/task-create.js';
import { executeTool } from '../../../src/agent/tools/index.js';

describe('observable domain tool outcomes', () => {
  it('keeps a thrown write outcome unknown at the real tool boundary', async () => {
    executeTaskCreate.mockRejectedValueOnce(new Error('Transport closed after possible commit'));
    const result = await executeTool({ toolName: 'manage_task', params: { action: 'create', items: [{ title: 'Alpha' }] }, user: { id: 'synthetic' }, language: 'en' });
    expect(result).toMatchObject({ success: false, outcome: 'unknown', complete: false });
    expect(result.rawSummary).not.toContain('Transport closed');
  });
  it('does not discard an explicit unknown returned by a domain adapter', async () => {
    executeTaskCreate.mockResolvedValueOnce({ success: false, outcome: 'unknown', errorCode: 'WRITE_OUTCOME_UNKNOWN' });
    const result = await executeTool({ toolName: 'manage_task', params: { action: 'create' }, user: { id: 'synthetic' } });
    expect(result.outcome).toBe('unknown');
  });
});
