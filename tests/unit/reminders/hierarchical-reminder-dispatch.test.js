import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockSaveReminder = vi.fn();
const mockSupabase = {
  from: vi.fn(),
};
const mockGetReminderDispatchPolicy = vi.fn();
const mockSendReminderMessage = vi.fn();

vi.mock('../../../src/infrastructure/database/index.js', () => ({
  supabase: mockSupabase,
  saveReminder: (...args) => mockSaveReminder(...args),
  getRemindersByPhone: vi.fn().mockResolvedValue([]),
  cancelPendingRemindersByContent: vi.fn(),
  acknowledgeReminder: vi.fn(),
  acknowledgeReminders: vi.fn(),
  markReminderAsCancelled: vi.fn(),
  updateReminder: vi.fn(),
  createTask: vi.fn(),
  getUserSubscription: vi.fn().mockResolvedValue(null),
  hasProAccess: vi.fn().mockReturnValue(true),
  shouldEnforceBillingForUser: vi.fn().mockReturnValue(false),
  claimNextDueReminder: vi.fn().mockResolvedValue(null),
  getNextPendingReminder: vi.fn().mockResolvedValue(null),
  markReminderAsDispatched: vi.fn().mockResolvedValue({}),
  markReminderAsFailed: vi.fn(),
  markReminderAsMissed: vi.fn(),
  getRemindersDueForNudge: vi.fn().mockResolvedValue([]),
  incrementReminderNudge: vi.fn().mockResolvedValue({}),
  getLatestInboundPhoneNumberId: vi.fn().mockResolvedValue('phone-id-1'),
  saveMessage: vi.fn().mockResolvedValue({}),
  getReminderDispatchPolicy: (...args) => mockGetReminderDispatchPolicy(...args),
}));

vi.mock('../../../src/infrastructure/database/memories.js', () => ({
  getReminderDispatchPolicy: (...args) => mockGetReminderDispatchPolicy(...args),
  getReminderConfirmationPreference: vi.fn(),
}));

vi.mock('../../../src/integrations/whatsapp/kapso-client.js', () => ({
  sendReminderMessage: (...args) => mockSendReminderMessage(...args),
  stripReminderPrefix: (text) => text.replace(/^[🔔⏰]\s*/, ''),
}));

const { executeReminderCreate } = await import('../../../src/agent/tools/reminder-create.js');
const {
  checkAndDispatchNudges,
  processReminder,
} = await import('../../../src/jobs/reminder-scheduler.js');

