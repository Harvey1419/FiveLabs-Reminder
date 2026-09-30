import { beforeEach, describe, expect, it, vi } from 'vitest';
const db = vi.hoisted(() => ({ rows: {}, errors: {}, calls: [] }));
vi.mock('../../../src/infrastructure/database/index.js', () => ({
  supabase: { from: (table) => {
    const query = {};
    for (const method of ['select', 'eq', 'or', 'order', 'gte', 'lt', 'limit']) {
      query[method] = (...args) => { db.calls.push({ table, method, args }); return query; };
    }
    query.then = (resolve, reject) => Promise.resolve({ data: db.rows[table] || [], error: db.errors[table] || null }).then(resolve, reject);
    return query;
  } },
}));
import { getTaskList } from '../../../src/features/tasks/service.js';
import { executeTaskReadTool } from '../../../src/agent/tools/task-read.js';
const user = { id: 'owner', timezone: 'America/Bogota' };
const task = { id: 'task-1', user_id: user.id, title: 'devolver 720.000 pesos', status: 'pending' };

beforeEach(() => { db.rows = { tasks: [task], entities: [{ id: 'project-1', name: 'Taller' }] }; db.errors = {}; db.calls = []; });

describe('read coverage is owned by the task source, not model prose', () => {
  it('certifies the complete set only after a successful overfetch', async () => {
    const result = await getTaskList({ userId: user.id, entityName: 'Taller', limit: 2 });
    expect(result.tasks).toHaveLength(1);
    expect(result.readCoverage).toEqual({ complete: true, limit: 2 });
    expect(result.readAt).toBeTruthy();
    expect(db.calls).toContainEqual({ table: 'tasks', method: 'limit', args: [3] });
    expect(db.calls).toContainEqual({ table: 'tasks', method: 'eq', args: ['user_id', 'owner'] });
  });
  it('reports truncation even if text filtering removes all visible rows', async () => {
    db.rows.tasks = [{ ...task, title: 'comprar escritorio' }, { ...task, id: 'task-2' }];
    const result = await getTaskList({ userId: user.id, entityName: 'Taller', query: 'devolver', limit: 1 });
    expect(result.tasks).toEqual([]);
    expect(result.readCoverage.complete).toBe(false);
  });
  it('distinguishes a complete empty read from an unknown project', async () => {
    db.rows.tasks = [];
    const empty = await executeTaskReadTool({ params: { entityName: 'Taller' }, user });
    expect(empty.success).toBe(true);
    expect(empty.data.readCoverage.complete).toBe(true);
    const missing = await executeTaskReadTool({ params: { entityName: 'Unrelated nonexistent container' }, user });
    expect(missing).toMatchObject({ success: false, errorCode: 'NOT_FOUND' });
  });
  it('does not disguise failed project or task reads as no matching records', async () => {
    db.errors.projects = { message: 'projects unavailable' };
    expect(await executeTaskReadTool({ params: { entityName: 'Taller' }, user })).toMatchObject({ success: false, errorCode: 'DATABASE_ERROR' });
    db.errors = { tasks: { message: 'tasks unavailable' } };
    expect(await executeTaskReadTool({ params: { entityName: 'Taller' }, user })).toMatchObject({ success: false, errorCode: 'DATABASE_ERROR' });
  });
  it('never issues an unscoped read without an authenticated owner', async () => {
    await expect(getTaskList({ entityName: 'Taller' })).rejects.toThrow('authenticated owner');
    expect(db.calls).toEqual([]);
  });
});
