import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockState = vi.hoisted(() => ({
  reminders: [],
  tasks: [],
  calls: [],
}));

vi.mock('../../../src/infrastructure/database/index.js', async () => {
  return {
    supabase: {
      from: vi.fn((table) => {
        const chain = {
          update: vi.fn((updates) => {
            mockState.calls.push({ table, op: 'update', updates });
            return chain;
          }),
          delete: vi.fn(() => {
            mockState.calls.push({ table, op: 'delete' });
            return chain;
          }),
          select: vi.fn(() => chain),
          eq: vi.fn((field, val) => {
            mockState.calls.push({ table, op: 'eq', field, val });
            return chain;
          }),
          in: vi.fn((field, vals) => {
            mockState.calls.push({ table, op: 'in', field, vals });
            return chain;
          }),
          is: vi.fn((field, val) => {
            mockState.calls.push({ table, op: 'is', field, val });
            return chain;
          }),
          limit: vi.fn(() => chain),
          maybeSingle: vi.fn(async () => ({ data: null, error: null })),
          single: vi.fn(async () => ({ data: null, error: null })),
          then: (resolve) => resolve({ data: [{ id: 'rem-1' }], error: null }),
        };
        return chain;
      }),
    },
    acknowledgeRemindersByTaskId: vi.fn(async (taskId, userId) => {
      mockState.calls.push({ op: 'acknowledgeRemindersByTaskId', taskId, userId });
      return { acknowledgedCount: 1 };
    }),
    cancelRemindersByTaskId: vi.fn(async (taskId, userId) => {
      mockState.calls.push({ op: 'cancelRemindersByTaskId', taskId, userId });
      return { cancelledCount: 1 };
    }),
    rescheduleRemindersByTaskId: vi.fn(async (taskId, newDueDate, userId) => {
      mockState.calls.push({ op: 'rescheduleRemindersByTaskId', taskId, newDueDate, userId });
      return { rescheduledCount: 1, newSendAt: newDueDate };
    }),
    updateTask: vi.fn(async (taskId, updates, userId) => {
      return { id: taskId, title: 'Comprar insumos', ...updates };
    }),
    deleteTask: vi.fn(async (taskId, userId) => {
      return { success: true, error: null };
    }),
    completeTasksByQuery: vi.fn(async () => ({ completedCount: 1 })),
  };
});

vi.mock('../../../src/agent/tools/task-reference.js', () => ({
  resolveTaskTarget: vi.fn(async ({ target, operation }) => {
    return {
      status: 'RESOLVED_SINGLE',
      taskId: 'task-uuid-1',
      task: { id: 'task-uuid-1', title: 'Comprar insumos', user_id: 'user-1' },
      item: { id: 'task-uuid-1', title: 'Comprar insumos' },
    };
  }),
}));

const {
  acknowledgeRemindersByTaskId,
  cancelRemindersByTaskId,
  rescheduleRemindersByTaskId,
} = await import('../../../src/infrastructure/database/index.js');
const { executeTaskComplete } = await import('../../../src/agent/tools/task-complete.js');
const { executeTaskDelete } = await import('../../../src/agent/tools/task-delete.js');
const { executeTaskUpdate } = await import('../../../src/agent/tools/task-update.js');

describe('Task ⇄ Reminder Dual Synergy lifecycle cascades', () => {
  const testUser = { id: 'user-1', phone_number: '+573001234567' };

  beforeEach(() => {
    mockState.calls = [];
    vi.clearAllMocks();
  });

  it('cascades task completion to companion reminders', async () => {
    const res = await executeTaskComplete({
      params: { target: 'Comprar insumos' },
      user: testUser,
    });

    expect(res.success).toBe(true);
    expect(res.taskId).toBe('task-uuid-1');
    expect(acknowledgeRemindersByTaskId).toHaveBeenCalledWith('task-uuid-1', 'user-1');
  });

  it('cascades task deletion to companion reminders', async () => {
    const res = await executeTaskDelete({
      params: { target: 'Comprar insumos' },
      user: testUser,
    });

    expect(res.success).toBe(true);
    expect(res.action).toBe('deleted_task');
    expect(cancelRemindersByTaskId).toHaveBeenCalledWith('task-uuid-1', 'user-1');
  });

  it('reports partial completion if a deleted task leaves companion reminders unconfirmed', async () => {
    cancelRemindersByTaskId.mockRejectedValueOnce(new Error('storage unavailable'));

    const res = await executeTaskDelete({
      params: { target: 'Comprar insumos' },
      user: testUser,
      language: 'en',
    });

    expect(res).toMatchObject({ success: true, partialSuccess: true, complete: false });
    expect(res.error).toContain('task was deleted');
    expect(res.error).toContain('may remain');
  });

  it('cascades task due date update to reschedule companion reminders', async () => {
    const res = await executeTaskUpdate({
      params: { target: 'Comprar insumos', dueDate: '2026-09-15T10:00:00.000Z' },
      user: testUser,
    });

    expect(res.success).toBe(true);
    expect(res.action).toBe('updated_task');
    expect(rescheduleRemindersByTaskId).toHaveBeenCalledWith(
      'task-uuid-1',
      '2026-09-15T10:00:00.000Z',
      'user-1',
    );
  });

  it('reports partial completion when task update succeeds but companion rescheduling fails', async () => {
    rescheduleRemindersByTaskId.mockRejectedValueOnce(new Error('storage unavailable'));

    const res = await executeTaskUpdate({
      params: { target: 'Comprar insumos', dueDate: '2026-09-15T10:00:00.000Z' },
      user: testUser,
      language: 'en',
    });

    expect(res).toMatchObject({ success: true, partialSuccess: true, complete: false });
    expect(res.error).toContain('task was updated');
    expect(res.error).toContain('may not have moved');
  });

  it('reports partial completion when task completion cannot confirm linked reminders', async () => {
    acknowledgeRemindersByTaskId.mockRejectedValueOnce(new Error('storage unavailable'));
    const { executeTaskComplete } = await import('../../../src/agent/tools/task-complete.js');

    const res = await executeTaskComplete({
      params: { target: 'Comprar insumos' }, user: testUser, language: 'en',
    });

    expect(res).toMatchObject({ success: true, partialSuccess: true, complete: false });
    expect(res.error).toContain('task was completed');
    expect(res.error).toContain('some may remain active');
  });
  it('cancels deadline companions when the task deadline is explicitly removed', async () => {
    const res = await executeTaskUpdate({ params: { target: 'Comprar insumos', dueDate: null }, user: testUser, language: 'en' });
    expect(res.success).toBe(true);
    expect(cancelRemindersByTaskId).toHaveBeenCalledWith('task-uuid-1', 'user-1');
  });

});
