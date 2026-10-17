/** Real calendar service/adapter/executor with an isolated Google API boundary. */
import { createCalendarTool, type CalendarEventRow } from '../../src/features/calendar/operations/calendar-tool.js';
import { createCalendarService } from '../../src/features/calendar/productivity-service.js';
import { createCalendarDomainPort } from '../../src/adapters/agent-core/calendar-domain.js';
import { parseStructuredOrdinal, resolveContextReference } from '../../src/agent/core/context-reference.js';
import * as time from '../../src/shared/time.js';
import { formatRecurrenceLabel } from '../../src/shared/reminder-presentation.js';
import { SYNTHETIC_USER } from './v2-fluent-conversation-suite2.js';

export const calendarAnchor = '2026-10-17T16:35:00Z';
export function calendarCorrectionFixture() {
  const user = { id: SYNTHETIC_USER, timezone: 'America/Bogota' };
  const events: CalendarEventRow[] = [];
  const operations: { operation: string; id: string; changes?: Record<string, unknown> }[] = [];
  const reads: Record<string, unknown>[] = [];
  let sequence = 0;
  const owned = (owner: string | undefined) => { if (owner !== user.id) throw new Error('Foreign calendar'); };
  const executor = createCalendarTool({
    getUserIntegration: async () => ({ account_email: 'synthetic@example.test' }),
    hasUsableGoogleCredentials: () => true, isGoogleAuthError: () => false,
    saveReminder: async () => { throw new Error('Unexpected companion reminder'); },
    cancelCalendarCompanionReminders: async () => ({ cancelled: 0 }),
    rescheduleCalendarCompanionReminders: async () => ({ rescheduled: 0 }),
    getGoogleConnectUrl: () => 'https://example.test/google', revokeGoogleIntegration: async () => null,
    listCalendarEvents: async (owner, options) => {
      owned(owner); reads.push(structuredClone(options));
      return structuredClone(events.filter(event => {
        // Mirror Google q: event IDs are NOT searchable event text.
        if (options.q && !String(event.summary).toLowerCase().includes(String(options.q).toLowerCase())) return false;
        const at = time.zonedTimeToUtc(Number(String(event.start).slice(0, 4)), Number(String(event.start).slice(5, 7)), Number(String(event.start).slice(8, 10)), 0, 0, 0, user.timezone).getTime();
        return at >= new Date(options.timeMin as string | Date).getTime()
          && (!options.timeMax || at < new Date(options.timeMax as string | Date).getTime());
      }).sort((a, b) => String(a.start).localeCompare(String(b.start))).slice(0, Number(options.maxResults ?? 15)));
    },
    createCalendarEvent: async (owner, options) => {
      owned(owner);
      const event: CalendarEventRow = { id: `hermesfixture${++sequence}`, summary: String(options.summary),
        start: String(options.startDate), end: String(options.endDate), isAllDay: true };
      events.push(event); operations.push({ operation: 'create', id: event.id! }); return structuredClone(event);
    },
    updateCalendarEvent: async (owner, options) => {
      owned(owner); const event = events.find(event => event.id === options.eventId);
      if (!event) throw new Error('Event not found');
      if (options.summary !== undefined) event.summary = String(options.summary);
      if (options.startDate) event.start = String(options.startDate);
      if (options.endDate) event.end = String(options.endDate);
      operations.push({ operation: 'update', id: event.id!, changes: structuredClone(options) }); return structuredClone(event);
    },
    deleteCalendarEvent: async (owner, id) => {
      owned(owner); const index = events.findIndex(event => event.id === id);
      if (index < 0) throw new Error('Event not found');
      events.splice(index, 1); operations.push({ operation: 'delete', id }); return null;
    },
    parseTargetTime: time.parseTargetTime, getDayBounds: time.getDayBounds,
    resolveCalendarTemporalScope: time.resolveCalendarTemporalScope, formatLocalDateTime: time.formatLocalDateTime,
    formatHumanFriendlyDateTime: time.formatHumanFriendlyDateTime, formatHumanFriendlyDate: time.formatHumanFriendlyDate,
    zonedTimeToUtc: time.zonedTimeToUtc, DEFAULT_TIMEZONE: user.timezone, formatRecurrenceLabel,
    parseStructuredOrdinal, resolveContextReference, getWorkingMemory: () => null,
    getNow: () => new Date(calendarAnchor), getNowMs: () => Date.parse(calendarAnchor), logger: { log() {}, warn() {}, error() {} },
  });
  return { user, events, operations, reads, port: createCalendarDomainPort(user, createCalendarService(user, executor.executeCalendarTool)) };
}
