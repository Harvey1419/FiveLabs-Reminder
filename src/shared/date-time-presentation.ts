import { DEFAULT_TIMEZONE, computeOffsetMinutes, getLocalDateParts, shiftZonedCalendarDays } from './timezone-arithmetic.js';

const UNIT_WORDS: Record<string, Record<string, string>> = {
  es: { minutes: 'minuto', hours: 'hora', days: 'día', weeks: 'semana' },
  en: { minutes: 'minute', hours: 'hour', days: 'day', weeks: 'week' },
  pt: { minutes: 'minuto', hours: 'hora', days: 'dia', weeks: 'semana' },
};

function pluralUnit(value: number, unit: string, language = 'es'): string {
  const word = UNIT_WORDS[language]?.[unit] || unit;
  return `${value} ${word}${value > 1 ? 's' : ''}`;
}

/**
 * Returns current local time as ISO 8601 with explicit offset.
 */
export function nowISO(timezone: string = DEFAULT_TIMEZONE, referenceTime: unknown = new Date()): string {
  const requestedReference = referenceTime instanceof Date ? referenceTime : new Date(referenceTime as string | number);
  const now = Number.isNaN(requestedReference.getTime()) ? new Date() : requestedReference;
  const offset = computeOffsetMinutes(timezone, now);
  try {
    const localStr = now.toLocaleString('sv-SE', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    return localStr.replace(' ', 'T') + offset;
  } catch (err) {
    console.error(`[time] nowISO error with timezone ${timezone}:`, err);
    return now.toISOString();
  }
}

/**
 * Returns current local time in human form.
 */
export function nowHuman(timezone: string = DEFAULT_TIMEZONE, language = 'es', referenceTime: unknown = new Date()): string {
  const intlLocale = language === 'en' ? 'en-US' : language === 'pt' ? 'pt-BR' : 'es-CO';
  const requestedReference = referenceTime instanceof Date ? referenceTime : new Date(referenceTime as string | number);
  const now = Number.isNaN(requestedReference.getTime()) ? new Date() : requestedReference;
  try {
    return now.toLocaleString(intlLocale, {
      timeZone: timezone,
      weekday: 'long',
      day: 'numeric',
      month: 'long',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch (err) {
    console.error(`[time] nowHuman error with timezone ${timezone}:`, err);
    return new Date().toLocaleString();
  }
}

/**
 * Convert an ISO datetime into a human "in X minutes/hours/days/weeks" string.
 */
export function humanizeTimeUntil(targetDate: Date, language = 'es'): { value: number; unit: string; label: string } {
  const ms = targetDate.getTime() - Date.now();
  if (ms <= 0) {
    return {
      value: 0,
      unit: 'minutes',
      label: language === 'en' ? 'now' : language === 'pt' ? 'agora' : 'ahora',
    };
  }

  const minutes = Math.round(ms / (60 * 1000));
  if (minutes < 60) return { value: minutes, unit: 'minutes', label: pluralUnit(minutes, 'minutes', language) };
  const hours = Math.round(minutes / 60);
  if (hours < 24) return { value: hours, unit: 'hours', label: pluralUnit(hours, 'hours', language) };
  const days = Math.round(hours / 24);
  if (days < 14) return { value: days, unit: 'days', label: pluralUnit(days, 'days', language) };
  const weeks = Math.round(days / 7);
  return { value: weeks, unit: 'weeks', label: pluralUnit(weeks, 'weeks', language) };
}

export function formatLocalDateTime(date: unknown, timezone: string = DEFAULT_TIMEZONE, locale = 'es-CO'): string {
  try {
    return new Date(date as string | number).toLocaleString(locale, {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });
  } catch {
    return new Date(date as string | number).toLocaleString();
  }
}

/**
 * Format a Date or ISO string into a human-friendly natural date & 12-hour time string.
 * Examples:
 * - "Hoy a las 8:45 PM"
 * - "Mañana a las 8:00 AM"
 * - "Viernes, 4 de septiembre a las 10:00 AM"
 * - In English: "Today at 8:45 PM", "Tomorrow at 8:00 AM", "Friday, September 4 at 10:00 AM"
 *
 * @param {string|Date} date
 * @param {string} [timezone=DEFAULT_TIMEZONE]
 * @param {string} [language='es']
 * @returns {string}
 */
export function formatHumanFriendlyDateTime(date: unknown, timezone: string = DEFAULT_TIMEZONE, language = 'es', { includeYearWhenDifferent = false }: { includeYearWhenDifferent?: boolean } = {}): string {
  if (!date) return '';
  const d = date instanceof Date ? date : new Date(date as string | number);
  if (isNaN(d.getTime())) return String(date);

  const now = new Date();
  // Opt-in for reminder cards only; compare both calendar years in the user zone.
  const year = includeYearWhenDifferent ? getLocalDateParts(d, timezone).year : null;
  const showYear = includeYearWhenDifferent && year !== getLocalDateParts(now, timezone).year;

  // Get local date string for target date and current date
  const targetDateStr = d.toLocaleDateString('en-CA', { timeZone: timezone }); // 'YYYY-MM-DD'
  const nowDateStr = now.toLocaleDateString('en-CA', { timeZone: timezone });

  // Calculate tomorrow local date string
  const tomorrow = shiftZonedCalendarDays(now, 1, timezone)!;
  const tomorrowDateStr = tomorrow.toLocaleDateString('en-CA', { timeZone: timezone });

  // Format 12h time (e.g. "8:45 PM" or "8:45 AM")
  const time12 = d.toLocaleTimeString('en-US', {
    timeZone: timezone,
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });

  const isEs = !language || !language.startsWith('en');

  if (targetDateStr === nowDateStr) {
    return isEs ? `Hoy a las ${time12}` : `Today at ${time12}`;
  }

  if (targetDateStr === tomorrowDateStr && !showYear) {
    return isEs ? `Mañana a las ${time12}` : `Tomorrow at ${time12}`;
  }

  // For future/past dates, format as "Día, D de mes a las HH:MM AM/PM"
  if (isEs) {
    const weekday = d.toLocaleDateString('es-CO', { timeZone: timezone, weekday: 'long' });
    const dayNum = d.toLocaleDateString('es-CO', { timeZone: timezone, day: 'numeric' });
    const monthName = d.toLocaleDateString('es-CO', { timeZone: timezone, month: 'long' });
    const capitalizedWeekday = weekday.charAt(0).toUpperCase() + weekday.slice(1);
    return `${capitalizedWeekday}, ${dayNum} de ${monthName}${showYear ? ` de ${year}` : ''} a las ${time12}`;
  } else {
    const weekday = d.toLocaleDateString('en-US', { timeZone: timezone, weekday: 'long' });
    const dayNum = d.toLocaleDateString('en-US', { timeZone: timezone, day: 'numeric' });
    const monthName = d.toLocaleDateString('en-US', { timeZone: timezone, month: 'long' });
    return `${weekday}, ${monthName} ${dayNum}${showYear ? `, ${year}` : ''} at ${time12}`;
  }
}

/**
 * Format a Date object into human-friendly date string (e.g. "Miércoles, 14 de octubre" or "Hoy" / "Mañana").
 *
 * @param {string|Date} date
 * @param {string} [timezone=DEFAULT_TIMEZONE]
 * @param {string} [language='es']
 * @returns {string}
 */
export function formatHumanFriendlyDate(date: unknown, timezone: string = DEFAULT_TIMEZONE, language = 'es'): string {
  if (!date) return '';
  const d = date instanceof Date ? date : new Date(date as string | number);
  if (isNaN(d.getTime())) return String(date);

  const now = new Date();
  const targetDateStr = d.toLocaleDateString('en-CA', { timeZone: timezone });
  const nowDateStr = now.toLocaleDateString('en-CA', { timeZone: timezone });

  const tomorrow = shiftZonedCalendarDays(now, 1, timezone)!;
  const tomorrowDateStr = tomorrow.toLocaleDateString('en-CA', { timeZone: timezone });

  const isEs = !language || !language.startsWith('en');

  if (targetDateStr === nowDateStr) {
    return isEs ? 'Hoy' : 'Today';
  }

  if (targetDateStr === tomorrowDateStr) {
    return isEs ? 'Mañana' : 'Tomorrow';
  }

  if (isEs) {
    const weekday = d.toLocaleDateString('es-CO', { timeZone: timezone, weekday: 'long' });
    const dayNum = d.toLocaleDateString('es-CO', { timeZone: timezone, day: 'numeric' });
    const monthName = d.toLocaleDateString('es-CO', { timeZone: timezone, month: 'long' });
    const capitalizedWeekday = weekday.charAt(0).toUpperCase() + weekday.slice(1);
    return `${capitalizedWeekday}, ${dayNum} de ${monthName}`;
  }

  const weekday = d.toLocaleDateString('en-US', { timeZone: timezone, weekday: 'long' });
  const monthName = d.toLocaleDateString('en-US', { timeZone: timezone, month: 'long' });
  const dayNum = d.toLocaleDateString('en-US', { timeZone: timezone, day: 'numeric' });
  return `${weekday}, ${monthName} ${dayNum}`;
}

export function addMinutes(localStr: string, minutes: number, timezone: string = DEFAULT_TIMEZONE): string {
  const offset = computeOffsetMinutes(timezone);
  const d = new Date(localStr + offset);
  d.setMinutes(d.getMinutes() + minutes);
  return formatLocalISO(d, timezone);
}

export function todayAt(localStr: string, hour: number, minute: number, timezone: string = DEFAULT_TIMEZONE): string {
  const offset = computeOffsetMinutes(timezone);
  const d = new Date(localStr + offset);
  d.setHours(hour, minute, 0, 0);
  if (d.getTime() <= Date.now()) d.setDate(d.getDate() + 1);
  return formatLocalISO(d, timezone);
}

export function formatLocalISO(d: Date, timezone: string = DEFAULT_TIMEZONE): string {
  return new Date(d).toLocaleString('sv-SE', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).replace(' ', 'T');
}
