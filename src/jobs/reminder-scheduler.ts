import {
  claimNextDueReminder,
  getNextPendingReminder,
  markReminderAsDispatched,
  markReminderAsFailed,
  markReminderAsMissed,
  getRemindersDueForNudge,
  incrementReminderNudge,
  getLatestInboundPhoneNumberId,
  saveMessage,
  supabase,
  getReminderDispatchPolicy,
} from '../infrastructure/database/index.js';
import { sendReminderMessage, stripReminderPrefix } from '../integrations/whatsapp/kapso-client.js';
import { saveWorkingMemory } from '../agent/core/working-memory.js';
import { computeNextRecurringSendAt } from '../shared/reminder-recurrence.js';
import { detectLocaleFromPhone } from '../shared/time.js';
import { isAdvanceNoticeContent } from '../agent/tools/reminder-advance.js';

import { createReminderScheduler } from './reminder-scheduler-core.js';

const worker = createReminderScheduler({
  claimNextDueReminder: ((...args: Parameters<typeof claimNextDueReminder>) => claimNextDueReminder(...args)) as unknown as Parameters<typeof createReminderScheduler>[0]['claimNextDueReminder'],
  getNextPendingReminder: ((...args: Parameters<typeof getNextPendingReminder>) => getNextPendingReminder(...args)) as unknown as Parameters<typeof createReminderScheduler>[0]['getNextPendingReminder'],
  markReminderAsDispatched: ((...args: Parameters<typeof markReminderAsDispatched>) => markReminderAsDispatched(...args)) as unknown as Parameters<typeof createReminderScheduler>[0]['markReminderAsDispatched'],
  markReminderAsFailed: ((...args: Parameters<typeof markReminderAsFailed>) => markReminderAsFailed(...args)) as unknown as Parameters<typeof createReminderScheduler>[0]['markReminderAsFailed'],
  markReminderAsMissed: ((...args: Parameters<typeof markReminderAsMissed>) => markReminderAsMissed(...args)) as unknown as Parameters<typeof createReminderScheduler>[0]['markReminderAsMissed'],
  getRemindersDueForNudge: ((...args: Parameters<typeof getRemindersDueForNudge>) => getRemindersDueForNudge(...args)) as unknown as Parameters<typeof createReminderScheduler>[0]['getRemindersDueForNudge'],
  incrementReminderNudge: ((...args: Parameters<typeof incrementReminderNudge>) => incrementReminderNudge(...args)) as unknown as Parameters<typeof createReminderScheduler>[0]['incrementReminderNudge'],
  getLatestInboundPhoneNumberId: ((...args: Parameters<typeof getLatestInboundPhoneNumberId>) => getLatestInboundPhoneNumberId(...args)) as unknown as Parameters<typeof createReminderScheduler>[0]['getLatestInboundPhoneNumberId'],
  saveMessage: ((...args: Parameters<typeof saveMessage>) => saveMessage(...args)) as unknown as Parameters<typeof createReminderScheduler>[0]['saveMessage'],
  supabase: { from: ((...args: Parameters<typeof supabase.from>) => supabase.from(...args)) as unknown as Parameters<typeof createReminderScheduler>[0]['supabase']['from']},
  getReminderDispatchPolicy: ((...args: Parameters<typeof getReminderDispatchPolicy>) => getReminderDispatchPolicy(...args)) as unknown as Parameters<typeof createReminderScheduler>[0]['getReminderDispatchPolicy'],
  sendReminderMessage: ((...args: Parameters<typeof sendReminderMessage>) => sendReminderMessage(...args)) as unknown as Parameters<typeof createReminderScheduler>[0]['sendReminderMessage'],
  stripReminderPrefix: ((...args: Parameters<typeof stripReminderPrefix>) => stripReminderPrefix(...args)) as unknown as Parameters<typeof createReminderScheduler>[0]['stripReminderPrefix'],
  saveWorkingMemory: ((...args: Parameters<typeof saveWorkingMemory>) => saveWorkingMemory(...args)) as unknown as Parameters<typeof createReminderScheduler>[0]['saveWorkingMemory'],
  computeNextRecurringSendAt: ((...args: Parameters<typeof computeNextRecurringSendAt>) => computeNextRecurringSendAt(...args)) as unknown as Parameters<typeof createReminderScheduler>[0]['computeNextRecurringSendAt'],
  detectLocaleFromPhone: ((...args: Parameters<typeof detectLocaleFromPhone>) => detectLocaleFromPhone(...args)) as unknown as Parameters<typeof createReminderScheduler>[0]['detectLocaleFromPhone'],
  isAdvanceNoticeContent: ((...args: Parameters<typeof isAdvanceNoticeContent>) => isAdvanceNoticeContent(...args)) as unknown as Parameters<typeof createReminderScheduler>[0]['isAdvanceNoticeContent'],
  getNow: () => new Date(), getNowMs: () => Date.now(), sleep: ms => new Promise(resolve => setTimeout(resolve, ms)), workerId: process.env.WORKER_ID || `worker-${process.pid}-${Math.random().toString(36).slice(2, 7)}`, logger: console, checkIntervalMs: 30 * 1000});
export function resolveReminderLocale(...args: Parameters<typeof worker.resolveReminderLocale>) { return worker.resolveReminderLocale(...args); }
export function isEnglishReminder(...args: Parameters<typeof worker.isEnglishReminder>) { return worker.isEnglishReminder(...args); }
export function isNudgeDue(...args: Parameters<typeof worker.isNudgeDue>) { return worker.isNudgeDue(...args); }
export function reconcileRecurringScheduleState(...args: Parameters<typeof worker.reconcileRecurringScheduleState>) { return worker.reconcileRecurringScheduleState(...args); }
export function startScheduler(...args: Parameters<typeof worker.startScheduler>) { return worker.startScheduler(...args); }
export function checkAndDispatchNudges(...args: Parameters<typeof worker.checkAndDispatchNudges>) { return worker.checkAndDispatchNudges(...args); }
export function processReminder(...args: Parameters<typeof worker.processReminder>) { return worker.processReminder(...args); }


