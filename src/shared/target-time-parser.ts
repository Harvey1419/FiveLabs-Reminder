import { DEFAULT_TIMEZONE, zonedTimeToUtc, shiftZonedCalendarDays } from './timezone-arithmetic.js';
import { MONTH_NAME_MAP } from './calendar-query-bounds.js';

/**
 * Parse a targetTime string from the LLM or a legacy caller into a UTC-anchored Date.
 * The canonical LLM contract is language-independent:
 * - ISO 8601 duration for relative time (PT2M, PT3H, P1D, P1W)
 * - ISO 8601 date/time for an absolute time
 * Natural-language forms remain below only for backwards compatibility.
 */
export function parseTargetTime(str: unknown, timezone: string = DEFAULT_TIMEZONE, referenceTime: unknown = new Date(), options: { rollForwardTimeOnly?: boolean } = {}): Date | null {
  if (!str) return null;
  const s = String(str).trim();
  const requestedReference = referenceTime == null
    ? new Date()
    : (referenceTime instanceof Date ? referenceTime : new Date(referenceTime as string | number));
  const referenceDate = Number.isNaN(requestedReference.getTime()) ? new Date() : requestedReference;

  // 1. Canonical relative time. Months and years are deliberately unsupported
  // because their duration is calendar-dependent; the LLM must resolve those
  // into an absolute ISO date/time instead.
  const durationMatch = s.match(/^P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?)?$/i);
  if (durationMatch && durationMatch.slice(1).some((part) => part !== undefined)) {
    const weeks = Number(durationMatch[1] || 0);
    const days = Number(durationMatch[2] || 0);
    const hours = Number(durationMatch[3] || 0);
    const minutes = Number(durationMatch[4] || 0);
    const durationMs = (
      weeks * 7 * 24 * 60 * 60 * 1000
      + days * 24 * 60 * 60 * 1000
      + hours * 60 * 60 * 1000
      + minutes * 60 * 1000
    );
    if (durationMs > 0 && Number.isSafeInteger(durationMs)) {
      return new Date(referenceDate.getTime() + durationMs);
    }
    return null;
  }

  // Legacy compatibility only. Do not extend this into a language catalogue:
  // native LLM tools must emit the canonical ISO contract above.
  // Examples: "+10m", "in 15 minutes", "en 10 minutos", "dentro de 2 horas".
  const relMatch = s.match(/^(?:\+?|in\s+|en\s+|dentro\s+de\s+)?(\d+)\s*(m|min|mins|minute|minutes|minuto|minutos|h|hr|hrs|hour|hours|hora|horas|d|day|days|d[ií]a|d[ií]as|w|week|weeks|semana|semanas)$/i);
  if (relMatch) {
    const val = parseInt(relMatch[1]!, 10);
    const unit = relMatch[2]!.toLowerCase();
    let ms = 0;
    if (['m', 'min', 'mins', 'minute', 'minutes', 'minuto', 'minutos'].includes(unit)) {
      ms = val * 60 * 1000;
    } else if (['h', 'hr', 'hrs', 'hour', 'hours', 'hora', 'horas'].includes(unit)) {
      ms = val * 60 * 60 * 1000;
    } else if (['d', 'day', 'days', 'día', 'días'].includes(unit)) {
      ms = val * 24 * 60 * 60 * 1000;
    } else if (['w', 'week', 'weeks', 'semana', 'semanas'].includes(unit)) {
      ms = val * 7 * 24 * 60 * 60 * 1000;
    }
    return new Date(referenceDate.getTime() + ms);
  }

  // Normalize dots in meridians (e.g. "p. m." -> "pm", "a. m." -> "am")
  let normalizedStr = s
    .replace(/p\.\s*m\./gi, 'pm')
    .replace(/a\.\s*m\./gi, 'am')
    .replace(/\s+/g, ' ')
    .trim();

  let isExplicitTomorrow = false;
  if (/^(?:mañana|tomorrow)(?:\s+(?:a\s+las?|at))?\s+/i.test(normalizedStr)) {
    isExplicitTomorrow = true;
    normalizedStr = normalizedStr.replace(/^(?:mañana|tomorrow)(?:\s+(?:a\s+las?|at))?\s+/i, '').trim();
  } else if (/^(?:hoy|today)(?:\s+(?:a\s+las?|at))?\s+/i.test(normalizedStr)) {
    normalizedStr = normalizedStr.replace(/^(?:hoy|today)(?:\s+(?:a\s+las?|at))?\s+/i, '').trim();
  }

  // Get current date components in the user's timezone
  const now = referenceDate;
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const localParts = formatter.format(now).split('-').map(Number);
  const todayYear = localParts[0]!, todayMonth = localParts[1]!, todayDay = localParts[2]!;

  // 2. Full Date + Time ISO or Date string (e.g. "2026-09-02T17:00:00Z", "2026-09-02 17:00", "2026-09-02T17:00:00-05:00")
  const fullIsoMatch = normalizedStr.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T\s](\d{1,2}):(\d{2})(?::(\d{2}))?)?(?:\s*(am|pm))?(?:([Zz])|([+-]\d{2}:?\d{2}))?$/i);
  if (fullIsoMatch) {
    const y = parseInt(fullIsoMatch[1]!, 10);
    const m = parseInt(fullIsoMatch[2]!, 10);
    const d = parseInt(fullIsoMatch[3]!, 10);
    let hh = fullIsoMatch[4] ? parseInt(fullIsoMatch[4], 10) : 12;
    const mm = fullIsoMatch[5] ? parseInt(fullIsoMatch[5], 10) : 0;
    const ss = fullIsoMatch[6] ? parseInt(fullIsoMatch[6], 10) : 0;
    const meridian = fullIsoMatch[7]?.toLowerCase();
    const hasZ = Boolean(fullIsoMatch[8]);
    const explicitOffset = fullIsoMatch[9];

    if (meridian === 'pm' && hh < 12) hh += 12;
    if (meridian === 'am' && hh === 12) hh = 0;

    if (hasZ) {
      return new Date(Date.UTC(y, m - 1, d, hh, mm, ss));
    }
    if (explicitOffset) {
      return new Date(normalizedStr);
    }
    // No explicit offset -> interpret in user's timezone
    return zonedTimeToUtc(y, m, d, hh, mm, ss, timezone);
  }

  // 3. 12-hour AM/PM format (e.g. "5:00 PM", "5 PM", "06:30 am", "11 am", "5am")
  const ampmMatch = normalizedStr.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)$/i);
  if (ampmMatch) {
    let hours = parseInt(ampmMatch[1]!, 10);
    const minutes = ampmMatch[2] ? parseInt(ampmMatch[2], 10) : 0;
    const meridian = ampmMatch[3]!.toLowerCase();
    if (meridian === 'pm' && hours < 12) hours += 12;
    if (meridian === 'am' && hours === 12) hours = 0;

    let targetUtc = zonedTimeToUtc(todayYear, todayMonth, todayDay, hours, minutes, 0, timezone);
    if (isExplicitTomorrow) {
      targetUtc = shiftZonedCalendarDays(targetUtc, 1, timezone) ?? targetUtc;
    } else if (options.rollForwardTimeOnly !== false && targetUtc.getTime() <= referenceDate.getTime()) {
      targetUtc = shiftZonedCalendarDays(targetUtc, 1, timezone) ?? targetUtc;
    }
    return targetUtc;
  }

  // 4. Time-only 24h format (e.g. "08:00", "18:30:00", "17:00")
  const timeOnlyMatch = normalizedStr.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (timeOnlyMatch) {
    const hours = parseInt(timeOnlyMatch[1]!, 10);
    const minutes = parseInt(timeOnlyMatch[2]!, 10);
    const seconds = timeOnlyMatch[3] ? parseInt(timeOnlyMatch[3], 10) : 0;

    let targetUtc = zonedTimeToUtc(todayYear, todayMonth, todayDay, hours, minutes, seconds, timezone);
    if (isExplicitTomorrow) {
      targetUtc = shiftZonedCalendarDays(targetUtc, 1, timezone) ?? targetUtc;
    } else if (options.rollForwardTimeOnly !== false && targetUtc.getTime() <= referenceDate.getTime()) {
      targetUtc = shiftZonedCalendarDays(targetUtc, 1, timezone) ?? targetUtc;
    }
    return targetUtc;
  }

  // 4.5. Natural Date in Spanish/English format (e.g. "9 de septiembre", "el 9 de septiembre de 2026", "4 de septiembre a las 10:00 am", "September 9 at 5pm")
  const naturalDateMatch = normalizedStr.match(/^(?:el\s+)?(\d{1,2})\s+de\s+([a-záéíóúñ]+)(?:\s+de\s+(\d{4}))?(?:\s+(?:a\s+las?|at)\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?)?$/i);
  if (naturalDateMatch) {
    const d = parseInt(naturalDateMatch[1]!, 10);
    const monthName = naturalDateMatch[2]!.toLowerCase();
    const monthNum = (Object.hasOwn(MONTH_NAME_MAP, monthName) ? MONTH_NAME_MAP[monthName] : undefined) || todayMonth;
    let y = naturalDateMatch[3] ? parseInt(naturalDateMatch[3], 10) : todayYear;
    if (!naturalDateMatch[3] && monthNum < todayMonth) {
      y += 1;
    }
    let hh = naturalDateMatch[4] ? parseInt(naturalDateMatch[4], 10) : 9;
    const mm = naturalDateMatch[5] ? parseInt(naturalDateMatch[5], 10) : 0;
    const meridian = naturalDateMatch[6]?.toLowerCase();
    if (meridian === 'pm' && hh < 12) hh += 12;
    if (meridian === 'am' && hh === 12) hh = 0;
    return zonedTimeToUtc(y, monthNum, d, hh, mm, 0, timezone);
  }

  // 5. Explicit ISO string fallback
  const parsedDirect = new Date(normalizedStr);
  if (!isNaN(parsedDirect.getTime())) {
    return parsedDirect;
  }

  return null;
}

