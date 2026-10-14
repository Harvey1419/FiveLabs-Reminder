import { beforeEach, describe, expect, it, vi } from 'vitest';

const databaseState = vi.hoisted(() => ({
  insertedPayloads: [] as Array<Record<string, unknown>>,
  insertCalls: 0,
  persistedRows: [] as Array<Record<string, unknown>>,
  insertError: null as null | { code: string; message: string },
}));

const supabaseMock = vi.hoisted(() => ({
  from: vi.fn(() => {
    const query = {
      select: vi.fn(() => query),
      eq: vi.fn(() => query),
      ilike: vi.fn(() => query),
      is: vi.fn(() => query),
      limit: vi.fn(async () => ({ data: [], error: null })),
      insert: vi.fn((payloads: Array<Record<string, unknown>>) => {
        databaseState.insertCalls += 1;
        databaseState.insertedPayloads = payloads;
        return {
          select: vi.fn(async () => {
            if (databaseState.insertError) {
              return { data: null, error: databaseState.insertError };
            }
            databaseState.persistedRows = payloads.map((payload, index) => ({
              id: `task-${index + 1}`,
              ...payload,
            }));
            return { data: databaseState.persistedRows, error: null };
          }),
        };
      }),
    };
    return query;
  }),
}));

vi.mock('../../../src/infrastructure/database/index.js', () => ({ supabase: supabaseMock }));

import { createTasksBatch } from '../../../src/infrastructure/database/tasks.js';

describe('atomic task batch persistence', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    databaseState.insertedPayloads = [];
    databaseState.insertCalls = 0;
    databaseState.persistedRows = [];
    databaseState.insertError = null;
  });

  it('returns the complete persisted batch after one successful insert statement', async () => {
    const result = await createTasksBatch({
      userId: 'owner-1',
      items: ['A', 'B', 'C'].map((title) => ({ title, entityId: 'project-1' })),
    });

    expect(result.error).toBeNull();
    expect(result.data!.map((task) => task.title)).toEqual(['A', 'B', 'C']);
    expect(databaseState.insertCalls).toBe(1);
    expect(databaseState.persistedRows).toHaveLength(3);
  });

  it('uses one insert statement and exposes no subset when the batch statement fails', async () => {
    databaseState.insertError = { code: '57014', message: 'batch statement failed' };

    const result = await createTasksBatch({
      userId: 'owner-1',
      items: ['A', 'B', 'C'].map((title) => ({
        title,
        description: `Description ${title}`,
        priority: 'high',
        dueDate: '2026-09-12T15:00:00.000Z',
        entityId: 'project-1',
      })),
    });

    expect(result).toMatchObject({ data: null, error: { code: '57014' } });
    expect(databaseState.insertCalls).toBe(1);
    expect(databaseState.insertedPayloads).toHaveLength(3);
    expect(databaseState.insertedPayloads[0]).toMatchObject({
      user_id: 'owner-1',
      title: 'A',
      description: 'Description A',
      priority: 'high',
      due_date: '2026-09-12T15:00:00.000Z',
      entity_id: 'project-1',
    });
    expect(databaseState.persistedRows).toEqual([]);
  });
});
