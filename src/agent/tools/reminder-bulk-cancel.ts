import { supabase, markReminderAsCancelled } from '../../infrastructure/database/index.js';
import { formatReminderCancelledCard } from './formatters.js';
import {
  buildReminderOwnerContext,
  scopeReminderQueryToOwner,
} from './reminder-owner.js';
import { createReminderBulkCancelTools } from './reminder-bulk-cancel-tools.js';
const service = createReminderBulkCancelTools({
  supabase: { from: ((...args: Parameters<typeof supabase.from>) => supabase.from(...args)) as unknown as Parameters<typeof createReminderBulkCancelTools>[0]['supabase']['from']},
  markReminderAsCancelled: ((...args: Parameters<typeof markReminderAsCancelled>) => markReminderAsCancelled(...args)) as unknown as Parameters<typeof createReminderBulkCancelTools>[0]['markReminderAsCancelled'],
  formatReminderCancelledCard: ((...args: Parameters<typeof formatReminderCancelledCard>) => formatReminderCancelledCard(...args)) as unknown as Parameters<typeof createReminderBulkCancelTools>[0]['formatReminderCancelledCard'],
  buildReminderOwnerContext: ((...args: Parameters<typeof buildReminderOwnerContext>) => buildReminderOwnerContext(...args)) as unknown as Parameters<typeof createReminderBulkCancelTools>[0]['buildReminderOwnerContext'],
  scopeReminderQueryToOwner: ((...args: Parameters<typeof scopeReminderQueryToOwner>) => scopeReminderQueryToOwner(...args)) as unknown as Parameters<typeof createReminderBulkCancelTools>[0]['scopeReminderQueryToOwner'],
  logger: console,
});
export function executeBulkReminderCancellation(...args: Parameters<typeof service.executeBulkReminderCancellation>) { return service.executeBulkReminderCancellation(...args); }


