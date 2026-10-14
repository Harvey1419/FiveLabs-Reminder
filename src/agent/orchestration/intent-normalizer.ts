import { getWorkingMemory } from '../core/working-memory-store.js';
import { resolveContextReference, parseStructuredOrdinal } from '../core/context-reference.js';
import { getLocalDateParts, shiftZonedCalendarDays } from '../../shared/time.js';
import { resolveTypedSchedule } from './typed-schedule.js';
import {
  normalizeAgendaScope,
  normalizeTaskScope,
  buildExplicitTaskDateScope,
  buildExplicitReminderDateScope,
  parseReminderScope,
} from '../../shared/agenda-scopes.js';
import { sanitizeCalendarQueryAndScope } from '../tools/calendar.js';

import { createIntentNormalizer } from './runtime-intent-normalizer.js';
export const { normalizeTurnActionForRuntime, normalizeTurnIntentForRuntime } = createIntentNormalizer({
  getWorkingMemory: ((...args: Parameters<typeof getWorkingMemory>) => getWorkingMemory(...args)) as unknown as Parameters<typeof createIntentNormalizer>[0]['getWorkingMemory'],
  resolveContextReference: ((...args: Parameters<typeof resolveContextReference>) => resolveContextReference(...args)) as unknown as Parameters<typeof createIntentNormalizer>[0]['resolveContextReference'],
  parseStructuredOrdinal: ((...args: Parameters<typeof parseStructuredOrdinal>) => parseStructuredOrdinal(...args)) as unknown as Parameters<typeof createIntentNormalizer>[0]['parseStructuredOrdinal'],
  getLocalDateParts: ((...args: Parameters<typeof getLocalDateParts>) => getLocalDateParts(...args)) as unknown as Parameters<typeof createIntentNormalizer>[0]['getLocalDateParts'],
  shiftZonedCalendarDays: ((...args: Parameters<typeof shiftZonedCalendarDays>) => shiftZonedCalendarDays(...args)) as unknown as Parameters<typeof createIntentNormalizer>[0]['shiftZonedCalendarDays'],
  resolveTypedSchedule: ((...args: Parameters<typeof resolveTypedSchedule>) => resolveTypedSchedule(...args)) as unknown as Parameters<typeof createIntentNormalizer>[0]['resolveTypedSchedule'],
  normalizeAgendaScope: ((...args: Parameters<typeof normalizeAgendaScope>) => normalizeAgendaScope(...args)) as unknown as Parameters<typeof createIntentNormalizer>[0]['normalizeAgendaScope'],
  normalizeTaskScope: ((...args: Parameters<typeof normalizeTaskScope>) => normalizeTaskScope(...args)) as unknown as Parameters<typeof createIntentNormalizer>[0]['normalizeTaskScope'],
  buildExplicitTaskDateScope: ((...args: Parameters<typeof buildExplicitTaskDateScope>) => buildExplicitTaskDateScope(...args)) as unknown as Parameters<typeof createIntentNormalizer>[0]['buildExplicitTaskDateScope'],
  buildExplicitReminderDateScope: ((...args: Parameters<typeof buildExplicitReminderDateScope>) => buildExplicitReminderDateScope(...args)) as unknown as Parameters<typeof createIntentNormalizer>[0]['buildExplicitReminderDateScope'],
  parseReminderScope: ((...args: Parameters<typeof parseReminderScope>) => parseReminderScope(...args)) as unknown as Parameters<typeof createIntentNormalizer>[0]['parseReminderScope'],
  sanitizeCalendarQueryAndScope: ((...args: Parameters<typeof sanitizeCalendarQueryAndScope>) => sanitizeCalendarQueryAndScope(...args)) as unknown as Parameters<typeof createIntentNormalizer>[0]['sanitizeCalendarQueryAndScope'],
});


