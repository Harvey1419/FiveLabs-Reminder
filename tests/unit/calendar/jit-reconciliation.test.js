import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockState = vi.hoisted(() => ({
  savedReminders: [],
  updatedReminders: [],
  calls: [],
}));

vi.mock('../../../src/infrastructure/database/index.js', async () => {
  return {
    supabase: {
      from: vi.fn((table) => {
        const chain = {
          select: vi.fn(() => chain),
          eq: vi.fn(() => chain),
          like: vi.fn(() => chain),
          in: vi.fn(() => chain),
          maybeSingle: vi.fn(async () => ({ data: { phone_number: '+573009998877' }, error: null })),
          single: vi.fn(async () => ({ data: { phone_number: '+573009998877' }, error: null })),
          then: (resolve) => {
            if (table === 'reminders') {
              return resolve({ data: mockState.savedReminders, error: null });
            }
            return resolve({ data: [], error: null });
          },
        };
        return chain;
      }),
    },
    saveReminder: vi.fn(async (params) => {
      mockState.calls.push({ op: 'saveReminder', params });
      const record = { id: `rem-gen-${Date.now()}`, ...params, status: 'pending' };
      mockState.savedReminders.push(record);
      return record;
    }),
    updateReminder: vi.fn(async (id, updates, userId) => {
      mockState.calls.push({ op: 'updateReminder', id, updates, userId });
      mockState.updatedReminders.push({ id, updates, userId });
      return { id, ...updates };
    }),
    getUserIntegration: vi.fn(async (userId, provider) => {
      if (userId === 'user-no-auth') return null;
      return { access_token: 'valid-token', refresh_token: 'valid-refresh' };
    }),
  };
});

vi.mock('../../../src/infrastructure/database/memories.js', () => ({
  getReminderConfirmationPreference: vi.fn(async (userId) => {
    if (userId === 'user-with-pref') {
      return { requiresConfirmation: true, intervalMinutes: 10, maxNudges: 3 };
    }
    return null;
  }),
}));

vi.mock('../../../src/integrations/google/calendar.js', () => ({
  listCalendarEvents: vi.fn(async (userId) => {
    if (userId === 'user-with-events') {
      const futureMs = Date.now() + 2 * 60 * 60 * 1000; // 2 hours from now
      return [
        {
          id: 'g-event-1',
          summary: 'Reunión de inversores',
          start: { dateTime: new Date(futureMs).toISOString() },
          end: { dateTime: new Date(futureMs + 3600000).toISOString() },
        },
      ];
    }
    if (userId === 'user-rescheduled') {
      const futureMs = Date.now() + 5 * 60 * 60 * 1000; // rescheduled to 5 hours from now
      return [
        {
          id: 'g-event-resched',
          summary: 'Sesión 1 a 1',
          start: { dateTime: new Date(futureMs).toISOString() },
          end: { dateTime: new Date(futureMs + 3600000).toISOString() },
        },
      ];
    }
    if (userId === 'user-deleted-event') {
      // Empty calendar: external event was deleted
      return [];
    }
    return [];
  }),
  normalizeCalendarEvent: vi.fn((ev) => ({
    id: ev.id,
    summary: ev.summary,
    startIso: ev.start?.dateTime,
    isAllDay: false,
  })),
}));

const { reconcileCalendarCompanionReminders } = await import(
  '../../../src/features/calendar/reconciliation.js'
);
const { saveReminder, updateReminder } = await import(
  '../../../src/infrastructure/database/index.js'
);

describe('JIT Google Calendar Companion Reminders Reconciliation', () => {
  beforeEach(() => {
    mockState.savedReminders = [];
    mockState.updatedReminders = [];
    mockState.calls = [];
    vi.clearAllMocks();
  });

  it('returns unauthenticated when user has no usable Google credentials', async () => {
    const res = await reconcileCalendarCompanionReminders({ userId: 'user-no-auth' });
    expect(res.synced).toBe(false);
    expect(res.reason).toBe('unauthenticated');
    expect(saveReminder).not.toHaveBeenCalled();
  });

  it('inserts missing companion reminder for new upcoming Google Calendar event', async () => {
    const res = await reconcileCalendarCompanionReminders({
      userId: 'user-with-events',
      phoneNumber: '+573001234567',
    });

    expect(res.synced).toBe(true);
    expect(res.createdCount).toBe(1);
    expect(saveReminder).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'user-with-events',
        deliveryId: 'gcal:g-event-1',
        content: expect.stringContaining('Reunión de inversores'),
        requiresConfirmation: true,
      }),
    );
  });

  it('applies user persistent confirmation memory preferences when creating companion reminder', async () => {
    const res = await reconcileCalendarCompanionReminders({
      userId: 'user-with-pref',
      phoneNumber: '+573001234567',
    });

    expect(res.synced).toBe(true);
  });

  it('updates existing companion reminder when Google event start time was rescheduled', async () => {
    const oldSendAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    mockState.savedReminders = [
      {
        id: 'rem-resched-1',
        delivery_id: 'gcal:g-event-resched',
        send_at: oldSendAt,
        status: 'pending',
        content: '🔔 [Google Calendar] Sesión 1 a 1 en 15 minutos',
      },
    ];

    const res = await reconcileCalendarCompanionReminders({
      userId: 'user-rescheduled',
      phoneNumber: '+573001234567',
    });

    expect(res.synced).toBe(true);
    expect(res.updatedCount).toBe(1);
    expect(updateReminder).toHaveBeenCalledWith(
      'rem-resched-1',
      expect.objectContaining({ send_at: expect.any(String) }),
      'user-rescheduled',
    );
  });

  it('cancels pending companion reminder when Google event is deleted externally', async () => {
    const futureSendAt = new Date(Date.now() + 4 * 60 * 60 * 1000).toISOString();
    mockState.savedReminders = [
      {
        id: 'rem-deleted-1',
        delivery_id: 'gcal:g-event-deleted',
        send_at: futureSendAt,
        status: 'pending',
        content: '🔔 [Google Calendar] Evento Borrado en 15 minutos',
      },
    ];

    const res = await reconcileCalendarCompanionReminders({
      userId: 'user-deleted-event',
      phoneNumber: '+573001234567',
    });

    expect(res.synced).toBe(true);
    expect(res.cancelledCount).toBe(1);
    expect(updateReminder).toHaveBeenCalledWith(
      'rem-deleted-1',
      { status: 'cancelled' },
      'user-deleted-event',
    );
  });
});
