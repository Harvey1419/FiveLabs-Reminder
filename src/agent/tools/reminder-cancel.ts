import { supabase } from '../../infrastructure/database/index.js';
import { resolveContextReference } from '../core/context-reference.js';
import {
  parseAdvanceNoticeContent,
  isAdvanceNoticeContent,
  belongsToMainReminder,
} from './reminder-advance.js';
import {
  buildReminderOwnerContext,
  isReminderOwned,
  scopeReminderQueryToOwner,
} from './reminder-owner.js';
import {
  findReminderByExactReference,
  buildReminderReferenceCandidates,
  resolveReminderByScore,
} from './reminder-reference.js';
import { isStrictUUID } from '../../shared/entity-resolution.js';
import { createReminderCancelTools } from './reminder-cancel-tools.js';
const service = createReminderCancelTools({
  supabase: { from: ((...args: Parameters<typeof supabase.from>) => supabase.from(...args)) as unknown as Parameters<typeof createReminderCancelTools>[0]['supabase']['from']},
  resolveContextReference: ((...args: Parameters<typeof resolveContextReference>) => resolveContextReference(...args)) as unknown as Parameters<typeof createReminderCancelTools>[0]['resolveContextReference'],
  parseAdvanceNoticeContent: ((...args: Parameters<typeof parseAdvanceNoticeContent>) => parseAdvanceNoticeContent(...args)) as unknown as Parameters<typeof createReminderCancelTools>[0]['parseAdvanceNoticeContent'],
  isAdvanceNoticeContent: ((...args: Parameters<typeof isAdvanceNoticeContent>) => isAdvanceNoticeContent(...args)) as unknown as Parameters<typeof createReminderCancelTools>[0]['isAdvanceNoticeContent'],
  belongsToMainReminder: ((...args: Parameters<typeof belongsToMainReminder>) => belongsToMainReminder(...args)) as unknown as Parameters<typeof createReminderCancelTools>[0]['belongsToMainReminder'],
  buildReminderOwnerContext: ((...args: Parameters<typeof buildReminderOwnerContext>) => buildReminderOwnerContext(...args)) as unknown as Parameters<typeof createReminderCancelTools>[0]['buildReminderOwnerContext'],
  isReminderOwned: ((...args: Parameters<typeof isReminderOwned>) => isReminderOwned(...args)) as unknown as Parameters<typeof createReminderCancelTools>[0]['isReminderOwned'],
  scopeReminderQueryToOwner: ((...args: Parameters<typeof scopeReminderQueryToOwner>) => scopeReminderQueryToOwner(...args)) as unknown as Parameters<typeof createReminderCancelTools>[0]['scopeReminderQueryToOwner'],
  findReminderByExactReference: ((...args: Parameters<typeof findReminderByExactReference>) => findReminderByExactReference(...args)) as unknown as Parameters<typeof createReminderCancelTools>[0]['findReminderByExactReference'],
  buildReminderReferenceCandidates: ((...args: Parameters<typeof buildReminderReferenceCandidates>) => buildReminderReferenceCandidates(...args)) as unknown as Parameters<typeof createReminderCancelTools>[0]['buildReminderReferenceCandidates'],
  resolveReminderByScore: ((...args: Parameters<typeof resolveReminderByScore>) => resolveReminderByScore(...args)) as unknown as Parameters<typeof createReminderCancelTools>[0]['resolveReminderByScore'],
  isStrictUUID: ((...args: Parameters<typeof isStrictUUID>) => isStrictUUID(...args)) as unknown as Parameters<typeof createReminderCancelTools>[0]['isStrictUUID'],
  logger: console,
});
export function executeSingleReminderCancellation(...args: Parameters<typeof service.executeSingleReminderCancellation>) { return service.executeSingleReminderCancellation(...args); }


