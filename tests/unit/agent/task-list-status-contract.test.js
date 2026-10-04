import { describe, expect, it, vi } from 'vitest';
vi.mock('../../../src/features/tasks/service.js', () => ({ getTaskList: vi.fn() }));
import { getTaskList } from '../../../src/features/tasks/service.js';
import { executeTaskReadTool } from '../../../src/agent/tools/task-read.js';
import { validateTurnIntent } from '../../../src/agent/contracts/intent-contracts.js';
import { projectStructuredTurnIntent, stripStructuredNulls } from '../../../src/agent/contracts/foreground-turn-schema.js';

describe('explicit canonical task status', () => {
  it.each([undefined, null, 'unknown'])('rejects missing or invalid status %s after provider projection', status => {
    const wire = { actions: [{ operation: 'task.list', status }] };
    expect(validateTurnIntent(projectStructuredTurnIntent(stripStructuredNulls(wire))).valid).toBe(false);
  });
  it.each(['pending', 'completed', 'all'])('preserves model-selected %s', status => {
    const parsed = validateTurnIntent({ actions: [{ domain: 'task', action: 'list', status }] });
    expect(parsed.valid).toBe(true);
    expect(parsed.intent.actions[0].status).toBe(status);
  });
  it('passes all and bounded owner/container/query/limit to the real read boundary', async () => {
    getTaskList.mockResolvedValue({ tasks: [] });
    await executeTaskReadTool({ user: { id: 'owner', timezone: 'UTC', locale: 'en-US' }, params: { status: 'all', entityName: 'Work', query: 'Alfa', limit: 3 } });
    expect(getTaskList).toHaveBeenLastCalledWith(expect.objectContaining({ userId: 'owner', status: 'all', entityName: 'Work', query: 'Alfa', limit: 3 }));
  });
  it('retains the direct-tool legacy pending default', async () => {
    getTaskList.mockResolvedValue({ tasks: [] });
    await executeTaskReadTool({ params: {} });
    expect(getTaskList).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'pending' }));
  });
});
