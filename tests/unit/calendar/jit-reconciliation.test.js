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
    saveMessage: vi.fn(async () => ({ id: 'msg-1' })),
  };
});

vi.mock('../../../src/integrations/whatsapp/kapso-client.js', () => ({
  sendWhatsAppText: vi.fn(async () => ({ success: true })),
}));

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
const { saveReminder, updateReminder, saveMessage } = await import(
  '../../../src/infrastructure/database/index.js'
);
const { sendWhatsAppText } = await import(
  '../../../src/integrations/whatsapp/kapso-client.js'
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

  it('dispatches proactive WhatsApp cancellation notification when notifyOnDiscovery is true and event is deleted', async () => {
    const futureSendAt = new Date(Date.now() + 4 * 60 * 60 * 1000).toISOString();
    mockState.savedReminders = [
      {
        id: 'rem-deleted-2',
        delivery_id: 'gcal:g-event-cancelled',
        send_at: futureSendAt,
        status: 'pending',
        content: '🔔 [Google Calendar] Reunión de Producto en 15 minutos',
      },
    ];

    const res = await reconcileCalendarCompanionReminders({
      userId: 'user-deleted-event',
      phoneNumber: '+573001234567',
      notifyOnDiscovery: true,
      language: 'es',
    });

    expect(res.synced).toBe(true);
    expect(res.cancelledCount).toBe(1);
    expect(updateReminder).toHaveBeenCalledWith(
      'rem-deleted-2',
      { status: 'cancelled' },
      'user-deleted-event',
    );
    expect(sendWhatsAppText).toHaveBeenCalledWith(
      expect.objectContaining({
        phoneNumber: '+573001234567',
        text: expect.stringContaining('Reunión cancelada en Google Calendar'),
      }),
    );
    expect(saveMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        role: 'assistant',
        entities: expect.objectContaining({
          action: 'proactive_meeting_cancellation',
          title: 'Reunión de Producto',
        }),
      }),
    );
  });

  it('dispatches proactive WhatsApp notification when notifyOnDiscovery is true', async () => {
    const res = await reconcileCalendarCompanionReminders({
      userId: 'user-with-events',
      phoneNumber: '+573001234567',
      notifyOnDiscovery: true,
      language: 'es',
    });

    expect(res.synced).toBe(true);
    expect(res.createdCount).toBe(1);
    expect(sendWhatsAppText).toHaveBeenCalledWith(
      expect.objectContaining({
        phoneNumber: '+573001234567',
        text: expect.stringContaining('Nueva reunión agendada en Google Calendar'),
      }),
    );
    expect(saveMessage).toHaveBeenCalled();
  });

  it('does not announce backfilled events that are outside the changed-event delta', async () => {
    const res = await reconcileCalendarCompanionReminders({
      userId: 'user-with-events',
      phoneNumber: '+573001234567',
      notifyOnDiscovery: true,
      notifyEventIds: ['some-other-event'],
      language: 'es',
    });

    expect(res.synced).toBe(true);
    expect(res.createdCount).toBe(1);
    expect(sendWhatsAppText).not.toHaveBeenCalled();
  });

  it('omits proactive notification when notifyOnDiscovery is false', async () => {
    const res = await reconcileCalendarCompanionReminders({
      userId: 'user-with-events',
      phoneNumber: '+573001234567',
      notifyOnDiscovery: false,
    });

    expect(res.synced).toBe(true);
    expect(res.createdCount).toBe(1);
    expect(sendWhatsAppText).not.toHaveBeenCalled();
  });

  it('cancels companion reminder beyond 48h horizon when explicitly in cancelledEventIds', async () => {
    // 5 days in the future (well beyond the 48-hour default horizon)
    const farFutureSendAt = new Date(Date.now() + 5 * 24 * 60 * 60 * 1000).toISOString();
    mockState.savedReminders = [
      {
        id: 'rem-far-future-1',
        delivery_id: 'gcal:g-event-far-cancelled',
        send_at: farFutureSendAt,
        status: 'pending',
        content: '🔔 [Google Calendar] Reunión de Estrategia en 15 minutos',
      },
    ];

    const res = await reconcileCalendarCompanionReminders({
      userId: 'user-deleted-event',
      phoneNumber: '+573001234567',
      notifyOnDiscovery: true,
      cancelledEventIds: ['g-event-far-cancelled'],
      language: 'es',
    });

    expect(res.synced).toBe(true);
    expect(res.cancelledCount).toBe(1);
    expect(updateReminder).toHaveBeenCalledWith(
      'rem-far-future-1',
      { status: 'cancelled' },
      'user-deleted-event',
    );
    expect(sendWhatsAppText).toHaveBeenCalledWith(
      expect.objectContaining({
        phoneNumber: '+573001234567',
        text: expect.stringContaining('Reunión cancelada en Google Calendar'),
      }),
    );
  });

  it('creates companion reminder and notifies for extraEvents from incremental delta', async () => {
    const futureMs = Date.now() + 5 * 24 * 60 * 60 * 1000;
    const extraEvent = {
      id: 'g-event-delta-1',
      summary: 'Demo con Cliente Internacional',
      start: { dateTime: new Date(futureMs).toISOString() },
      end: { dateTime: new Date(futureMs + 3600000).toISOString() },
    };

    const res = await reconcileCalendarCompanionReminders({
      userId: 'user-deleted-event', // returns empty rawEvents
      phoneNumber: '+573001234567',
      notifyOnDiscovery: true,
      notifyEventIds: ['g-event-delta-1'],
      extraEvents: [extraEvent],
      language: 'es',
    });

    expect(res.synced).toBe(true);
    expect(res.createdCount).toBe(1);
    expect(sendWhatsAppText).toHaveBeenCalledWith(
      expect.objectContaining({
        phoneNumber: '+573001234567',
        text: expect.stringContaining('Nueva reunión agendada en Google Calendar'),
      }),
    );
  });

  it('batches multiple new events into a single consolidated WhatsApp message listing each', async () => {
    const futureMs1 = Date.now() + 2 * 60 * 60 * 1000;
    const futureMs2 = Date.now() + 24 * 60 * 60 * 1000;
    const extraEvents = [
      {
        id: 'g-batch-1',
        summary: 'Daily Standup',
        start: { dateTime: new Date(futureMs1).toISOString() },
        end: { dateTime: new Date(futureMs1 + 1800000).toISOString() },
      },
      {
        id: 'g-batch-2',
        summary: 'Sprint Review',
        start: { dateTime: new Date(futureMs2).toISOString() },
        end: { dateTime: new Date(futureMs2 + 3600000).toISOString() },
      },
    ];

    const res = await reconcileCalendarCompanionReminders({
      userId: 'user-deleted-event',
      phoneNumber: '+573001234567',
      notifyOnDiscovery: true,
      notifyEventIds: ['g-batch-1', 'g-batch-2'],
      extraEvents,
      language: 'es',
    });

    expect(res.synced).toBe(true);
    expect(res.createdCount).toBe(2);
    expect(sendWhatsAppText).toHaveBeenCalledTimes(1);
    expect(sendWhatsAppText).toHaveBeenCalledWith(
      expect.objectContaining({
        phoneNumber: '+573001234567',
        text: expect.stringContaining('Nuevas reuniones agendadas en Google Calendar'),
      }),
    );
    expect(sendWhatsAppText).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining('Daily Standup'),
      }),
    );
    expect(sendWhatsAppText).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining('Sprint Review'),
      }),
    );
  });

  it('batches multiple cancelled events into a single consolidated WhatsApp message listing each', async () => {
    const futureSendAt1 = new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString();
    const futureSendAt2 = new Date(Date.now() + 6 * 60 * 60 * 1000).toISOString();
    mockState.savedReminders = [
      {
        id: 'rem-batch-cancel-1',
        delivery_id: 'gcal:g-cancel-1',
        send_at: futureSendAt1,
        status: 'pending',
        content: '🔔 [Google Calendar] One-on-One con Lider en 15 minutos',
      },
      {
        id: 'rem-batch-cancel-2',
        delivery_id: 'gcal:g-cancel-2',
        send_at: futureSendAt2,
        status: 'pending',
        content: '🔔 [Google Calendar] Retrospectiva de Equipo en 15 minutos',
      },
    ];

    const res = await reconcileCalendarCompanionReminders({
      userId: 'user-deleted-event',
      phoneNumber: '+573001234567',
      notifyOnDiscovery: true,
      cancelledEventIds: ['g-cancel-1', 'g-cancel-2'],
      language: 'es',
    });

    expect(res.synced).toBe(true);
    expect(res.cancelledCount).toBe(2);
    expect(sendWhatsAppText).toHaveBeenCalledTimes(1);
    expect(sendWhatsAppText).toHaveBeenCalledWith(
      expect.objectContaining({
        phoneNumber: '+573001234567',
        text: expect.stringContaining('Reuniones canceladas en Google Calendar'),
      }),
    );
    expect(sendWhatsAppText).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining('One-on-One con Lider'),
      }),
    );
    expect(sendWhatsAppText).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining('Retrospectiva de Equipo'),
      }),
    );
  });

  it('groups multiple instances of a recurring event into a single recurring series line', async () => {
    // 3 daily instances of "Daily Standup" within 48h horizon
    const futureMs1 = Date.now() + 2 * 60 * 60 * 1000;
    const futureMs2 = Date.now() + 20 * 60 * 60 * 1000;
    const futureMs3 = Date.now() + 40 * 60 * 60 * 1000;

    const extraEvents = [
      {
        id: 'g-recur-1',
        summary: 'Daily Standup',
        recurringEventId: 'series-standup',
        start: { dateTime: new Date(futureMs1).toISOString() },
        end: { dateTime: new Date(futureMs1 + 1800000).toISOString() },
      },
      {
        id: 'g-recur-2',
        summary: 'Daily Standup',
        recurringEventId: 'series-standup',
        start: { dateTime: new Date(futureMs2).toISOString() },
        end: { dateTime: new Date(futureMs2 + 1800000).toISOString() },
      },
      {
        id: 'g-recur-3',
        summary: 'Daily Standup',
        recurringEventId: 'series-standup',
        start: { dateTime: new Date(futureMs3).toISOString() },
        end: { dateTime: new Date(futureMs3 + 1800000).toISOString() },
      },
    ];

    const res = await reconcileCalendarCompanionReminders({
      userId: 'user-deleted-event',
      phoneNumber: '+573001234567',
      notifyOnDiscovery: true,
      notifyEventIds: ['g-recur-1', 'g-recur-2', 'g-recur-3'],
      extraEvents,
      language: 'es',
    });

    expect(res.synced).toBe(true);
    expect(res.createdCount).toBe(3);
    expect(sendWhatsAppText).toHaveBeenCalledTimes(1);
    expect(sendWhatsAppText).toHaveBeenCalledWith(
      expect.objectContaining({
        phoneNumber: '+573001234567',
        text: expect.stringMatching(/Daily Standup.*\(serie recurrente/i),
      }),
    );
  });

  it('groups multiple cancelled reminders of the same series into a single recurring line', async () => {
    const futureSendAt1 = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString();
    const futureSendAt2 = new Date(Date.now() + 26 * 60 * 60 * 1000).toISOString();
    mockState.savedReminders = [
      {
        id: 'rem-recur-cancel-1',
        delivery_id: 'gcal:g-recur-cancel-1',
        send_at: futureSendAt1,
        status: 'pending',
        content: '🔔 [Google Calendar] Daily Standup en 15 minutos',
      },
      {
        id: 'rem-recur-cancel-2',
        delivery_id: 'gcal:g-recur-cancel-2',
        send_at: futureSendAt2,
        status: 'pending',
        content: '🔔 [Google Calendar] Daily Standup en 15 minutos',
      },
    ];

    const res = await reconcileCalendarCompanionReminders({
      userId: 'user-deleted-event',
      phoneNumber: '+573001234567',
      notifyOnDiscovery: true,
      cancelledEventIds: ['g-recur-cancel-1', 'g-recur-cancel-2'],
      language: 'es',
    });

    expect(res.synced).toBe(true);
    expect(res.cancelledCount).toBe(2);
    expect(sendWhatsAppText).toHaveBeenCalledTimes(1);
    expect(sendWhatsAppText).toHaveBeenCalledWith(
      expect.objectContaining({
        phoneNumber: '+573001234567',
        text: expect.stringMatching(/Daily Standup.*\(serie recurrente/i),
      }),
    );
  });

  it('merges master recurring event and expanded instances into a single line without duplicate entries', async () => {
    const futureMs1 = Date.now() + 2 * 60 * 60 * 1000;
    const futureMs2 = Date.now() + 26 * 60 * 60 * 1000;

    const extraEvents = [
      {
        id: 'master-event-id',
        summary: 'Pausas Ergónomicas',
        start: { dateTime: new Date(futureMs1).toISOString() },
        end: { dateTime: new Date(futureMs1 + 1800000).toISOString() },
      },
      {
        id: 'instance-event-id',
        summary: 'Pausas Ergónomicas',
        recurringEventId: 'master-event-id',
        start: { dateTime: new Date(futureMs2).toISOString() },
        end: { dateTime: new Date(futureMs2 + 1800000).toISOString() },
      },
    ];

    await reconcileCalendarCompanionReminders({
      userId: 'user-deleted-event',
      phoneNumber: '+573001234567',
      notifyOnDiscovery: true,
      notifyEventIds: ['master-event-id', 'instance-event-id'],
      extraEvents,
      language: 'es',
    });

    expect(sendWhatsAppText).toHaveBeenCalledTimes(1);
    const text = sendWhatsAppText.mock.calls[0][0].text;
    const bulletMatches = text.match(/• \*Pausas Ergónomicas\*/g);
    expect(bulletMatches).toHaveLength(1);
    expect(text).toMatch(/• \*Pausas Ergónomicas\* \(serie recurrente — desde/i);
  });
});
