type RowFixture = { id: string; user_id?: string; status?: string; [field: string]: unknown };
import { beforeEach, describe, expect, it, vi } from 'vitest';

const databaseState = vi.hoisted(() => ({
  projects: [] as RowFixture[],
  entities: [] as RowFixture[],
  tasks: [] as RowFixture[],
}));

const supabaseMock = vi.hoisted(() => ({
  from: vi.fn((table: string) => {
    const filters: Record<string, unknown> = {};

    const query = {
      select: vi.fn(() => query),
      eq: vi.fn((col: string, val: unknown) => {
        filters[col] = val;
        return query;
      }),
      ilike: vi.fn(() => query),
      order: vi.fn(() => query),
      limit: vi.fn(() => query),
      then: (resolve: (value: { data: RowFixture[]; error: null }) => unknown) => {
        if (table === 'tasks') {
          const matchingTasks = databaseState.tasks.filter((t) => (
            (!filters.user_id || t.user_id === filters.user_id) &&
            (!filters.status || t.status === filters.status)
          ));
          resolve({ data: matchingTasks, error: null });
        } else if (table === 'projects') {
          const matching = databaseState.projects.filter((p) => (
            (!filters.user_id || p.user_id === filters.user_id) &&
            (!filters.status || p.status === filters.status)
          ));
          resolve({ data: matching, error: null });
        } else if (table === 'entities') {
          resolve({ data: databaseState.entities, error: null });
        } else {
          resolve({ data: [], error: null });
        }
      },
    };
    return query;
  }),
}));

vi.mock('../../../src/infrastructure/database/index.js', () => ({ supabase: supabaseMock }));

import { findProjects } from '../../../src/infrastructure/database/projects.js';

describe('findProjects dynamic task count aggregation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    databaseState.projects = [];
    databaseState.entities = [];
    databaseState.tasks = [];
  });

  it('aggregates pending task counts dynamically for each project', async () => {
    databaseState.projects = [
      { id: 'proj-1', user_id: 'user-123', name: 'Apartamento', status: 'active' },
      { id: 'proj-2', user_id: 'user-123', name: 'reminder', status: 'active' },
      { id: 'proj-3', user_id: 'user-123', name: 'Trabajo', status: 'active' },
    ];

    databaseState.tasks = [
      // 2 pending tasks in reminder
      { id: 'task-1', user_id: 'user-123', project_id: 'proj-2', entity_id: null, status: 'pending' },
      { id: 'task-2', user_id: 'user-123', project_id: 'proj-2', entity_id: null, status: 'pending' },
      // 1 pending task in Trabajo (via entity_id legacy)
      { id: 'task-3', user_id: 'user-123', project_id: null, entity_id: 'proj-3', status: 'pending' },
      // 1 completed task in reminder (should NOT be counted)
      { id: 'task-4', user_id: 'user-123', project_id: 'proj-2', entity_id: null, status: 'completed' },
      // 1 task belonging to another user
      { id: 'task-5', user_id: 'other-user', project_id: 'proj-1', entity_id: null, status: 'pending' },
    ];

    const projects = await findProjects({ userId: 'user-123' });

    expect(projects).toHaveLength(3);

    const apto = projects.find((p) => p.name === 'Apartamento');
    const reminder = projects.find((p) => p.name === 'reminder');
    const trabajo = projects.find((p) => p.name === 'Trabajo');

    expect(apto!.taskCount).toBe(0);
    expect(reminder!.taskCount).toBe(2);
    expect(trabajo!.taskCount).toBe(1);
  });
});