describe('Hierarchical Reminder Dispatch and Dynamic Lifecycle Self-Healing', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('executeReminderCreate with Hierarchical Policy', () => {
    it('creates non-recurring reminder with confirmation, but recurring reminder without confirmation when recurring nudges are disabled', async () => {
      mockGetReminderDispatchPolicy.mockResolvedValue({
        global: {
          requiresConfirmation: true,
          nudgeIntervalMinutes: 10,
          disableButtons: false,
        },
        recurring: {
          requiresConfirmation: false,
          nudgeIntervalMinutes: 10,
          disableButtons: true,
          disableNudges: true,
        },
        disableButtonsForRecurring: true,
        disableNudgesForRecurring: true,
        requiresConfirmation: true,
        nudgeIntervalMinutes: 10,
      });

      mockSaveReminder.mockResolvedValue({ id: 'rem-created' });

      // 1. Non-recurring reminder
      await executeReminderCreate({
        params: {
          items: [{
            content: 'Comprar leche',
            targetTime: '2099-09-20T10:00:00-05:00',
          }],
        },
        user: { id: 'user-hierarchical', phone_number: '+573000000001', timezone: 'America/Bogota' },
        isPro: true,
        language: 'es',
      });

      expect(mockSaveReminder).toHaveBeenCalledWith(expect.objectContaining({
        content: 'Comprar leche',
        requiresConfirmation: true,
        nudgeIntervalMinutes: 10,
      }));

      mockSaveReminder.mockClear();

      // 2. Recurring reminder
      await executeReminderCreate({
        params: {
          items: [{
            content: 'Tomar vitaminas',
            targetTime: '2099-09-20T10:00:00-05:00',
            recurrence: 'daily',
          }],
        },
        user: { id: 'user-hierarchical', phone_number: '+573000000001', timezone: 'America/Bogota' },
        isPro: true,
        language: 'es',
      });

      expect(mockSaveReminder).toHaveBeenCalledWith(expect.objectContaining({
        content: 'Tomar vitaminas',
        recurrenceRule: 'daily',
        requiresConfirmation: false,
      }));
    });
  });

  describe('checkAndDispatchNudges Dynamic Self-Healing', () => {
    it('suppresses nudge and self-heals frozen requires_confirmation on recurring reminder when policy disables nudges', async () => {
      mockGetReminderDispatchPolicy.mockResolvedValue({
        recurring: { disableNudges: true },
        disableNudgesForRecurring: true,
      });

      const updateEq = vi.fn().mockResolvedValue({ data: null, error: null });
      const updateFn = vi.fn().mockReturnValue({ eq: updateEq });

      const dueItem = {
        id: 'rem-recurring-frozen',
        user_id: 'user-hierarchical',
        phone_number: '+573000000001',
        content: 'Me amo mucho',
        recurrence_rule: 'daily',
        requires_confirmation: true,
        nudge_count: 1,
        last_nudged_at: new Date(Date.now() - 30 * 60 * 1000).toISOString(),
        send_at: new Date(Date.now() - 30 * 60 * 1000).toISOString(),
      };

      const selectChain = {
        eq: vi.fn(() => selectChain),
        not: vi.fn(() => selectChain),
        is: vi.fn(() => selectChain),
        limit: vi.fn(() => selectChain),
        order: vi.fn(() => selectChain),
        then: (resolve) => Promise.resolve({
          data: [dueItem],
          error: null,
        }).then(resolve),
      };

      mockSupabase.from.mockImplementation((table) => {
        if (table === 'reminders') {
          return {
            select: vi.fn(() => selectChain),
            update: updateFn,
          };
        }
        return {};
      });

      await checkAndDispatchNudges();

      // Nudge message should NOT be sent
      expect(mockSendReminderMessage).not.toHaveBeenCalled();

      // Database should be healed
      expect(updateFn).toHaveBeenCalledWith(expect.objectContaining({
        requires_confirmation: false,
        nudge_count: 0,
        last_nudged_at: null,
      }));
      expect(updateEq).toHaveBeenCalledWith('id', 'rem-recurring-frozen');
    });
  });

  describe('processReminder with Policy Suppression', () => {
    it('dispatches recurring reminder without buttons and updates in-place with requires_confirmation: false', async () => {
      mockGetReminderDispatchPolicy.mockResolvedValue({
        disableButtonsForRecurring: true,
        disableNudgesForRecurring: true,
        recurring: { disableButtons: true, disableNudges: true },
      });

      mockSendReminderMessage.mockResolvedValue({
        success: true,
        messageId: 'wamid-disp-123',
      });

      const updateSelect = vi.fn().mockReturnValue({
        maybeSingle: vi.fn().mockResolvedValue({
          data: {
            id: 'rem-recurring-1',
            send_at: '2026-09-18T13:00:00.000Z',
            recurrence_rule: 'daily',
            status: 'pending',
          },
          error: null,
        }),
      });
      const updateEq = vi.fn().mockReturnValue({ select: updateSelect });
      const updateFn = vi.fn().mockReturnValue({ eq: updateEq });
      mockSupabase.from.mockImplementation(() => ({
        update: updateFn,
      }));

      const reminder = {
        id: 'rem-recurring-1',
        user_id: 'user-hierarchical',
        phone_number: '+573000000001',
        content: 'Me amo mucho',
        recurrence_rule: 'daily',
        requires_confirmation: true,
        send_at: new Date().toISOString(),
      };

      await processReminder(reminder);

      // Buttons should be suppressed
      expect(mockSendReminderMessage).toHaveBeenCalledWith(
        '+573000000001',
        'Me amo mucho',
        expect.not.objectContaining({ buttons: expect.anything() }),
      );

      // Advance in-place should have updated requires_confirmation to false and last_nudged_at to null
      expect(updateFn).toHaveBeenCalledWith(expect.objectContaining({
        requires_confirmation: false,
        last_nudged_at: null,
      }));
    });
  });
});
