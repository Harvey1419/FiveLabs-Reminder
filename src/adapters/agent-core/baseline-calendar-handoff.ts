import { z } from 'zod';
import { calendarEventSchema, type CalendarEvent, type TurnContext } from '@templelabs/contracts';
import { listCalendarEvents } from '../../integrations/google/calendar.js';

/** The historical timestamp is a lookup hint; only Google's owner-bound result becomes a reference. */
export async function readOwnedBaselineEvent(id: string, context: TurnContext, raw: unknown): Promise<CalendarEvent | null> {
  const hint = z.object({ startIso: z.string().optional(), start: z.union([z.string(), z.object({ dateTime: z.string().optional(), date: z.string().optional() })]).optional() }).safeParse(raw);
  if (!hint.success) return null;
  const start = hint.data.startIso ?? (typeof hint.data.start === 'string' ? hint.data.start : hint.data.start?.dateTime ?? hint.data.start?.date);
  const instant = start ? Date.parse(start) : NaN;
  if (!Number.isFinite(instant)) return null;
  context.signal.throwIfAborted();
  const rows = await listCalendarEvents(context.userId, { timeMin: new Date(instant - 86400000),
    timeMax: new Date(instant + 86400000), maxResults: 50, timezone: context.timezone });
  context.signal.throwIfAborted();
  const row = rows?.find(event => event.id === id);
  if (!row) return null;
  const event = z.object({ id: z.string(), summary: z.string(), isAllDay: z.boolean(), start: z.string(),
    end: z.string().nullish(), meetLink: z.string().nullish() }).parse(row);
  return calendarEventSchema.parse(event.isAllDay
    ? { kind: 'all_day', id, summary: event.summary, startDate: event.start, endDateExclusive: event.end ?? null }
    : { kind: 'timed', id, summary: event.summary, startIso: event.start,
      endIso: event.end ?? null, meetLink: event.meetLink ?? null });
}
