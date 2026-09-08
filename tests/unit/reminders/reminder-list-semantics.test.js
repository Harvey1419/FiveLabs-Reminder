import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/infrastructure/database/index.js', () => ({
  supabase: { from: vi.fn() },
  saveReminder: vi.fn(),
  getRemindersByPhone: vi.fn(),
  cancelPendingRemindersByContent: vi.fn(),
  acknowledgeReminder: vi.fn(),
  acknowledgeReminders: vi.fn(),
  markReminderAsCancelled: vi.fn(),
  updateReminder: vi.fn(),
  createTask: vi.fn(),
  getUserSubscription: vi.fn().mockResolvedValue(null),
  hasProAccess: vi.fn().mockReturnValue(true),
  shouldEnforceBillingForUser: vi.fn().mockReturnValue(false),
}));

const { supabase, markReminderAsCancelled } = await import('../../../src/infrastructure/database/index.js');
const { executeReminderReadTool } = await import('../../../src/agent/tools/reminder-read.js');
const { executeBulkReminderCancellation } = await import('../../../src/agent/tools/reminder-bulk-cancel.js');

function queryResult(data = []) {
  const query = {};
  for (const method of ['select', 'or', 'eq', 'in', 'is', 'gte', 'lt', 'neq', 'not', 'order', 'limit']) {
    query[method] = vi.fn(() => query);
  }
  query.then = (resolve, reject) => Promise.resolve({ data, error: null }).then(resolve, reject);
  return query;
}

describe('reminder list delivery-state semantics', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('queries only reminders still awaiting future delivery by default', async () => {
    const query = queryResult([{
      id: 'future-1',
      content: 'Llamar a Laura',
      send_at: '2026-09-05T22:00:00.000Z',
      status: 'pending',
      acknowledged_at: null,
    }]);
    supabase.from.mockReturnValue(query);

    const result = await executeReminderReadTool({
      params: {},
      user: { id: 'user-1', phone_number: '+573000000001', timezone: 'America/Bogota' },
      language: 'es',
      referenceTime: new Date('2026-09-05T20:34:12.000Z'),
    });

    expect(result).toMatchObject({ success: true, action: 'listed_reminders' });
    expect(query.eq).toHaveBeenCalledWith('status', 'pending');
    expect(query.is).toHaveBeenCalledWith('acknowledged_at', null);
    expect(query.gte).toHaveBeenCalledWith('send_at', '2026-09-05T20:34:12.000Z');
    expect(result.data).toMatchObject({ filter: 'upcoming' });
    expect(result.formattedCard).toContain('Llamar a Laura');
  });

  it('does not treat already sent reminders as pending-today rows', async () => {
    const query = queryResult([]);
    supabase.from.mockReturnValue(query);

    await executeReminderReadTool({
      params: { filter: 'pending_today' },
      user: { id: 'user-1', phone_number: '+573000000001', timezone: 'America/Bogota' },
      language: 'es',
      referenceTime: new Date('2026-09-05T20:34:12.000Z'),
    });

    expect(query.eq).toHaveBeenCalledWith('status', 'pending');
    expect(query.neq).not.toHaveBeenCalledWith('status', 'cancelled');
  });

  it('stages elapsed reminder cleanup once and preserves its backend cutoff', async () => {
    const rows = [
      { id: 'elapsed-1', content: 'Anterior uno', send_at: '2026-09-05T18:00:00.000Z', status: 'sent' },
      { id: 'elapsed-2', content: 'Anterior dos', send_at: '2026-09-05T19:00:00.000Z', status: 'missed' },
    ];
    const query = queryResult(rows);
    supabase.from.mockReturnValue(query);

    const result = await executeBulkReminderCancellation({
      params: { scope: 'elapsed' },
      user: { id: 'user-1', phone_number: '+573000000001', timezone: 'America/Bogota' },
      language: 'es',
      referenceTime: new Date('2026-09-05T20:34:12.000Z'),
    });

    expect(query.neq).toHaveBeenCalledWith('status', 'cancelled');
    expect(query.lt).toHaveBeenCalledWith('send_at', '2026-09-05T20:34:12.000Z');
    expect(markReminderAsCancelled).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      success: false,
      errorCode: 'CONFIRMATION_REQUIRED',
      requiresClarification: true,
      pendingClarifications: [{
        proposedOperation: {
          kind: 'reminder_cancel',
          scope: 'elapsed',
          cutoffAt: '2026-09-05T20:34:12.000Z',
        },
      }],
    });
    expect(result.formattedCard).toContain('Encontré 2 recordatorios');
  });

  it('cancels the staged elapsed collection after confirmation without asking again', async () => {
    const rows = [
      { id: 'elapsed-1', content: 'Anterior uno', send_at: '2026-09-05T18:00:00.000Z', status: 'sent' },
      { id: 'elapsed-2', content: 'Anterior dos', send_at: '2026-09-05T19:00:00.000Z', status: 'failed' },
    ];
    const query = queryResult(rows);
    supabase.from.mockReturnValue(query);
    markReminderAsCancelled.mockResolvedValue(true);

    const result = await executeBulkReminderCancellation({
      params: { scope: 'elapsed', cutoffAt: '2026-09-05T20:34:12.000Z' },
      user: { id: 'user-1', phone_number: '+573000000001', timezone: 'America/Bogota' },
      language: 'es',
      referenceTime: new Date('2026-09-05T20:40:00.000Z'),
      clarificationResolution: true,
    });

    expect(query.lt).toHaveBeenCalledWith('send_at', '2026-09-05T20:34:12.000Z');
    expect(markReminderAsCancelled).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({
      success: true,
      action: 'cancelled_reminders',
      data: { cancelledCount: 2, remainingCount: 0, scope: 'elapsed' },
    });
    expect(result.formattedCard).toContain('Recordatorios anteriores eliminados');
    expect(result).not.toHaveProperty('pendingClarifications');
  });
});
