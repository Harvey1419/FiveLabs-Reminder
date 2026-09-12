import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/infrastructure/database/index.js', () => ({
  claimNextDueReminder: vi.fn(),
  getNextPendingReminder: vi.fn(),
  markReminderAsDispatched: vi.fn(),
  markReminderAsFailed: vi.fn(),
  markReminderAsMissed: vi.fn(),
  getRemindersDueForNudge: vi.fn().mockResolvedValue([]),
  incrementReminderNudge: vi.fn(),
  getLatestInboundPhoneNumberId: vi.fn(),
  saveMessage: vi.fn().mockResolvedValue({ id: 'msg-1' }),
  supabase: { from: vi.fn() },
}));

vi.mock('../../../src/integrations/whatsapp/kapso-client.js', () => ({
  sendReminderMessage: vi.fn(),
  stripReminderPrefix: vi.fn((content) => content),
}));

vi.mock('../../../src/agent/core/working-memory.js', () => ({
  saveWorkingMemory: vi.fn(),
}));

const {
  getLatestInboundPhoneNumberId,
  markReminderAsDispatched,
  markReminderAsFailed,
  saveMessage,
  getRemindersDueForNudge,
  incrementReminderNudge,
  supabase,
} = await import('../../../src/infrastructure/database/index.js');
const { sendReminderMessage } = await import('../../../src/integrations/whatsapp/kapso-client.js');
const { processReminder, checkAndDispatchNudges } = await import('../../../src/jobs/reminder-scheduler.js');

function dueReminder(overrides = {}) {
  return {
    id: 'reminder-1',
    user_id: 'user-1',
    phone_number: '19164158325',
    content: 'Tenemos que irnos',
    send_at: new Date(Date.now() - 1000).toISOString(),
    created_at: new Date(Date.now() - 60_000).toISOString(),
    recurrence_rule: null,
    requires_confirmation: false,
    ...overrides,
  };
}

function mockRecurringAdvance() {
  let capturedUpdates = null;
  let capturedId = null;
  const chain = {
    update: vi.fn((updates) => {
      capturedUpdates = updates;
      return chain;
    }),
    eq: vi.fn((field, value) => {
      if (field === 'id') capturedId = value;
      return chain;
    }),
    select: vi.fn(() => chain),
    maybeSingle: vi.fn(async () => ({
      data: {
        id: capturedId,
        send_at: capturedUpdates?.send_at,
        recurrence_rule: 'daily',
        status: capturedUpdates?.status,
        sent_at: capturedUpdates?.sent_at || null,
        acknowledged_at: capturedUpdates?.acknowledged_at ?? null,
        delivery_id: capturedUpdates?.delivery_id ?? null,
      },
      error: null,
    })),
  };
  supabase.from.mockReturnValue(chain);
  return { chain, getUpdates: () => capturedUpdates, getId: () => capturedId };
}

