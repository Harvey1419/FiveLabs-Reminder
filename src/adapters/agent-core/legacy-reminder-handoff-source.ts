import { z } from 'zod';
import type { TurnContext } from '@templelabs/contracts';
import { reminderRecordSchema } from '@templelabs/contracts';
import type { ReminderCheckpointClient } from './reminder-state-recovery.js';
import type { LegacyReminderHandoffSource } from './reminder-turn-resolution.js';
import { normalizeLegacyReminderRecord } from './legacy-reminders.js';

/** Host guards reuse authenticated thread mapping and existing active AgentRun lookup. */
export function createLegacyReminderHandoffSource(client: ReminderCheckpointClient,
  guards: Pick<LegacyReminderHandoffSource, 'ownsThread' | 'hasActiveRun'>): LegacyReminderHandoffSource {
  return { ...guards,
    async readOwnedReminder(id: string, context: TurnContext) {
      z.uuid().parse(id);
      context.signal.throwIfAborted();
      const { data, error } = await client.from('reminders')
        .select('id,user_id,content,send_at,recurrence_rule,source,parent_reminder_id,requires_confirmation,acknowledged_at')
        .eq('id', id).eq('user_id', context.userId).limit(1)
        .abortSignal(AbortSignal.any([context.signal, AbortSignal.timeout(15000)])).maybeSingle();
      if (error) throw Object.assign(new Error('Owned reminder unavailable'), { code: 'HANDOFF_STORAGE_UNAVAILABLE' });
      if (!data) return null;
      const row = z.object({ id: z.uuid(), user_id: z.string().min(1) }).passthrough().parse(data);
      if (row.id !== id || row.user_id !== context.userId) throw new Error('Owned reminder identity mismatch');
      return { userId: row.user_id, record: reminderRecordSchema.parse(normalizeLegacyReminderRecord(row)) };
    },
  };
}
