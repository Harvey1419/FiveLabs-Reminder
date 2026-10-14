import {
  supabase,
  saveReminder,
  updateReminder,
  getUserSubscription,
  hasProAccess,
  shouldEnforceBillingForUser,
} from '../../../infrastructure/database/index.js';
import {
  parseTargetTime,
  formatHumanFriendlyDateTime,
  DEFAULT_TIMEZONE,
} from '../../../shared/time.js';
import { resolveContextReference } from '../../../agent/core/context-reference.js';
import { isStrictUUID } from '../../../shared/entity-resolution.js';
import { PRESENTATION_TOKENS } from '../../../shared/presentation-tokens.js';
import { formatReminderUpdatedCard } from '../../../agent/tools/formatters.js';
import {
  REMINDER_PRO_FALLBACK,
  resolveReminderProUpgradeContext,
} from '../../../agent/tools/reminder-pro.js';
import {
  buildAdvanceNoticeContent,
  belongsToMainReminder,
  getAdvanceNoticeMinutes,
} from '../../../agent/tools/reminder-advance.js';
import {
  buildReminderOwnerContext,
  scopeReminderQueryToOwner,
} from '../../../agent/tools/reminder-owner.js';
import { createReminderUpdateTools } from './reminder-update-tools.js';
const service = createReminderUpdateTools({
  supabase: { from: ((...args: Parameters<typeof supabase.from>) => supabase.from(...args)) as unknown as Parameters<typeof createReminderUpdateTools>[0]['supabase']['from']},
  saveReminder: ((...args: Parameters<typeof saveReminder>) => saveReminder(...args)) as unknown as Parameters<typeof createReminderUpdateTools>[0]['saveReminder'],
  updateReminder: ((...args: Parameters<typeof updateReminder>) => updateReminder(...args)) as unknown as Parameters<typeof createReminderUpdateTools>[0]['updateReminder'],
  getUserSubscription: ((...args: Parameters<typeof getUserSubscription>) => getUserSubscription(...args)) as unknown as Parameters<typeof createReminderUpdateTools>[0]['getUserSubscription'],
  hasProAccess: ((...args: Parameters<typeof hasProAccess>) => hasProAccess(...args)) as unknown as Parameters<typeof createReminderUpdateTools>[0]['hasProAccess'],
  shouldEnforceBillingForUser: ((...args: Parameters<typeof shouldEnforceBillingForUser>) => shouldEnforceBillingForUser(...args)) as unknown as Parameters<typeof createReminderUpdateTools>[0]['shouldEnforceBillingForUser'],
  parseTargetTime: ((...args: Parameters<typeof parseTargetTime>) => parseTargetTime(...args)) as unknown as Parameters<typeof createReminderUpdateTools>[0]['parseTargetTime'],
  formatHumanFriendlyDateTime: ((...args: Parameters<typeof formatHumanFriendlyDateTime>) => formatHumanFriendlyDateTime(...args)) as unknown as Parameters<typeof createReminderUpdateTools>[0]['formatHumanFriendlyDateTime'],
  get DEFAULT_TIMEZONE(): Parameters<typeof createReminderUpdateTools>[0]['DEFAULT_TIMEZONE'] { return DEFAULT_TIMEZONE as unknown as Parameters<typeof createReminderUpdateTools>[0]['DEFAULT_TIMEZONE']; },
  resolveContextReference: ((...args: Parameters<typeof resolveContextReference>) => resolveContextReference(...args)) as unknown as Parameters<typeof createReminderUpdateTools>[0]['resolveContextReference'],
  isStrictUUID: ((...args: Parameters<typeof isStrictUUID>) => isStrictUUID(...args)) as unknown as Parameters<typeof createReminderUpdateTools>[0]['isStrictUUID'],
  get PRESENTATION_TOKENS() { return PRESENTATION_TOKENS as unknown as Parameters<typeof createReminderUpdateTools>[0]['PRESENTATION_TOKENS']; },
  formatReminderUpdatedCard: ((...args: Parameters<typeof formatReminderUpdatedCard>) => formatReminderUpdatedCard(...args)) as unknown as Parameters<typeof createReminderUpdateTools>[0]['formatReminderUpdatedCard'],
  get REMINDER_PRO_FALLBACK() { return REMINDER_PRO_FALLBACK as unknown as Parameters<typeof createReminderUpdateTools>[0]['REMINDER_PRO_FALLBACK']; },
  resolveReminderProUpgradeContext: ((...args: Parameters<typeof resolveReminderProUpgradeContext>) => resolveReminderProUpgradeContext(...args)) as unknown as Parameters<typeof createReminderUpdateTools>[0]['resolveReminderProUpgradeContext'],
  buildAdvanceNoticeContent: ((...args: Parameters<typeof buildAdvanceNoticeContent>) => buildAdvanceNoticeContent(...args)) as unknown as Parameters<typeof createReminderUpdateTools>[0]['buildAdvanceNoticeContent'],
  belongsToMainReminder: ((...args: Parameters<typeof belongsToMainReminder>) => belongsToMainReminder(...args)) as unknown as Parameters<typeof createReminderUpdateTools>[0]['belongsToMainReminder'],
  getAdvanceNoticeMinutes: ((...args: Parameters<typeof getAdvanceNoticeMinutes>) => getAdvanceNoticeMinutes(...args)) as unknown as Parameters<typeof createReminderUpdateTools>[0]['getAdvanceNoticeMinutes'],
  buildReminderOwnerContext: ((...args: Parameters<typeof buildReminderOwnerContext>) => buildReminderOwnerContext(...args)) as unknown as Parameters<typeof createReminderUpdateTools>[0]['buildReminderOwnerContext'],
  scopeReminderQueryToOwner: ((...args: Parameters<typeof scopeReminderQueryToOwner>) => scopeReminderQueryToOwner(...args)) as unknown as Parameters<typeof createReminderUpdateTools>[0]['scopeReminderQueryToOwner'],
  logger: console,
});
export function executeReminderUpdate(...args: Parameters<typeof service.executeReminderUpdate>) { return service.executeReminderUpdate(...args); }
