/** Shared default retained across the transitional time entry and typed callers. */
export const DEFAULT_TIMEZONE = 'America/Bogota';
export interface LocalCalendarParts { year: number; month: number; day: number; dayOfWeek: number }

/**
 * Compute the exact UTC offset string (e.g. "-05:00", "+00:00", "+02:00") for a specific IANA timezone and instant.
 */
export function computeOffsetMinutes(timezone: string = DEFAULT_TIMEZONE, targetDate: unknown = new Date()): string {
  try {
    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      timeZoneName: 'longOffset',
    });
    const parts = formatter.formatToParts(targetDate instanceof Date ? targetDate : new Date(targetDate as string | number));
    const tzPart = parts.find(p => p.type === 'timeZoneName');
    if (tzPart?.value) {
      const match = tzPart.value.match(/GMT([+-]\d{2}:\d{2})/);
      if (match) return match[1]!;
      if (tzPart.value === 'GMT') return '+00:00';
    }
  } catch (err) {
    console.warn(`[time] failed to compute offset for ${timezone}:`, err instanceof Error ? err.message : String(err));
  }
  return '-05:00';
}

/**
 * Convert local date/time components in a specified IANA timezone to a true UTC Date instance with exact DST resolution.
 */
export function zonedTimeToUtc(year: number, month: number, day: number, hour = 0, minute = 0, second = 0, timezone: string = DEFAULT_TIMEZONE): Date {
  try {
    const utcGuess = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
      hourCycle: 'h23',
    });
    let candidate = utcGuess;

    // A single offset lookup is wrong when the naive UTC guess and the final
    // instant lie on opposite sides of a DST boundary. Re-evaluate the offset
    // at the candidate until it converges. Nonexistent wall clocks may
    // oscillate; callers that require strict validity round-trip the result.
    for (let iteration = 0; iteration < 6; iteration += 1) {
      const parts: Record<string, number> = {};
      for (const { type, value } of formatter.formatToParts(candidate)) {
        if (type !== 'literal') parts[type] = Number(value);
      }
      const representedLocalTime = Date.UTC(
        parts.year!, parts.month! - 1, parts.day!,
        parts.hour!, parts.minute!, parts.second!,
      );
      const offsetAtCandidate = representedLocalTime - candidate.getTime();
      const next = new Date(utcGuess.getTime() - offsetAtCandidate);
      if (next.getTime() === candidate.getTime()) return next;
      candidate = next;
    }
    return candidate;
  } catch (err) {
    console.error(`[time] zonedTimeToUtc error for ${timezone}:`, err);
    return new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  }
}

/**
 * Extract local date parts (year, month 1-12, day 1-31, dayOfWeek 0-6 Sun-Sat) in the given timezone.
 */
export function getLocalDateParts(dateObj: unknown = new Date(), timezone: string = DEFAULT_TIMEZONE): LocalCalendarParts {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    weekday: 'short',
  });
  const parts = formatter.formatToParts(dateObj instanceof Date ? dateObj : new Date(dateObj as string | number));
  const p: Record<string, string> = {};
  for (const { type, value } of parts) {
    p[type] = value;
  }
  const year = parseInt(p.year!, 10);
  const month = parseInt(p.month!, 10);
  const day = parseInt(p.day!, 10);
  const dayOfWeekMap: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  const dayOfWeek = dayOfWeekMap[p.weekday!] ?? 0;
  return { year, month, day, dayOfWeek };
}

/**
 * Move an instant by local calendar days while preserving its wall-clock time.
 * Unlike adding 24 hours, this remains correct across timezone DST changes.
 */
export function shiftZonedCalendarDays(dateObj: unknown, days: unknown, timezone: string = DEFAULT_TIMEZONE): Date | null {
  const date = dateObj instanceof Date ? dateObj : new Date(dateObj as string | number);
  const dayDelta = Number(days);
  if (Number.isNaN(date.getTime()) || !Number.isInteger(dayDelta)) return null;

  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric', month: 'numeric', day: 'numeric',
    hour: 'numeric', minute: 'numeric', second: 'numeric',
    hourCycle: 'h23',
  });
  const parts: Record<string, number> = {};
  for (const { type, value } of formatter.formatToParts(date)) {
    if (type !== 'literal') parts[type] = Number(value);
  }

  const shiftedCalendar = new Date(Date.UTC(
    parts.year!, parts.month! - 1, parts.day! + dayDelta,
    parts.hour!, parts.minute!, parts.second!,
  ));
  return zonedTimeToUtc(
    shiftedCalendar.getUTCFullYear(),
    shiftedCalendar.getUTCMonth() + 1,
    shiftedCalendar.getUTCDate(),
    shiftedCalendar.getUTCHours(),
    shiftedCalendar.getUTCMinutes(),
    shiftedCalendar.getUTCSeconds(),
    timezone,
  );
}

