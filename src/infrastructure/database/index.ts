import type { ReminderClient } from './reminder-persistence-client.js';
import type { DatabaseClientOptions } from './database-client.js';
const supabasePackage = '@supabase/supabase-js';
const { createClient } = await import(supabasePackage) as { createClient(url: string, secret: string, options: DatabaseClientOptions): ReminderClient };
import { isStrictUUID } from '../../shared/entity-resolution.js';
import { createReminderPersistence } from './reminder-persistence.js';
import { createReminderDeliveryPersistence } from './reminder-delivery-persistence.js';
import { createReminderOverview } from './reminder-overview.js';
import { formatLocalDateTime } from '../../shared/time.js';
import { assertTurnLease, currentTurnSignal } from '../../agent/core/turn-lease.js';
import { createDatabaseClient } from './database-client.js';

const supabase = createDatabaseClient({
  getEnvironment: () => process.env,
  createClient,
  currentTurnSignal,
  fetch: (...args) => fetch(...args),
});

const dependencies = { getClient: () => supabase, getNow: () => new Date(), getNowMs: () => Date.now(), assertTurnLease, isStrictUUID, formatLocalDateTime, logger: console };
const persistence = createReminderPersistence(dependencies);
const delivery = createReminderDeliveryPersistence(dependencies);
const overview = createReminderOverview(dependencies);

export function saveReminder(...args: Parameters<typeof persistence.saveReminder>) { return persistence.saveReminder(...args); }
export function acknowledgeReminders(...args: Parameters<typeof persistence.acknowledgeReminders>) { return persistence.acknowledgeReminders(...args); }
export function acknowledgeReminder(...args: Parameters<typeof persistence.acknowledgeReminder>) { return persistence.acknowledgeReminder(...args); }
export function getRemindersDueForNudge(...args: Parameters<typeof delivery.getRemindersDueForNudge>) { return delivery.getRemindersDueForNudge(...args); }
export function incrementReminderNudge(...args: Parameters<typeof delivery.incrementReminderNudge>) { return delivery.incrementReminderNudge(...args); }
export function getDueReminders(...args: Parameters<typeof delivery.getDueReminders>) { return delivery.getDueReminders(...args); }
export function getRemindersByPhone(...args: Parameters<typeof persistence.getRemindersByPhone>) { return persistence.getRemindersByPhone(...args); }
export function markReminderAsSent(...args: Parameters<typeof delivery.markReminderAsSent>) { return delivery.markReminderAsSent(...args); }
export function markReminderAsDispatched(...args: Parameters<typeof delivery.markReminderAsDispatched>) { return delivery.markReminderAsDispatched(...args); }
export function markReminderAsFailed(...args: Parameters<typeof delivery.markReminderAsFailed>) { return delivery.markReminderAsFailed(...args); }
export function updateReminderDeliveryStatus(...args: Parameters<typeof delivery.updateReminderDeliveryStatus>) { return delivery.updateReminderDeliveryStatus(...args); }
export function markReminderAsMissed(...args: Parameters<typeof delivery.markReminderAsMissed>) { return delivery.markReminderAsMissed(...args); }
export function markReminderAsCancelled(...args: Parameters<typeof persistence.markReminderAsCancelled>) { return persistence.markReminderAsCancelled(...args); }
export function updateReminder(...args: Parameters<typeof persistence.updateReminder>) { return persistence.updateReminder(...args); }
export function cancelReminders(...args: Parameters<typeof persistence.cancelReminders>) { return persistence.cancelReminders(...args); }
export function isReminderAwaitingAcknowledgement(...args: Parameters<typeof overview.isReminderAwaitingAcknowledgement>) { return overview.isReminderAwaitingAcknowledgement(...args); }
export function getDailyOverview(...args: Parameters<typeof overview.getDailyOverview>) { return overview.getDailyOverview(...args); }
export function getRecentRemindersForPhone(...args: Parameters<typeof overview.getRecentRemindersForPhone>) { return overview.getRecentRemindersForPhone(...args); }
export function claimNextDueReminder(...args: Parameters<typeof delivery.claimNextDueReminder>) { return delivery.claimNextDueReminder(...args); }
export function getNextPendingReminder(...args: Parameters<typeof delivery.getNextPendingReminder>) { return delivery.getNextPendingReminder(...args); }
export function cancelCalendarCompanionReminders(...args: Parameters<typeof persistence.cancelCalendarCompanionReminders>) { return persistence.cancelCalendarCompanionReminders(...args); }
export function rescheduleCalendarCompanionReminders(...args: Parameters<typeof persistence.rescheduleCalendarCompanionReminders>) { return persistence.rescheduleCalendarCompanionReminders(...args); }
export function acknowledgeRemindersByTaskId(...args: Parameters<typeof persistence.acknowledgeRemindersByTaskId>) { return persistence.acknowledgeRemindersByTaskId(...args); }
export function cancelRemindersByTaskId(...args: Parameters<typeof persistence.cancelRemindersByTaskId>) { return persistence.cancelRemindersByTaskId(...args); }
export function rescheduleRemindersByTaskId(...args: Parameters<typeof persistence.rescheduleRemindersByTaskId>) { return persistence.rescheduleRemindersByTaskId(...args); }
export const cancelPendingRemindersByContent = cancelReminders;

export { supabase };
export * from './users.js';
export * from './tasks.js';
export * from './entities.js';
export * from './projects.js';
export * from './memories.js';
export * from './subscriptions.js';
export * from './integrations.js';
export * from './messages.js';
export * from './agent-runs.js';


