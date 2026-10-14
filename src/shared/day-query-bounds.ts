import { DEFAULT_TIMEZONE } from './timezone-arithmetic.js';
import type { CalendarScopeParams, CalendarTemporalRange } from './calendar-query-bounds.js';

export interface DayQueryDependencies {
  resolveCalendarTemporalScope(params: CalendarScopeParams, timezone: string): CalendarTemporalRange;
}

/** Retains legacy scope delegation, including next-event null end and native string coercion. */
export function createDayQueryBounds({ resolveCalendarTemporalScope }: DayQueryDependencies) {
  /**
   * Compute exact semi-open time bounds [timeMin, timeMax) for a local day in the given timezone.
   *
   * @param {'today'|'tomorrow'|'hoy'|'mañana'|string|Date} [target='today']
   * @param {string} [timezone=DEFAULT_TIMEZONE]
   * @returns {{ timeMin: Date, timeMax: Date|null }}
   */
  function getDayBounds(target: unknown = 'today', timezone: string = DEFAULT_TIMEZONE): { timeMin: Date; timeMax: Date | null } {
    const t = String(target || 'today').toLowerCase().trim();
    const isDate = /^\d{4}-\d{2}-\d{2}/.test(t);
    const resolved = resolveCalendarTemporalScope(
      isDate ? { scope: 'explicit_date', date: t } : { scope: t, fullDay: true },
      timezone
    );
    return { timeMin: resolved.timeMin, timeMax: resolved.timeMax };
  }
  return { getDayBounds };
}
