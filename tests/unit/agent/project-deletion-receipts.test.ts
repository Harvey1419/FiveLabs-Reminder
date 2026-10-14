type CapturedCall = { table: string; operation: string; filters: Array<[string, unknown]> };
import { beforeEach, describe, expect, it, vi } from 'vitest';
const { from } = vi.hoisted(() => ({ from: vi.fn() }));
vi.mock('../../../src/infrastructure/database/index.js', () => ({ supabase: { from } }));
import { deleteProjects } from '../../../src/infrastructure/database/projects.js';
import { executeProjectTool } from '../../../src/agent/tools/projects.js';
let calls: CapturedCall[], fail: string | null, partial: string | null;
beforeEach(() => {
  calls = []; fail = null; partial = null;
  from.mockImplementation((table: string) => {
    const call: CapturedCall = { table, operation: 'read', filters: [] }; calls.push(call);
    const query = {
      select: vi.fn(() => query), eq: vi.fn((...args: [string, unknown]) => { call.filters.push(args); return query; }),
      in: vi.fn((...args: [string, unknown]) => { call.filters.push(args); return query; }), or: vi.fn(() => query),
      delete: vi.fn(() => { call.operation = 'delete'; return query; }), update: vi.fn(() => { call.operation = 'update'; return query; }),
      then: (resolve: (value: { data: Array<Record<string, unknown>> | null; error: { message: string } | null }) => unknown) => {
        const key = `${table}.${call.operation}`;
        if (key === fail) return Promise.resolve({ data: null, error: { message: 'write failed' } }).then(resolve);
        const data = table === 'projects' ? [{ id: 'p1', name: 'QA' }]
          : table === 'tasks' ? (call.operation === 'read' ? [{ id: 't1', status: 'pending' }, { id: 't2', status: 'completed' }] : [{ id: 't1', title: 'Pending', status: 'pending' }])
          : table === 'reminders' ? [{ id: 'r1', content: 'Remember', status: 'cancelled' }]
          : [{ id: 'p1', name: 'QA', category: 'project' }];
        return Promise.resolve({ data: key === partial ? [] : data, error: null }).then(resolve);
      },
    }; return query;
  });
});
const remove = () => deleteProjects({ userId: 'u1', projectIds: ['p1'] });
describe('project deletion evidence and dependency failures', () => {
  it('does not execute a delete merely because project IDs were supplied', async () => {
    const result = await executeProjectTool({ action: 'delete', user: { id: 'u1' }, params: { projectIds: ['p1'] } });
    expect(result.errorCode).toBe('CONFIRMATION_REQUIRED');
    expect(calls.every(call => call.operation === 'read')).toBe(true);
  });
  it('stops before task/project deletion if cancelling their reminders fails', async () => {
    fail = 'reminders.update'; const result = await remove();
    expect(result.success).toBe(false); expect(result.deletedCount).toBe(0);
    expect(calls.some(call => call.operation === 'delete')).toBe(false);
  });
  it('exposes actual partial receipts and never deletes the project after a failed task deletion', async () => {
    fail = 'tasks.delete'; const result = await remove();
    expect(result).toMatchObject({ success: false, partialSuccess: true, deletedCount: 0, deletedTaskCount: 0, cancelledReminderCount: 1 });
    expect(result.receipts!.reminders[0]!.content).toBe('Remember');
    expect(calls.some(call => call.table === 'projects' && call.operation === 'delete')).toBe(false);
  });
  it('stops on concurrent task state changes instead of using planned counts', async () => {
    partial = 'tasks.delete'; const result = await remove();
    expect(result.errorCode).toBe('CONCURRENT_CHANGE'); expect(result.deletedTaskCount).toBe(0);
    expect(calls.some(call => call.table === 'projects' && call.operation === 'delete')).toBe(false);
  });
  it('returns contents and IDs only from actual writes, preserving completed tasks', async () => {
    const result = await remove();
    expect(result).toMatchObject({ success: true, complete: true, deletedCount: 1, deletedTaskCount: 1, cancelledReminderCount: 1, preservedCompletedTaskCount: 1 });
    expect(result.receipts!.tasks[0]!.title).toBe('Pending');
    const writes = calls.filter(call => call.operation !== 'read');
    expect(writes.every(call => call.filters.some(([key, val]) => key === 'user_id' && val === 'u1'))).toBe(true);
    expect(writes.find(call => call.table === 'tasks')!.filters).toContainEqual(['id', ['t1']]);
  });
  it('reports mirror failure after observed deletions without claiming the project is missing', async () => {
    fail = 'entities.delete';
    const result = await executeProjectTool({ action: 'delete', user: { id: 'u1' }, params: { projectIds: ['p1'] }, clarificationResolution: true });
    expect(result).toMatchObject({ success: false, partialSuccess: true, action: 'project_deletion_incomplete' });
    expect((result.data as { deletedCount: number }).deletedCount).toBe(1); expect(result.error).toContain('Cambios confirmados');
  });
});
