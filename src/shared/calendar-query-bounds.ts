import { DEFAULT_TIMEZONE, getLocalDateParts, zonedTimeToUtc } from './timezone-arithmetic.js';
export interface CalendarScopeParams extends Record<string, unknown> { query?: string | null }
export type CalendarTemporalRange =
  | { timeMin: Date; timeMax: null; isNextEvent: true; maxResults: 1; scope: 'next_event' }
  | { timeMin: Date; timeMax: Date; isNextEvent: false; maxResults: number; scope: string };
export interface CalendarScopeDependencies { parseTargetTime(value: unknown, timezone: string): Date | null }

export const MONTH_NAME_MAP: Readonly<Record<string, number>> = Object.freeze({
  enero: 1, enero_: 1, jan: 1, january: 1,
  febrero: 2, feb: 2, february: 2,
  marzo: 3, mar: 3, march: 3,
  abril: 4, apr: 4, april: 4,
  mayo: 5, may: 5,
  junio: 6, jun: 6, june: 6,
  julio: 7, jul: 7, july: 7,
  agosto: 8, aug: 8, august: 8,
  septiembre: 9, setiembre: 9, sep: 9, sept: 9, september: 9,
  octubre: 10, oct: 10, october: 10,
  noviembre: 11, nov: 11, november: 11,
  diciembre: 12, dec: 12, december: 12,
});

function monthNumber(key: string): number | undefined {
  return Object.hasOwn(MONTH_NAME_MAP, key) ? MONTH_NAME_MAP[key] : undefined;
}

