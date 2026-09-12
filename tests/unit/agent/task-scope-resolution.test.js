import { describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  entities: [
    { id: 'project-a', user_id: 'owner-1', name: 'Proyecto A', category: 'project' },
    { id: 'project-b', user_id: 'owner-1', name: 'Proyecto B', category: 'project' },
  ],
  tasks: [
    { id: 'task-a', user_id: 'owner-1', entity_id: 'project-a', title: 'Comprar bloqueador', status: 'pending', entities: { id: 'project-a', name: 'Proyecto A' } },
    { id: 'task-b', user_id: 'owner-1', entity_id: 'project-b', title: 'Comprar bloqueador', status: 'pending', entities: { id: 'project-b', name: 'Proyecto B' } },
  ],
  filters: [],
}));
const supabase = vi.hoisted(() => ({ from: vi.fn() }));

function queryFor(table) {
  const localFilters = [];
  const query = {
    select: vi.fn(() => query),
    eq: vi.fn((key, value) => { state.filters.push([table, key, value]); localFilters.push([key, value]); return query; }),
    in: vi.fn(() => query),
    order: vi.fn(() => query),
    limit: vi.fn(() => query),
    maybeSingle: vi.fn(async () => ({ data: null, error: null })),
    then: (resolve) => {
      const source = table === 'entities' ? state.entities : state.tasks;
      const data = source.filter((row) => localFilters.every(([key, value]) => row[key] === value));
      return Promise.resolve({ data, error: null }).then(resolve);
    },
  };
  return query;
}

supabase.from.mockImplementation((table) => queryFor(table));

vi.mock('../../../src/infrastructure/database/index.js', () => ({ supabase }));
vi.mock('../../../src/agent/core/working-memory.js', () => ({ getWorkingMemory: vi.fn(() => null) }));

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
});
