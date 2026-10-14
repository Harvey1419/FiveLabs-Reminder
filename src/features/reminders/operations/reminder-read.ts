import { normalizeReminderQuery } from '../../../agent/contracts/reminder-query.js';
import { supabase } from '../../../infrastructure/database/index.js';
import {
  formatHumanFriendlyDateTime,
  resolveCalendarTemporalScope,
} from '../../../shared/time.js';
import { parseReminderScope } from '../../../shared/agenda-scopes.js';
import {
  buildReminderOwnerContext,
  scopeReminderQueryToOwner,
} from '../../../agent/tools/reminder-owner.js';
import { createReminderReadTools } from './reminder-read-tools.js';
const service = createReminderReadTools({
  normalizeReminderQuery: ((...args: Parameters<typeof normalizeReminderQuery>) => normalizeReminderQuery(...args)) as unknown as Parameters<typeof createReminderReadTools>[0]['normalizeReminderQuery'],
  supabase: { from: ((...args: Parameters<typeof supabase.from>) => supabase.from(...args)) as unknown as Parameters<typeof createReminderReadTools>[0]['supabase']['from']},
  formatHumanFriendlyDateTime: ((...args: Parameters<typeof formatHumanFriendlyDateTime>) => formatHumanFriendlyDateTime(...args)) as unknown as Parameters<typeof createReminderReadTools>[0]['formatHumanFriendlyDateTime'],
  resolveCalendarTemporalScope: ((...args: Parameters<typeof resolveCalendarTemporalScope>) => resolveCalendarTemporalScope(...args)) as unknown as Parameters<typeof createReminderReadTools>[0]['resolveCalendarTemporalScope'],
  parseReminderScope: ((...args: Parameters<typeof parseReminderScope>) => parseReminderScope(...args)) as unknown as Parameters<typeof createReminderReadTools>[0]['parseReminderScope'],
  buildReminderOwnerContext: ((...args: Parameters<typeof buildReminderOwnerContext>) => buildReminderOwnerContext(...args)) as unknown as Parameters<typeof createReminderReadTools>[0]['buildReminderOwnerContext'],
  scopeReminderQueryToOwner: ((...args: Parameters<typeof scopeReminderQueryToOwner>) => scopeReminderQueryToOwner(...args)) as unknown as Parameters<typeof createReminderReadTools>[0]['scopeReminderQueryToOwner'],
  logger: console,
});
export function executeReminderReadTool(...args: Parameters<typeof service.executeReminderReadTool>) { return service.executeReminderReadTool(...args); }
