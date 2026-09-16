import { beforeEach, describe, expect, it, vi } from 'vitest';

const from = vi.fn();

vi.mock('../../../src/infrastructure/database/index.js', () => ({
  supabase: { from },
}));

const {
  getReminderDispatchPolicy,
  getReminderConfirmationPreference,
} = await import('../../../src/infrastructure/database/memories.js');

function createQueryChain(resolveData = []) {
  const chain = {
    select: vi.fn(() => chain),
    eq: vi.fn(() => chain),
    order: vi.fn(() => chain),
    limit: vi.fn(() => chain),
    then: (resolve) => Promise.resolve({ data: resolveData, error: null }).then(resolve),
  };
  return chain;
}

describe('getReminderDispatchPolicy - Multi-Tenant Hierarchical Policy Evaluator', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns default policy with buttons and nudges enabled when user has no memories', async () => {
    from.mockReturnValue(createQueryChain([]));

    const policy = await getReminderDispatchPolicy('user-without-memories');

    expect(policy).toEqual({
      global: {
        requiresConfirmation: false,
        nudgeIntervalMinutes: 15,
        disableButtons: false,
      },
      recurring: {
        requiresConfirmation: false,
        nudgeIntervalMinutes: 15,
        disableButtons: false,
        disableNudges: false,
      },
      disableButtonsForRecurring: false,
      disableNudgesForRecurring: false,
      requiresConfirmation: false,
      nudgeIntervalMinutes: 15,
      preferenceText: null,
    });
  });

  it('detects user preference to disable buttons on recurring reminders', async () => {
    from.mockReturnValue(createQueryChain([
      {
        id: 'mem-1',
        user_id: 'user-with-suppression',
        topic_key: 'preference/reminders/confirmation_buttons',
        content: 'Los recordatorios recurrentes no deben incluir botones de confirmación',
        category: 'preference',
        is_active: true,
      },
    ]));

    const policy = await getReminderDispatchPolicy('user-with-suppression');

    expect(policy.disableButtonsForRecurring).toBe(true);
    expect(policy.recurring.disableButtons).toBe(true);
    expect(policy.requiresConfirmation).toBe(false);
    expect(policy.preferenceText).toBe('Los recordatorios recurrentes no deben incluir botones de confirmación');
  });

  it('correctly isolates policies between different users (multi-tenant safety)', async () => {
    from.mockImplementation(() => {
      let targetUser = null;
      const chain = {
        select: vi.fn(() => chain),
        eq: vi.fn((field, val) => {
          if (field === 'user_id') targetUser = val;
          return chain;
        }),
        order: vi.fn(() => chain),
        limit: vi.fn(() => chain),
        then: (resolve) => {
          const memories = targetUser === 'user-juan'
            ? [{
                id: 'mem-juan',
                user_id: 'user-juan',
                topic_key: 'preference/reminders/confirmation_buttons',
                content: 'No quiero botones en los recordatorios recurrentes',
                category: 'preference',
                is_active: true,
              }]
            : [];
          return Promise.resolve({ data: memories, error: null }).then(resolve);
        },
      };
      return chain;
    });

    const juanPolicy = await getReminderDispatchPolicy('user-juan');
    const otherPolicy = await getReminderDispatchPolicy('user-other');

    expect(juanPolicy.disableButtonsForRecurring).toBe(true);
    expect(otherPolicy.disableButtonsForRecurring).toBe(false);
  });

  it('handles persistent confirmation preferences without confusing them with button suppression', async () => {
    from.mockReturnValue(createQueryChain([
      {
        id: 'mem-confirm',
        user_id: 'user-confirm',
        topic_key: 'preference/reminders/persistent_confirmation',
        content: 'Pedir confirmación en recordatorios cada 20 minutos hasta que responda',
        category: 'preference',
        is_active: true,
      },
    ]));

    const policy = await getReminderDispatchPolicy('user-confirm');

    expect(policy.disableButtonsForRecurring).toBe(false);
    expect(policy.requiresConfirmation).toBe(true);
    expect(policy.global.requiresConfirmation).toBe(true);
    expect(policy.nudgeIntervalMinutes).toBe(20);
  });

  it('resolves hierarchical conflict: specific recurring nudge suppression overrides global confirmation', async () => {
    // Exact scenario reported by user:
    // Memory 1 (global): "Todo recordatorio me avise 10 minutos despues para confirmarlo"
    // Memory 2 (specific): "Los recordatorios recurrentes no deben generar avisos pendientes"
    // Memory 3 (specific): "Los recordatorios recurrentes no deben incluir botones de confirmación"
    from.mockReturnValue(createQueryChain([
      {
        id: 'mem-global-confirm',
        user_id: 'user-hierarchical',
        topic_key: 'preference/reminders/persistent_confirmation',
        content: 'Todo recordatorio me avise 10 minutos despues para confirmarlo',
        category: 'preference',
        is_active: true,
      },
      {
        id: 'mem-recurring-no-nudge',
        user_id: 'user-hierarchical',
        topic_key: 'preference/reminders/recurring_nudges',
        content: 'Los recordatorios recurrentes no deben generar avisos pendientes',
        category: 'preference',
        is_active: true,
      },
      {
        id: 'mem-recurring-no-buttons',
        user_id: 'user-hierarchical',
        topic_key: 'preference/reminders/confirmation_buttons',
        content: 'Los recordatorios recurrentes no deben incluir botones de confirmación',
        category: 'preference',
        is_active: true,
      },
    ]));

    const policy = await getReminderDispatchPolicy('user-hierarchical');

    // Global policy: confirmation enabled at 10 minutes
    expect(policy.global.requiresConfirmation).toBe(true);
    expect(policy.global.nudgeIntervalMinutes).toBe(10);
    expect(policy.global.disableButtons).toBe(false);

    // Recurring policy: specific override disables nudges and buttons
    expect(policy.recurring.requiresConfirmation).toBe(false);
    expect(policy.recurring.disableNudges).toBe(true);
    expect(policy.recurring.disableButtons).toBe(true);
    expect(policy.disableNudgesForRecurring).toBe(true);
    expect(policy.disableButtonsForRecurring).toBe(true);

    // Helper getReminderConfirmationPreference respects the scope:
    const recurringPref = await getReminderConfirmationPreference('user-hierarchical', { isRecurring: true });
    expect(recurringPref).toBeNull();

    const nonRecurringPref = await getReminderConfirmationPreference('user-hierarchical', { isRecurring: false });
    expect(nonRecurringPref).toEqual({
      requiresConfirmation: true,
      nudgeIntervalMinutes: 10,
      preferenceText: expect.any(String),
    });
  });
});
