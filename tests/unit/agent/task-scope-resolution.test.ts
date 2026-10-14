type RowFixture = { id: string; [field: string]: unknown };
type MemoryFixture = { entityType: string; items: Array<{ type: string; internalId: string; position: number; title: string }> };
import { describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  entities: [
    { id: 'project-a', user_id: 'owner-1', name: 'Proyecto A', category: 'project' },
    { id: 'project-b', user_id: 'owner-1', name: 'Proyecto B', category: 'project' },
  ],
  tasks: [
    { id: 'task-a', user_id: 'owner-1', entity_id: 'project-a', title: 'Comprar bloqueador', status: 'pending', entities: { id: 'project-a', name: 'Proyecto A' } },
    { id: 'task-b', user_id: 'owner-1', entity_id: 'project-b', title: 'Comprar bloqueador', status: 'pending', entities: { id: 'project-b', name: 'Proyecto B' } },
    { id: '11111111-1111-4111-8111-111111111111', user_id: 'owner-1', title: 'Owned pending', status: 'pending' },
    { id: '22222222-2222-4222-8222-222222222222', user_id: 'owner-2', title: 'Foreign pending', status: 'pending' },
    { id: '33333333-3333-4333-8333-333333333333', user_id: 'owner-1', title: 'Owned completed', status: 'completed' },
    { id: '44444444-4444-4444-8444-444444444444', user_id: 'owner-1', title: 'Owned deleted', status: 'deleted' },
    { id: '77777777-7777-4777-8777-777777777777', user_id: 'owner-1', title: '3', status: 'pending' },
  ],
  filters: [] as Array<[string, string, unknown]>,
  workingMemory: null as MemoryFixture | null,
}));
const supabase = vi.hoisted(() => ({ from: vi.fn() }));

function queryFor(table: string) {
  const localFilters: Array<[string, unknown]> = [];
  const query = {
    select: vi.fn(() => query),
    eq: vi.fn((key: string, value: unknown) => { state.filters.push([table, key, value]); localFilters.push([key, value]); return query; }),
    in: vi.fn(() => query),
    order: vi.fn(() => query),
    limit: vi.fn(() => query),
    maybeSingle: vi.fn(async () => {
      const rows: RowFixture[] = table === 'entities' ? state.entities : state.tasks;
      const row = rows.find((candidate) => localFilters.every(([key, value]) => candidate[key] === value)) || null;
      return { data: row, error: null };
    }),
    then: (resolve: (value: { data: RowFixture[]; error: null }) => unknown) => {
      const source: RowFixture[] = table === 'entities' ? state.entities : state.tasks;
      const data = source.filter((row) => localFilters.every(([key, value]) => row[key] === value));
      return Promise.resolve({ data, error: null }).then(resolve);
    },
  };
  return query;
}

supabase.from.mockImplementation((table) => queryFor(table));

vi.mock('../../../src/infrastructure/database/index.js', () => ({ supabase }));
vi.mock('../../../src/agent/core/working-memory.js', () => ({ getWorkingMemory: vi.fn(() => state.workingMemory) }));

import { resolveTaskTarget } from '../../../src/agent/tools/task-reference.js';

describe('structured task container scope', () => {
  it.each(['complete', 'update', 'delete'])('resolves duplicate titles only inside the explicit container for task.%s', async (operation) => {
    state.filters = [];
    const result = await resolveTaskTarget({
      target: 'Comprar bloqueador', entityName: 'Proyecto A', userId: 'owner-1', operation,
    });

    expect(result.status).toBe('RESOLVED');
    expect(result.taskId).toBe('task-a');
    expect(state.filters).toContainEqual(['tasks', 'entity_id', 'project-a']);
  });

  it('does not broaden to tenant-wide matching when the explicit container is absent', async () => {
    state.filters = [];
    const result = await resolveTaskTarget({
      target: 'Comprar bloqueador', entityName: 'Proyecto inexistente', userId: 'owner-1', operation: 'complete',
    });

    expect(result.status).toBe('NOT_FOUND');
    expect(state.filters.filter(([table]) => table === 'tasks')).toEqual([]);
  });

  it.each(['update', 'delete'])('revalidates UUID ownership and allowed status before task.%s', async (operation) => {
    for (const [target, expected] of [
      ['11111111-1111-4111-8111-111111111111', 'RESOLVED'],
      ['22222222-2222-4222-8222-222222222222', 'NOT_FOUND'],
      ['33333333-3333-4333-8333-333333333333', 'RESOLVED'],
      ['44444444-4444-4444-8444-444444444444', 'NOT_FOUND'],
      ['55555555-5555-4555-8555-555555555555', 'NOT_FOUND'],
    ]) {
      const result = await resolveTaskTarget({ target, userId: 'owner-1', operation });
      expect(result.status).toBe(expected);
      if (expected === 'RESOLVED') expect(result.taskId).toBe(target);
    }
  });

  it.each(['update', 'delete', 'complete'])('revalidates ownership and status for a pinned Working Memory task.%s target', async (operation) => {
    state.workingMemory = {
      entityType: 'task',
      items: [{ type: 'task', internalId: '22222222-2222-4222-8222-222222222222', position: 1, title: 'Foreign pending' }],
    };
    const result = await resolveTaskTarget({ target: '1', userId: 'owner-1', userOrPhone: 'owner-phone', operation });
    expect(result.status).toBe('NOT_FOUND');

    state.workingMemory = {
      entityType: 'task',
      items: [{ type: 'task', internalId: '33333333-3333-4333-8333-333333333333', position: 1, title: 'Owned completed' }],
    };
    const completedResult = await resolveTaskTarget({ target: '1', userId: 'owner-1', userOrPhone: 'owner-phone', operation });
    expect(completedResult.status).toBe(operation === 'complete' ? 'NOT_FOUND' : 'RESOLVED');
  });

  it('does not resolve stale Working Memory IDs after the task has been deleted', async () => {
    state.workingMemory = {
      entityType: 'task',
      items: [{ type: 'task', internalId: '55555555-5555-4555-8555-555555555555', position: 1, title: 'Deleted task' }],
    };
    const result = await resolveTaskTarget({ target: '1', userId: 'owner-1', userOrPhone: 'owner-phone', operation: 'update' });
    expect(result.status).toBe('NOT_FOUND');
  });

  it('rejects an out-of-range numeric ordinal before fuzzy matching a task titled with that number', async () => {
    state.workingMemory = {
      entityType: 'task',
      items: [
        { type: 'task', internalId: 'task-a', position: 1, title: 'First task' },
        { type: 'task', internalId: 'task-b', position: 2, title: 'Second task' },
      ],
    };
    const result = await resolveTaskTarget({ target: '3', userId: 'owner-1', userOrPhone: 'owner-phone', operation: 'delete' });
    expect(result.status).toBe('NOT_FOUND');
  });

  it('still resolves a non-ordinal explicit phrase for a numeric task title', async () => {
    state.workingMemory = {
      entityType: 'task',
      items: [{ type: 'task', internalId: '77777777-7777-4777-8777-777777777777', position: 2, title: '3' }],
    };
    const result = await resolveTaskTarget({ target: 'the task titled 3', userId: 'owner-1', userOrPhone: 'owner-phone', operation: 'delete' });
    expect(result.status).toBe('RESOLVED');
    expect(result.taskId).toBe('77777777-7777-4777-8777-777777777777');
  });
});
