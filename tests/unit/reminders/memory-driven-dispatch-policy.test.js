import { beforeEach, describe, expect, it, vi } from 'vitest';

const from = vi.fn();

vi.mock('../../../src/infrastructure/database/index.js', () => ({
  supabase: { from },
}));

const { getReminderDispatchPolicy } = await import('../../../src/infrastructure/database/memories.js');

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

describe('getReminderDispatchPolicy - Multi-Tenant Memory-Driven Policy Evaluator', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns default policy with buttons enabled when user has no memories', async () => {
    from.mockReturnValue(createQueryChain([]));

    const policy = await getReminderDispatchPolicy('user-without-memories');

    expect(policy).toEqual({
      disableButtonsForRecurring: false,
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
    expect(policy.nudgeIntervalMinutes).toBe(20);
  });
});