describe('scheduler delivery truth', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getLatestInboundPhoneNumberId.mockResolvedValue('597907523413541');
    const defaultChain = {
      select: vi.fn(() => defaultChain),
      eq: vi.fn(() => defaultChain),
      neq: vi.fn(() => defaultChain),
      not: vi.fn(() => defaultChain),
      is: vi.fn(() => defaultChain),
      limit: vi.fn(async () => ({ data: [], error: null })),
    };
    supabase.from.mockReturnValue(defaultChain);
  });

  it('persists the real provider message id for a one-time reminder', async () => {
    sendReminderMessage.mockResolvedValue({
      success: true,
      messageId: 'wamid.ACTUAL_PROVIDER_ID',
    });

    await processReminder(dueReminder());

    expect(sendReminderMessage).toHaveBeenCalledWith(
      '19164158325',
      'Tenemos que irnos',
      { phoneNumberId: '597907523413541' },
    );
    expect(markReminderAsDispatched).toHaveBeenCalledWith('reminder-1', {
      deliveryId: 'wamid.ACTUAL_PROVIDER_ID',
    });
    expect(saveMessage).toHaveBeenCalledWith(expect.objectContaining({
      userId: 'user-1',
      phoneNumber: '19164158325',
      role: 'assistant',
      content: 'Tenemos que irnos',
      messageId: 'wamid.ACTUAL_PROVIDER_ID',
      entities: expect.objectContaining({
        _workingMemory: expect.objectContaining({
          notificationReminderId: 'reminder-1',
          lastAction: 'reminder_dispatched',
        }),
      }),
    }));
    expect(markReminderAsFailed).not.toHaveBeenCalled();
  });

  it('does not report a one-time reminder as sent when Kapso rejects the dispatch', async () => {
    sendReminderMessage.mockResolvedValue({
      success: false,
      error: 'wrong WhatsApp sender',
    });

    await processReminder(dueReminder());

    expect(markReminderAsDispatched).not.toHaveBeenCalled();
    expect(markReminderAsFailed).toHaveBeenCalledWith('reminder-1');
  });

  it('advances a recurring reminder in-place, preserves its UUID and keeps the latest delivery id', async () => {
    const db = mockRecurringAdvance();
    sendReminderMessage.mockResolvedValue({ success: true, messageId: 'wamid.RECURRING' });

    await processReminder(dueReminder({ recurrence_rule: 'daily' }));

    expect(db.getId()).toBe('reminder-1');
    expect(db.getUpdates()).toMatchObject({
      status: 'pending',
      delivery_id: 'wamid.RECURRING',
      acknowledged_at: null,
      nudge_count: 0,
    });
    expect(new Date(db.getUpdates().send_at).getTime()).toBeGreaterThan(Date.now());
    expect(markReminderAsDispatched).not.toHaveBeenCalled();
    expect(markReminderAsFailed).not.toHaveBeenCalled();
  });

  it('keeps confirmation/nudge lifecycle on the same recurring UUID', async () => {
    const db = mockRecurringAdvance();
    sendReminderMessage.mockResolvedValue({ success: true, messageId: 'wamid.RECURRING_CONFIRM' });

    await processReminder(dueReminder({
      recurrence_rule: 'daily',
      requires_confirmation: true,
      nudge_interval_minutes: 10,
      max_nudges: 3,
    }));

    expect(db.getId()).toBe('reminder-1');
    expect(db.getUpdates().status).toBe('pending');
    expect(db.getUpdates().delivery_id).toBe('wamid.RECURRING_CONFIRM');
    expect(db.getUpdates().last_nudged_at).toBeTruthy();
    expect(db.getUpdates().acknowledged_at).toBeNull();
    expect(db.getUpdates().nudge_count).toBe(0);
    expect(markReminderAsDispatched).not.toHaveBeenCalled();
  });

  it('persists assistant message and working memory when sending a nudge', async () => {
    getRemindersDueForNudge.mockResolvedValueOnce([
      dueReminder({
        id: 'reminder-nudge-1',
        content: 'Me amo mucho',
        requires_confirmation: true,
        nudge_count: 0,
      }),
    ]);
    sendReminderMessage.mockResolvedValueOnce({
      success: true,
      messageId: 'wamid.NUDGE_MSG_ID',
    });

    await checkAndDispatchNudges();

    expect(sendReminderMessage).toHaveBeenCalledWith(
      '19164158325',
      expect.stringContaining('Me amo mucho'),
      expect.any(Object),
    );
    expect(incrementReminderNudge).toHaveBeenCalledWith('reminder-nudge-1', 1);
    expect(saveMessage).toHaveBeenCalledWith(expect.objectContaining({
      userId: 'user-1',
      phoneNumber: '19164158325',
      role: 'assistant',
      content: expect.stringContaining('Me amo mucho'),
      messageId: 'wamid.NUDGE_MSG_ID',
      entities: expect.objectContaining({
        _workingMemory: expect.objectContaining({
          notificationReminderId: 'reminder-nudge-1',
          lastAction: 'nudge',
          notificationContent: 'Me amo mucho',
        }),
      }),
    }));
  });
});