/** Bound construction preserves existing query policy; parsing remains an injected host helper. */
export function createCalendarScopeResolver(dependencies: CalendarScopeDependencies) {
  const { parseTargetTime } = dependencies;

  /**
   * Resolves structured Google Calendar temporal scope into exact deterministic bounds.
   *
   * @param {object} [params]
   * @param {string} [params.scope] - 'today'|'tomorrow'|'this_week'|'next_week'|'this_weekend'|'default_upcoming'|'next_event'|'explicit_date'|'explicit_range'|'month'
   * @param {string} [params.date] - 'YYYY-MM-DD' or date string
   * @param {string} [params.dateFrom] - 'YYYY-MM-DD'
   * @param {string} [params.dateTo] - 'YYYY-MM-DD'
   * @param {string|number} [params.month] - '10' or 'octubre'
   * @param {string} [params.timeMin] - Fallback string
   * @param {string} [params.timeMax] - Fallback string
   * @param {string} [timezone=DEFAULT_TIMEZONE]
   * @param {Date} [now=new Date()]
   * @returns {{ timeMin: Date, timeMax: Date|null, isNextEvent: boolean, maxResults: number, scope: string }}
   */
  function resolveCalendarTemporalScope(params: CalendarScopeParams = {}, timezone: string = DEFAULT_TIMEZONE, now: Date = new Date()): CalendarTemporalRange {
    const { year, month, day, dayOfWeek } = getLocalDateParts(now, timezone);

    // Normalize requested scope or infer from parameters
    let scope = params.scope ? String(params.scope).toLowerCase().trim() : null;
    const rawMin = params.timeMin ? String(params.timeMin).toLowerCase().trim() : null;
    const rawMax = params.timeMax ? String(params.timeMax).toLowerCase().trim() : null;

    const WEEKDAY_MAP: Readonly<Record<string, number>> = {
      'domingo': 0, 'sunday': 0, 'sun': 0,
      'lunes': 1, 'monday': 1, 'mon': 1,
      'martes': 2, 'tuesday': 2, 'tue': 2,
      'miercoles': 3, 'miércoles': 3, 'wednesday': 3, 'wed': 3,
      'jueves': 4, 'thursday': 4, 'thu': 4,
      'viernes': 5, 'friday': 5, 'fri': 5,
      'sabado': 6, 'sábado': 6, 'saturday': 6, 'sat': 6,
    };

    const WEEKDAY_NAME_REV: Readonly<Record<number, string>> = {
      0: 'sunday', 1: 'monday', 2: 'tuesday', 3: 'wednesday', 4: 'thursday', 5: 'friday', 6: 'saturday'
    };

    if (scope && /^\d{4}-\d{2}-\d{2}/.test(scope)) {
      if (!params.date) params.date = scope;
      scope = 'explicit_date';
    }

    // Check if scope, date, or query is a weekday name (e.g. "viernes", "el viernes", "este viernes", "friday")
    const checkWeekdayStr = (str: unknown): number | null => {
      if (!str) return null;
      const clean = String(str).toLowerCase().trim()
        .replace(/^(?:el|este|este\s+próximo|este\s+proximo|el\s+próximo|el\s+proximo)\s+/i, '')
        .replace(/\s+/g, '');
      if (Object.hasOwn(WEEKDAY_MAP, clean)) return WEEKDAY_MAP[clean]!;
      // Check inside string
      for (const [name, val] of Object.entries(WEEKDAY_MAP)) {
        if (clean === name || clean.startsWith(name)) return val;
      }
      return null;
    };

    // A canonical monthly scope must not be consumed by the legacy 'mon' prefix.
    const matchedWeekday = scope === 'month' ? null
      : checkWeekdayStr(scope) ?? checkWeekdayStr(params.date) ?? checkWeekdayStr(params.query) ?? checkWeekdayStr(rawMin);

    if (matchedWeekday !== null) {
      const isNext = Boolean(
        (scope && (scope.includes('proximo') || scope.includes('próximo') || scope.includes('next'))) ||
        (params.query && (params.query.includes('proximo') || params.query.includes('próximo') || params.query.includes('next')))
      );
      let diff = (matchedWeekday - dayOfWeek + 7) % 7;
      if (diff === 0 && isNext) {
        diff = 7;
      }
      const timeMin = zonedTimeToUtc(year, month, day + diff, 0, 0, 0, timezone);
      const timeMax = zonedTimeToUtc(year, month, day + diff + 1, 0, 0, 0, timezone);
      const canonicalScope = WEEKDAY_NAME_REV[matchedWeekday] || 'weekday';
      return { timeMin, timeMax, isNextEvent: false, maxResults: 25, scope: canonicalScope };
    }

    if (!scope) {
      if (rawMin === 'hoy' || rawMin === 'today') scope = 'today';
      else if (rawMin === 'mañana' || rawMin === 'tomorrow') scope = 'tomorrow';
      else if (rawMin === 'pasado_mañana' || rawMin === 'pasado_manana' || rawMin === 'pasado mañana' || rawMin === 'day_after_tomorrow') scope = 'day_after_tomorrow';
      else if (rawMin === 'esta_semana' || rawMin === 'this_week') scope = 'this_week';
      else if (rawMin === 'proxima_semana' || rawMin === 'next_week') scope = 'next_week';
      else if (rawMin === 'este_fin_de_semana' || rawMin === 'this_weekend') scope = 'this_weekend';
      else if (rawMin === 'proximo' || rawMin === 'next_event' || rawMin === 'mas_cercano' || rawMin === 'closest') scope = 'next_event';
      else if (params.dateFrom && params.dateTo) scope = 'explicit_range';
      else if (params.date || (rawMin && /^\d{4}-\d{2}-\d{2}/.test(rawMin))) scope = 'explicit_date';
      else if (params.month) scope = 'month';
      else if (rawMin === 'este_ano' || rawMin === 'este_año' || rawMin === 'this_year' || rawMin === 'full_year') scope = 'full_year';
      else if (rawMin === 'resto_del_ano' || rawMin === 'resto_del_año' || rawMin === 'remaining_year') scope = 'remaining_year';
      else if (rawMin === 'todos' || rawMin === 'pendientes' || rawMin === 'upcoming' || rawMin === 'all') scope = 'upcoming';
      else if (rawMin && rawMax) scope = 'custom_range';
      else if (rawMin) scope = 'from_time';
      else scope = 'default_upcoming';
    }

    switch (scope) {
      case 'upcoming':
      case 'all':
      case 'all_pending':
      case 'todos':
      case 'pendientes':
      case 'todos_los_pendientes': {
        // From now until the end of next month / year (covers all upcoming items in chronological order)
        const timeMin = now;
        const timeMax = zonedTimeToUtc(year + 1, 1, 1, 0, 0, 0, timezone);
        return { timeMin, timeMax, isNextEvent: false, maxResults: 10, scope: 'upcoming' };
      }

      case 'today':
      case 'hoy': {
        const startOfDay = zonedTimeToUtc(year, month, day, 0, 0, 0, timezone);
        const timeMin = params.fullDay ? startOfDay : now;
        const timeMax = zonedTimeToUtc(year, month, day + 1, 0, 0, 0, timezone);
        return { timeMin, timeMax, isNextEvent: false, maxResults: 15, scope: 'today' };
      }

      case 'remaining_today':
      case 'rest_of_today':
      case 'lo_que_queda_de_hoy': {
        const timeMin = now;
        const timeMax = zonedTimeToUtc(year, month, day + 1, 0, 0, 0, timezone);
        return { timeMin, timeMax, isNextEvent: false, maxResults: 15, scope: 'remaining_today' };
      }

      case 'tomorrow':
      case 'mañana': {
        const timeMin = zonedTimeToUtc(year, month, day + 1, 0, 0, 0, timezone);
        const timeMax = zonedTimeToUtc(year, month, day + 2, 0, 0, 0, timezone);
        return { timeMin, timeMax, isNextEvent: false, maxResults: 15, scope: 'tomorrow' };
      }

      case 'day_after_tomorrow':
      case 'pasado_mañana':
      case 'pasado_manana':
      case 'pasado mañana': {
        const timeMin = zonedTimeToUtc(year, month, day + 2, 0, 0, 0, timezone);
        const timeMax = zonedTimeToUtc(year, month, day + 3, 0, 0, 0, timezone);
        return { timeMin, timeMax, isNextEvent: false, maxResults: 15, scope: 'day_after_tomorrow' };
      }

      case 'this_week':
      case 'esta_semana': {
        // Hermes week starts on Monday (dayOfWeek = 1). Sunday is dayOfWeek = 0.
        const distToMonday = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
        const distToNextMonday = dayOfWeek === 0 ? 1 : 8 - dayOfWeek;
        const timeMin = zonedTimeToUtc(year, month, day - distToMonday, 0, 0, 0, timezone);
        const timeMax = zonedTimeToUtc(year, month, day + distToNextMonday, 0, 0, 0, timezone);
        return { timeMin, timeMax, isNextEvent: false, maxResults: 15, scope: 'this_week' };
      }

      case 'next_week':
      case 'proxima_semana': {
        const distToNextMonday = dayOfWeek === 0 ? 1 : 8 - dayOfWeek;
        const distToMondayAfterNext = dayOfWeek === 0 ? 8 : 15 - dayOfWeek;
        const timeMin = zonedTimeToUtc(year, month, day + distToNextMonday, 0, 0, 0, timezone);
        const timeMax = zonedTimeToUtc(year, month, day + distToMondayAfterNext, 0, 0, 0, timezone);
        return { timeMin, timeMax, isNextEvent: false, maxResults: 15, scope: 'next_week' };
      }

      case 'this_weekend':
      case 'este_fin_de_semana': {
        // Viernes: sábado mañana a lunes. Sábado: sábado hoy a lunes. Domingo: domingo hoy a lunes. Lunes-Jueves: próximo sábado a lunes.
        let startOffset = 0;
        let endOffset = 0;
        if (dayOfWeek === 5) {
          startOffset = 1;
          endOffset = 3;
        } else if (dayOfWeek === 6) {
          startOffset = 0;
          endOffset = 2;
        } else if (dayOfWeek === 0) {
          startOffset = 0;
          endOffset = 1;
        } else {
          startOffset = 6 - dayOfWeek;
          endOffset = 8 - dayOfWeek;
        }
        const timeMin = zonedTimeToUtc(year, month, day + startOffset, 0, 0, 0, timezone);
        const timeMax = zonedTimeToUtc(year, month, day + endOffset, 0, 0, 0, timezone);
        return { timeMin, timeMax, isNextEvent: false, maxResults: 20, scope: 'this_weekend' };
      }

      case 'next_event':
      case 'proximo':
      case 'mas_cercano':
      case 'closest': {
        // Sole documented exception: singleEvents=true, orderBy=startTime, maxResults=1 with timeMin=now, timeMax=null
        return { timeMin: now, timeMax: null, isNextEvent: true, maxResults: 1, scope: 'next_event' };
      }

      case 'explicit_date': {
        const targetStr = String(params.date || params.timeMin || '').trim();
        let targetYear = year;
        let targetMonth = month;
        let targetDay = day;

        const dateMatch = targetStr.match(/^(\d{4})-(\d{2})-(\d{2})/);
        if (dateMatch) {
          targetYear = parseInt(dateMatch[1]!, 10);
          targetMonth = parseInt(dateMatch[2]!, 10);
          targetDay = parseInt(dateMatch[3]!, 10);
        } else {
          const naturalMatch = targetStr.match(/^(\d{1,2})\s+de\s+([a-záéíóúñ]+)(?:\s+de\s+(\d{4}))?/i);
          if (naturalMatch) {
            targetDay = parseInt(naturalMatch[1]!, 10);
            const mName = naturalMatch[2]!.toLowerCase();
            targetMonth = monthNumber(mName) || month;
            if (naturalMatch[3]) {
              targetYear = parseInt(naturalMatch[3], 10);
            } else if (targetMonth < month) {
              targetYear += 1;
            }
          } else {
            const parsed = parseTargetTime(targetStr, timezone);
            if (parsed) {
              const parts = getLocalDateParts(parsed, timezone);
              targetYear = parts.year;
              targetMonth = parts.month;
              targetDay = parts.day;
            }
          }
        }

        const timeMin = zonedTimeToUtc(targetYear, targetMonth, targetDay, 0, 0, 0, timezone);
        const timeMax = zonedTimeToUtc(targetYear, targetMonth, targetDay + 1, 0, 0, 0, timezone);
        return { timeMin, timeMax, isNextEvent: false, maxResults: 20, scope: 'explicit_date' };
      }

      case 'explicit_range': {
        const fromStr = String(params.dateFrom || params.timeMin || '').trim();
        const toStr = String(params.dateTo || params.timeMax || '').trim();

        let fromY = year, fromM = month, fromD = day;
        let toY = year, toM = month, toD = day;

        const matchFrom = fromStr.match(/^(\d{4})-(\d{2})-(\d{2})/);
        if (matchFrom) {
          fromY = parseInt(matchFrom[1]!, 10);
          fromM = parseInt(matchFrom[2]!, 10);
          fromD = parseInt(matchFrom[3]!, 10);
        } else {
          const p = parseTargetTime(fromStr, timezone);
          if (p) {
            const parts = getLocalDateParts(p, timezone);
            fromY = parts.year; fromM = parts.month; fromD = parts.day;
          }
        }

        const matchTo = toStr.match(/^(\d{4})-(\d{2})-(\d{2})/);
        if (matchTo) {
          toY = parseInt(matchTo[1]!, 10);
          toM = parseInt(matchTo[2]!, 10);
          toD = parseInt(matchTo[3]!, 10);
        } else {
          const p = parseTargetTime(toStr, timezone);
          if (p) {
            const parts = getLocalDateParts(p, timezone);
            toY = parts.year; toM = parts.month; toD = parts.day;
          }
        }

        const timeMin = zonedTimeToUtc(fromY, fromM, fromD, 0, 0, 0, timezone);
        const timeMax = zonedTimeToUtc(toY, toM, toD + 1, 0, 0, 0, timezone);
        return { timeMin, timeMax, isNextEvent: false, maxResults: 35, scope: 'explicit_range' };
      }

      case 'month': {
        const rawMonthStr = String(params.month || '').toLowerCase().trim();
        let targetMonthNum = monthNumber(rawMonthStr) || parseInt(rawMonthStr, 10);
        if (!targetMonthNum || isNaN(targetMonthNum) || targetMonthNum < 1 || targetMonthNum > 12) {
          targetMonthNum = month;
        }
        let targetYearNum = year;
        if (targetMonthNum < month) {
          targetYearNum += 1;
        }
        const timeMin = zonedTimeToUtc(targetYearNum, targetMonthNum, 1, 0, 0, 0, timezone);
        const timeMax = zonedTimeToUtc(targetYearNum, targetMonthNum + 1, 1, 0, 0, 0, timezone);
        return { timeMin, timeMax, isNextEvent: false, maxResults: 50, scope: 'month' };
      }

      case 'full_year':
      case 'este_ano':
      case 'este_año':
      case 'todo_el_ano':
      case 'todo_el_año':
      case 'this_year': {
        // 01 de enero 00:00 local -> 01 de enero del siguiente año 00:00 local
        const timeMin = zonedTimeToUtc(year, 1, 1, 0, 0, 0, timezone);
        const timeMax = zonedTimeToUtc(year + 1, 1, 1, 0, 0, 0, timezone);
        return { timeMin, timeMax, isNextEvent: false, maxResults: 50, scope: 'full_year' };
      }

      case 'remaining_year':
      case 'resto_del_ano':
      case 'resto_del_año':
      case 'lo_que_queda_del_ano':
      case 'lo_que_queda_del_año': {
        // now -> 01 de enero del siguiente año 00:00 local
        const timeMin = now;
        const timeMax = zonedTimeToUtc(year + 1, 1, 1, 0, 0, 0, timezone);
        return { timeMin, timeMax, isNextEvent: false, maxResults: 50, scope: 'remaining_year' };
      }

      case 'custom_range': {
        const timeMin = parseTargetTime(params.timeMin, timezone) || now;
        const timeMax = parseTargetTime(params.timeMax, timezone) || zonedTimeToUtc(year, month, day + 15, 0, 0, 0, timezone);
        return { timeMin, timeMax, isNextEvent: false, maxResults: 30, scope: 'custom_range' };
      }

      case 'from_time': {
        const timeMin = parseTargetTime(params.timeMin, timezone) || now;
        const distToMondayAfterNext = dayOfWeek === 0 ? 8 : 15 - dayOfWeek;
        const timeMax = zonedTimeToUtc(year, month, day + distToMondayAfterNext, 0, 0, 0, timezone);
        return { timeMin, timeMax, isNextEvent: false, maxResults: 20, scope: 'from_time' };
      }

      case 'default_upcoming':
      default: {
        // Default: now -> start of Monday after next week (covers now through next Sunday 23:59:59.999 + 1ms)
        const distToMondayAfterNext = dayOfWeek === 0 ? 8 : 15 - dayOfWeek;
        const timeMin = now;
        const timeMax = zonedTimeToUtc(year, month, day + distToMondayAfterNext, 0, 0, 0, timezone);
        return { timeMin, timeMax, isNextEvent: false, maxResults: 20, scope: 'default_upcoming' };
      }
    }
  }


  return { resolveCalendarTemporalScope };
}
