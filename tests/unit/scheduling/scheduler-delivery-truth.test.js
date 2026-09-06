import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/infrastructure/database/index.js', () => ({
  claimNextDueReminder: vi.fn(),
  getNextPendingReminder: vi.fn(),
  markReminderAsDispatched: vi.fn(),
  markReminderAsFailed: vi.fn(),
  markReminderAsMissed: vi.fn(),
  saveReminder: vi.fn(),
  getRemindersDueForNudge: vi.fn().mockResolvedValue([]),
  incrementReminderNudge: vi.fn(),
  getLatestInboundPhoneNumberId: vi.fn(),
  supabase: { from: vi.fn() },
}));

vi.mock('../../../src/integrations/whatsapp/kapso-client.js', () => ({
  sendReminderMessage: vi.fn(),
  sendReminderConfirmation: vi.fn(),
  stripReminderPrefix: vi.fn((content) => content),
}));

vi.mock('../../../src/agent/core/working-memory.js', () => ({
  saveWorkingMemory: vi.fn(),
}));

const {
  getLatestInboundPhoneNumberId,
  markReminderAsDispatched,
  markReminderAsFailed,
} = await import('../../../src/infrastructure/database/index.js');
const { sendReminderMessage } = await import('../../../src/integrations/whatsapp/kapso-client.js');
const { processReminder } = await import('../../../src/jobs/reminder-scheduler.js');

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

describe('scheduler delivery truth', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getLatestInboundPhoneNumberId.mockResolvedValue('597907523413541');
  });

  it('persists the real provider message id', async () => {
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
    expect(markReminderAsFailed).not.toHaveBeenCalled();
  });

  it('does not report a reminder as sent when Kapso rejects the dispatch', async () => {
    sendReminderMessage.mockResolvedValue({
      success: false,
      error: 'wrong WhatsApp sender',
    });

    await processReminder(dueReminder());

    expect(markReminderAsDispatched).not.toHaveBeenCalled();
    expect(markReminderAsFailed).toHaveBeenCalledWith('reminder-1');
  });
});
