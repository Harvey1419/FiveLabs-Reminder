import {
  saveReminder,
  cancelPendingRemindersByContent,
  createTask,
  getUserSubscription,
  hasProAccess,
  shouldEnforceBillingForUser,
} from '../../../infrastructure/database/index.js';
import {
  getReminderConfirmationPreference,
  getReminderDispatchPolicy,
} from '../../../infrastructure/database/memories.js';
import {
  parseTargetTime,
  formatHumanFriendlyDateTime,
  shiftZonedCalendarDays,
  DEFAULT_TIMEZONE,
} from '../../../shared/time.js';
import {
  formatReminderCreatedCard,
  formatReminderCreateOutcomeCard,
} from '../../../agent/tools/formatters.js';
import { resolveReminderProUpgradeContext } from '../../../agent/tools/reminder-pro.js';
import { buildAdvanceNoticeContent } from '../../../agent/tools/reminder-advance.js';
import { computeNextRecurringSendAt } from '../../../shared/reminder-recurrence.js';
import { createReminderCreateTools } from './reminder-create-tools.js';
const service = createReminderCreateTools({
  saveReminder: ((...args: Parameters<typeof saveReminder>) => saveReminder(...args)) as unknown as Parameters<typeof createReminderCreateTools>[0]['saveReminder'],
  cancelPendingRemindersByContent: ((...args: Parameters<typeof cancelPendingRemindersByContent>) => cancelPendingRemindersByContent(...args)) as unknown as Parameters<typeof createReminderCreateTools>[0]['cancelPendingRemindersByContent'],
  createTask: ((...args: Parameters<typeof createTask>) => createTask(...args)) as unknown as Parameters<typeof createReminderCreateTools>[0]['createTask'],
  getUserSubscription: ((...args: Parameters<typeof getUserSubscription>) => getUserSubscription(...args)) as unknown as Parameters<typeof createReminderCreateTools>[0]['getUserSubscription'],
  hasProAccess: ((...args: Parameters<typeof hasProAccess>) => hasProAccess(...args)) as unknown as Parameters<typeof createReminderCreateTools>[0]['hasProAccess'],
  shouldEnforceBillingForUser: ((...args: Parameters<typeof shouldEnforceBillingForUser>) => shouldEnforceBillingForUser(...args)) as unknown as Parameters<typeof createReminderCreateTools>[0]['shouldEnforceBillingForUser'],
  getReminderConfirmationPreference: ((...args: Parameters<typeof getReminderConfirmationPreference>) => getReminderConfirmationPreference(...args)) as unknown as Parameters<typeof createReminderCreateTools>[0]['getReminderConfirmationPreference'],
  getReminderDispatchPolicy: ((...args: Parameters<typeof getReminderDispatchPolicy>) => getReminderDispatchPolicy(...args)) as unknown as Parameters<typeof createReminderCreateTools>[0]['getReminderDispatchPolicy'],
  parseTargetTime: ((...args: Parameters<typeof parseTargetTime>) => parseTargetTime(...args)) as unknown as Parameters<typeof createReminderCreateTools>[0]['parseTargetTime'],
  formatHumanFriendlyDateTime: ((...args: Parameters<typeof formatHumanFriendlyDateTime>) => formatHumanFriendlyDateTime(...args)) as unknown as Parameters<typeof createReminderCreateTools>[0]['formatHumanFriendlyDateTime'],
  shiftZonedCalendarDays: ((...args: Parameters<typeof shiftZonedCalendarDays>) => shiftZonedCalendarDays(...args)) as unknown as Parameters<typeof createReminderCreateTools>[0]['shiftZonedCalendarDays'],
  get DEFAULT_TIMEZONE(): Parameters<typeof createReminderCreateTools>[0]['DEFAULT_TIMEZONE'] { return DEFAULT_TIMEZONE as unknown as Parameters<typeof createReminderCreateTools>[0]['DEFAULT_TIMEZONE']; },
  formatReminderCreatedCard: ((...args: Parameters<typeof formatReminderCreatedCard>) => formatReminderCreatedCard(...args)) as unknown as Parameters<typeof createReminderCreateTools>[0]['formatReminderCreatedCard'],
  formatReminderCreateOutcomeCard: ((...args: Parameters<typeof formatReminderCreateOutcomeCard>) => formatReminderCreateOutcomeCard(...args)) as unknown as Parameters<typeof createReminderCreateTools>[0]['formatReminderCreateOutcomeCard'],
  resolveReminderProUpgradeContext: ((...args: Parameters<typeof resolveReminderProUpgradeContext>) => resolveReminderProUpgradeContext(...args)) as unknown as Parameters<typeof createReminderCreateTools>[0]['resolveReminderProUpgradeContext'],
  buildAdvanceNoticeContent: ((...args: Parameters<typeof buildAdvanceNoticeContent>) => buildAdvanceNoticeContent(...args)) as unknown as Parameters<typeof createReminderCreateTools>[0]['buildAdvanceNoticeContent'],
  computeNextRecurringSendAt: ((...args: Parameters<typeof computeNextRecurringSendAt>) => computeNextRecurringSendAt(...args)) as unknown as Parameters<typeof createReminderCreateTools>[0]['computeNextRecurringSendAt'],
  logger: console,
});
export function executeReminderCreate(...args: Parameters<typeof service.executeReminderCreate>) { return service.executeReminderCreate(...args); }
