import type { LegacyToolUser } from '../../agent/tools/remaining-tool-ports.js';
import { legacyDomainInvoker, type LegacyExecutor } from './legacy-domain.js';
import { compatibilityParameters } from '../../features/productivity-domain.js';
import { reminderParameters } from '../../features/reminders/productivity-service.js';
import { createReminderDomainPort } from './reminders-domain.js';
export { normalizeReminderRecord as normalizeLegacyReminderRecord } from './reminders-domain.js';

/** Compatibility injection only; production V2 uses the typed domain port. */
export function createLegacyReminderPort(user: LegacyToolUser, execute?: LegacyExecutor) {
  const invoke = legacyDomainInvoker(user, execute);
  return createReminderDomainPort(user, { execute: (request, context) =>
    invoke('manage_reminder', compatibilityParameters(reminderParameters(request, context)), context) });
}
