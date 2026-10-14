import type { LegacyToolUser } from '../../agent/tools/remaining-tool-ports.js';
import { legacyDomainInvoker, type LegacyExecutor } from './legacy-domain.js';
import { compatibilityParameters } from '../../features/productivity-domain.js';
import { calendarParameters } from '../../features/calendar/productivity-service.js';
import { createCalendarDomainPort } from './calendar-domain.js';

/** Compatibility injection only; production V2 uses the typed domain port. */
export function createLegacyCalendarPort(user: LegacyToolUser, execute?: LegacyExecutor) {
  const invoke = legacyDomainInvoker(user, execute);
  return createCalendarDomainPort(user, { execute: (request, context) =>
    invoke('manage_google_calendar', compatibilityParameters(calendarParameters(request)), context) });
}
