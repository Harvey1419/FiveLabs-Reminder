import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockFrom = vi.fn();
const mockGenerateEmbedding = vi.fn().mockResolvedValue([0.1, 0.2]);

vi.mock('../../../src/infrastructure/database/index.js', () => ({
  supabase: {
    from: (...args) => mockFrom(...args),
  },
}));

vi.mock('../../../src/integrations/ai/embeddings.js', () => ({
  generateEmbedding: (...args) => mockGenerateEmbedding(...args),
}));

const {
  isReminderPolicyMemory,
  reconcileRemindersWithPolicy,
  triggerEagerReminderReconciliation,
  saveMemory,
} = await import('../../../src/infrastructure/database/memories.js');

function createFluentChain(resolveData = []) {
  const chain = {
    select: vi.fn(() => chain),
    insert: vi.fn(() => chain),
    update: vi.fn(() => chain),
    eq: vi.fn(() => chain),
    not: vi.fn(() => chain),
    is: vi.fn(() => chain),
    neq: vi.fn(() => chain),
    order: vi.fn(() => chain),
    limit: vi.fn(() => chain),
    single: vi.fn(() => Promise.resolve({ data: resolveData[0] || null, error: null })),
    then: (resolve) => Promise.resolve({ data: resolveData, error: null }).then(resolve),
  };
  return chain;
}

describe('Eager Memory-to-Reminder Reconciliation Architecture', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('isReminderPolicyMemory Domain Gate', () => {
    it('accurately identifies memories that impact reminder dispatch policy', () => {
      // Positive cases: topic matches
      expect(isReminderPolicyMemory({ topic_key: 'preference/reminders/recurring_nudges' })).toBe(true);
      expect(isReminderPolicyMemory({ topic_key: 'preference/reminders/confirmation_buttons' })).toBe(true);
      expect(isReminderPolicyMemory({ topic_key: 'preference/reminders/persistent_confirmation' })).toBe(true);
      expect(isReminderPolicyMemory({ topic_key: 'recurring_tasks_nudge' })).toBe(true);

      // Positive cases: content matches
      expect(isReminderPolicyMemory({ content: 'Los recordatorios recurrentes no deben generar avisos pendientes' })).toBe(true);
      expect(isReminderPolicyMemory({ content: 'Todo recordatorio me avise 10 minutos despues para confirmarlo' })).toBe(true);
      expect(isReminderPolicyMemory({ content: 'No poner botones en los recordatorios de rutina' })).toBe(true);
      expect(isReminderPolicyMemory({ content: 'Desactivar avisos para recordatorios diarios' })).toBe(true);

      // Negative cases: unrelated profile, preference, or fact memories
      expect(isReminderPolicyMemory(null)).toBe(false);
      expect(isReminderPolicyMemory({})).toBe(false);
      expect(isReminderPolicyMemory({ topic_key: 'profile/residence', content: 'Vivo en Barranquilla' })).toBe(false);
      expect(isReminderPolicyMemory({ topic_key: 'preference/coffee', content: 'Prefiero el café amargo sin azúcar' })).toBe(false);
      expect(isReminderPolicyMemory({ topic_key: 'company/client', content: 'El cliente es Cerámica Italia' })).toBe(false);
      expect(isReminderPolicyMemory({ topic_key: 'fact/dog', content: 'Mi perro se llama Barón' })).toBe(false);
    });
  });

  describe('reconcileRemindersWithPolicy', () => {
    it('eagerly heals pending recurring reminders when policy suppresses recurring nudges', async () => {
      const memoryChain = createFluentChain([
        {
          id: 'mem-1',
          user_id: 'user-eager-1',
          topic_key: 'preference/reminders/recurring_nudges',
          content: 'Los recordatorios recurrentes no deben generar avisos pendientes',
          category: 'preference',
          is_active: true,
        },
      ]);

      const reminderChain = createFluentChain([{ id: 'rem-1' }, { id: 'rem-2' }]);

      mockFrom.mockImplementation((table) => {
        if (table === 'memories') return memoryChain;
        if (table === 'reminders') return reminderChain;
        return createFluentChain([]);
      });

      const result = await reconcileRemindersWithPolicy('user-eager-1');

      expect(result.updatedCount).toBeGreaterThanOrEqual(2);
      expect(reminderChain.update).toHaveBeenCalledWith(expect.objectContaining({
        requires_confirmation: false,
        nudge_count: 0,
        last_nudged_at: null,
      }));
    });
  });

  describe('saveMemory non-blocking domain-gated eager trigger', () => {
    it('does not trigger reconciliation when saving an unrelated preference (e.g. coffee)', async () => {
      let remindersAccessed = false;
      const coffeeMemory = {
        id: 'mem-coffee-1',
        user_id: 'user-coffee',
        topic_key: 'preference/coffee',
        content: 'Prefiero café amargo',
        category: 'preference',
        is_active: true,
      };

      const memoryChain = createFluentChain([coffeeMemory]);

      mockFrom.mockImplementation((table) => {
        if (table === 'memories') return memoryChain;
        if (table === 'reminders') {
          remindersAccessed = true;
          return createFluentChain([]);
        }
        return createFluentChain([]);
      });

      await saveMemory({
        userId: 'user-coffee',
        topicKey: 'preference/coffee',
        category: 'preference',
        content: 'Prefiero café amargo',
      });

      // Wait a tick for any setImmediate to fire
      await new Promise((resolve) => setImmediate(resolve));

      // Reminders table must NEVER be queried or updated for an unrelated memory!
      expect(remindersAccessed).toBe(false);
    });

    it('triggers eager reconciliation in background when saving a reminder preference', async () => {
      let remindersAccessed = false;
      const reminderPrefMemory = {
        id: 'mem-pref-1',
        user_id: 'user-pref',
        topic_key: 'preference/reminders/recurring_nudges',
        content: 'Los recordatorios recurrentes no deben generar avisos pendientes',
        category: 'preference',
        is_active: true,
      };

      const memoryChain = createFluentChain([reminderPrefMemory]);

      mockFrom.mockImplementation((table) => {
        if (table === 'memories') return memoryChain;
        if (table === 'reminders') {
          remindersAccessed = true;
          return createFluentChain([]);
        }
        return createFluentChain([]);
      });

      await saveMemory({
        userId: 'user-pref',
        topicKey: 'preference/reminders/recurring_nudges',
        category: 'preference',
        content: 'Los recordatorios recurrentes no deben generar avisos pendientes',
      });

      // Wait a tick for setImmediate to execute
      await new Promise((resolve) => setImmediate(resolve));

      // Reminders table SHOULD be eagerly accessed to reconcile!
      expect(remindersAccessed).toBe(true);
    });
  });
});
