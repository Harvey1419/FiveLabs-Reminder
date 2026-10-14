export interface TemporalSchedule extends Record<string, unknown> {
  kind?: string; clockMode?: string; allDay?: boolean;
  hour?: number | null; minute?: number | null; year?: number | null;
  month?: number | null; day?: number | null; dayOffset?: number | null;
  weekOffset?: number | null; offsetMinutes?: number | null; weekday?: string;
}
export interface ScheduleContext { referenceTime?: Date | string | number; timezone?: string; baseDate?: unknown }
export interface ScheduleFailure { valid: false; errorCode: string; error: string }
export interface ScheduleSuccess {
  valid: true; date: Date | null; canonical: string | null; temporalKind?: string;
  canonicalDate?: string; isAllDay?: boolean; inherited?: boolean;
  clockResolution?: string; resolvedHour?: number;
}
export type ScheduleResolution = ScheduleFailure | ScheduleSuccess;
type ClockSchedule = TemporalSchedule & { hour: number; minute: number };
type CalendarParts = { year: number; month: number; day: number };
type BuiltDate = { valid: true; date: Date; canonical: string; clockResolution?: string; resolvedHour?: number };
export interface ScheduleDependencies {
  getLocalDateParts(date: Date, timezone: string): CalendarParts & { dayOfWeek: number };
  zonedTimeToUtc(year: number, month: number, day: number, hour: number, minute: number, second: number, timezone: string): Date;
}
function integer(value: unknown): value is number { return Number.isInteger(value); }
/** Resolve structured calendar components; model admission and domain execution remain separate. */
export function createScheduleResolver(dependencies: ScheduleDependencies) {
  const { getLocalDateParts, zonedTimeToUtc } = dependencies;

  const WEEKDAYS: Readonly<Record<string, number>> = Object.freeze({
    sunday: 0,
    monday: 1,
    tuesday: 2,
    wednesday: 3,
    thursday: 4,
    friday: 5,
    saturday: 6,
  });

  function weekdayIndex(value: unknown): number | undefined {
    return typeof value === 'string' && Object.hasOwn(WEEKDAYS, value) ? WEEKDAYS[value] : undefined;
  }

  function failure(errorCode: string, error: string): ScheduleFailure {
    return { valid: false, errorCode, error };
  }

  function localDateTimeParts(date: Date, timezone: string): Record<string, number> {
    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      year: 'numeric', month: 'numeric', day: 'numeric',
      hour: 'numeric', minute: 'numeric', second: 'numeric',
      hourCycle: 'h23',
    });
    const result: Record<string, number> = {};
    for (const { type, value } of formatter.formatToParts(date)) {
      if (type !== 'literal') result[type] = Number(value);
    }
    return result;
  }

  function validClock(schedule: TemporalSchedule): schedule is ClockSchedule {
    return integer(schedule?.hour)
      && schedule.hour >= 0 && schedule.hour <= 23
      && integer(schedule?.minute)
      && schedule.minute >= 0 && schedule.minute <= 59;
  }

  function buildLocalDate({ year, month, day, hour, minute }: CalendarParts & { hour: number; minute: number }, timezone: string): ScheduleFailure | BuiltDate {
    const calendarProbe = new Date(Date.UTC(year, month - 1, day));
    if (
      calendarProbe.getUTCFullYear() !== year
      || calendarProbe.getUTCMonth() + 1 !== month
      || calendarProbe.getUTCDate() !== day
    ) {
      return failure('INVALID_CALENDAR_DATE', 'La fecha indicada no existe.');
    }

    const date = zonedTimeToUtc(year, month, day, hour, minute, 0, timezone);
    const roundTrip = localDateTimeParts(date, timezone);
    if (
      roundTrip.year !== year || roundTrip.month !== month || roundTrip.day !== day
      || roundTrip.hour !== hour || roundTrip.minute !== minute
    ) {
      return failure('INVALID_LOCAL_TIME', 'La hora local indicada no existe en esa zona horaria.');
    }
    return { valid: true, date, canonical: date.toISOString() };
  }

  function clockHours(schedule: ClockSchedule): ScheduleFailure | { valid: true; hours: [number] | [number, number] } {
    const { hour, clockMode } = schedule;
    if (clockMode === 'explicit_am' || clockMode === 'explicit_pm' || clockMode === 'ambiguous_12h') {
      if (!integer(hour) || hour < 1 || hour > 12) {
        return failure('INVALID_12H_CLOCK', 'La hora de 12 horas debe estar entre 1 y 12.');
      }
      const amHour = hour === 12 ? 0 : hour;
      if (clockMode === 'explicit_am') return { valid: true, hours: [amHour] };
      if (clockMode === 'explicit_pm') return { valid: true, hours: [amHour + 12] };
      return { valid: true, hours: [amHour, amHour + 12] };
    }
    return { valid: true, hours: [hour] };
  }

  function buildResolvedClockDate({ year, month, day }: CalendarParts, schedule: ClockSchedule, timezone: string, referenceDate: Date): ScheduleFailure | BuiltDate {
    const resolvedHours = clockHours(schedule);
    if (!resolvedHours.valid) return resolvedHours;

    const candidates = resolvedHours.hours.map((hour) => buildLocalDate({
      year, month, day, hour, minute: schedule.minute,
    }, timezone));
    const invalid = candidates.find((candidate): candidate is ScheduleFailure => !candidate.valid);
    if (invalid) return invalid;

    const validCandidates = candidates.filter((candidate): candidate is BuiltDate => candidate.valid);
    if (schedule.clockMode !== 'ambiguous_12h') return validCandidates[0]!;
    const futureCandidate = validCandidates.find((candidate) => candidate.date.getTime() > referenceDate.getTime());
    const selected = futureCandidate || validCandidates[validCandidates.length - 1]!;
    return {
      ...selected,
      clockResolution: 'nearest_future_on_local_date',
      resolvedHour: resolvedHours.hours[validCandidates.indexOf(selected)]!,
    };
  }

  /**
   * Resolve already-typed temporal meaning. This function never interprets
   * natural-language phrases; the LLM provides semantic time components and
   * Node owns timezone/calendar arithmetic.
   */
  function resolveTypedSchedule(input: unknown, {
    referenceTime = new Date(), timezone = 'America/Bogota', baseDate = null,
  }: ScheduleContext = {}): ScheduleResolution {
    const schedule = input as TemporalSchedule | null | undefined;
    if (!schedule?.kind) return failure('MISSING_SCHEDULE', 'Falta la estructura temporal.');

    let normalizedSchedule = integer(schedule.hour) && schedule.minute == null
      ? { ...schedule, minute: 0 }
      : { ...schedule };

    if ((normalizedSchedule.kind === 'local_time' || normalizedSchedule.kind === 'calendar_date_time')
      && integer(normalizedSchedule.dayOffset)
      && (!integer(normalizedSchedule.month) || !integer(normalizedSchedule.day))) {
      normalizedSchedule.kind = 'relative_day_time';
    }

    const reference = referenceTime instanceof Date ? referenceTime : new Date(referenceTime);
    if (Number.isNaN(reference.getTime())) return failure('INVALID_REFERENCE_TIME', 'La hora de referencia no es válida.');

    if (normalizedSchedule.kind === 'relative_offset') {
      if (!integer(normalizedSchedule.offsetMinutes) || normalizedSchedule.offsetMinutes < 0 || normalizedSchedule.offsetMinutes > 525600) {
        return failure('INVALID_RELATIVE_OFFSET', 'El desplazamiento temporal no es válido.');
      }
      const date = new Date(reference.getTime() + normalizedSchedule.offsetMinutes * 60_000);
      return { valid: true, date, canonical: date.toISOString(), temporalKind: normalizedSchedule.kind };
    }

    if (normalizedSchedule.kind === 'inherit_context') {
      const inherited = baseDate instanceof Date ? baseDate : new Date((baseDate || NaN) as string | number);
      if (Number.isNaN(inherited.getTime())) {
        // A partial update may intentionally preserve an existing field without
        // having that value in short-term memory. Return an explicit no-op delta;
        // domain tools must omit null inherited values rather than inventing one.
        return {
          valid: true,
          date: null,
          canonical: null,
          temporalKind: normalizedSchedule.kind,
          inherited: false,
        };
      }
      return {
        valid: true,
        date: inherited,
        canonical: inherited.toISOString(),
        temporalKind: normalizedSchedule.kind,
        inherited: true,
      };
    }

    const isAllDay = normalizedSchedule.allDay === true
      || (normalizedSchedule.hour == null && isDateBearingSchedule(normalizedSchedule));

    if (isAllDay) {
      let year: number;
      let month: number;
      let day: number;
      const referenceParts = getLocalDateParts(reference, timezone);

      if (normalizedSchedule.kind === 'calendar_date_time') {
        if (!integer(normalizedSchedule.month) || !integer(normalizedSchedule.day)) {
          return failure('MISSING_CALENDAR_DATE', 'Faltan componentes de la fecha de calendario.');
        }
        year = integer(normalizedSchedule.year)
          ? normalizedSchedule.year
          : referenceParts.year;
        month = normalizedSchedule.month;
        day = normalizedSchedule.day;
      } else if (normalizedSchedule.kind === 'relative_day_time') {
        if (!integer(normalizedSchedule.dayOffset) || normalizedSchedule.dayOffset < 0 || normalizedSchedule.dayOffset > 365) {
          return failure('INVALID_DAY_OFFSET', 'El desplazamiento de días no es válido.');
        }
        const shifted = new Date(Date.UTC(referenceParts.year, referenceParts.month - 1, referenceParts.day + normalizedSchedule.dayOffset));
        year = shifted.getUTCFullYear();
        month = shifted.getUTCMonth() + 1;
        day = shifted.getUTCDate();
      } else if (normalizedSchedule.kind === 'weekday_time') {
        const targetWeekday = weekdayIndex(normalizedSchedule.weekday);
        if (targetWeekday === undefined) return failure('INVALID_WEEKDAY', 'El día de la semana no es válido.');
        const weekOffset = normalizedSchedule.weekOffset ?? 0;
        if (!integer(weekOffset) || weekOffset < 0 || weekOffset > 52) {
          return failure('INVALID_WEEK_OFFSET', 'La semana relativa no es válida.');
        }
        const dayOffset = ((targetWeekday - referenceParts.dayOfWeek + 7) % 7) + weekOffset * 7;
        const shifted = new Date(Date.UTC(referenceParts.year, referenceParts.month - 1, referenceParts.day + dayOffset));
        year = shifted.getUTCFullYear();
        month = shifted.getUTCMonth() + 1;
        day = shifted.getUTCDate();
      } else {
        return failure('UNSUPPORTED_ALL_DAY_SCHEDULE', `El tipo temporal ${normalizedSchedule.kind} no admite día completo sin fecha.`);
      }

      const canonicalDate = [
        year,
        String(month).padStart(2, '0'),
        String(day).padStart(2, '0'),
      ].join('-');
      const built = buildLocalDate({ year, month, day, hour: 9, minute: 0 }, timezone);
      if (!built.valid) return built;
      return {
        ...built,
        canonicalDate,
        isAllDay: true,
        temporalKind: normalizedSchedule.kind,
      };
    }

    if (!validClock(normalizedSchedule)) return failure('MISSING_CLOCK_TIME', 'Falta una hora de reloj completa y válida.');

    if (normalizedSchedule.kind === 'calendar_date_time') {
      if (!integer(normalizedSchedule.month) || !integer(normalizedSchedule.day)) {
        return failure('MISSING_CALENDAR_DATE', 'Faltan componentes de la fecha de calendario.');
      }
      if (!integer(normalizedSchedule.year)) {
        normalizedSchedule.year = getLocalDateParts(reference, timezone).year;
      }
      const built = buildResolvedClockDate({ year: normalizedSchedule.year!, month: normalizedSchedule.month, day: normalizedSchedule.day }, normalizedSchedule, timezone, reference);
      if (!built.valid) return built;
      const canonicalDate = [
        normalizedSchedule.year,
        String(normalizedSchedule.month).padStart(2, '0'),
        String(normalizedSchedule.day).padStart(2, '0'),
      ].join('-');
      return { ...built, canonicalDate, isAllDay: false, temporalKind: normalizedSchedule.kind };
    }

    const referenceParts = getLocalDateParts(reference, timezone);
    let year = referenceParts.year;
    let month = referenceParts.month;
    let day = referenceParts.day;

    if (normalizedSchedule.kind === 'relative_day_time') {
      if (!integer(normalizedSchedule.dayOffset) || normalizedSchedule.dayOffset < 0 || normalizedSchedule.dayOffset > 365) {
        return failure('INVALID_DAY_OFFSET', 'El desplazamiento de días no es válido.');
      }
      const shifted = new Date(Date.UTC(year, month - 1, day + normalizedSchedule.dayOffset));
      year = shifted.getUTCFullYear();
      month = shifted.getUTCMonth() + 1;
      day = shifted.getUTCDate();
    } else if (normalizedSchedule.kind === 'weekday_time') {
      const targetWeekday = weekdayIndex(normalizedSchedule.weekday);
      if (targetWeekday === undefined) return failure('INVALID_WEEKDAY', 'El día de la semana no es válido.');
      const weekOffset = normalizedSchedule.weekOffset ?? 0;
      if (!integer(weekOffset) || weekOffset < 0 || weekOffset > 52) {
        return failure('INVALID_WEEK_OFFSET', 'La semana relativa no es válida.');
      }
      const dayOffset = ((targetWeekday - referenceParts.dayOfWeek + 7) % 7) + weekOffset * 7;
      const shifted = new Date(Date.UTC(year, month - 1, day + dayOffset));
      year = shifted.getUTCFullYear();
      month = shifted.getUTCMonth() + 1;
      day = shifted.getUTCDate();
    } else if (normalizedSchedule.kind === 'local_time') {
      const inherited = baseDate instanceof Date ? baseDate : new Date((baseDate || NaN) as string | number);
      if (!Number.isNaN(inherited.getTime())) {
        const parts = getLocalDateParts(inherited, timezone);
        year = parts.year;
        month = parts.month;
        day = parts.day;
      }
    } else {
      return failure('UNSUPPORTED_SCHEDULE_KIND', `Tipo temporal no soportado: ${normalizedSchedule.kind}.`);
    }

    const built = buildResolvedClockDate({ year, month, day }, normalizedSchedule, timezone, reference);
    if (!built.valid) return built;
    const canonicalDate = [
      year,
      String(month).padStart(2, '0'),
      String(day).padStart(2, '0'),
    ].join('-');
    return { ...built, canonicalDate, isAllDay: false, temporalKind: normalizedSchedule.kind };
  }

  function scheduleHasClock(schedule: TemporalSchedule | null | undefined): boolean {
    return integer(schedule?.hour);
  }

  function clockFields(schedule: TemporalSchedule): Partial<TemporalSchedule> {
    if (!scheduleHasClock(schedule)) return {};
    return {
      hour: schedule.hour!,
      minute: integer(schedule.minute) ? schedule.minute : 0,
      ...(schedule.clockMode ? { clockMode: schedule.clockMode } : {}),
    };
  }

  function isDateBearingSchedule(schedule: TemporalSchedule | null | undefined): boolean {
    return ['relative_day_time', 'calendar_date_time', 'weekday_time'].includes(schedule?.kind || '');
  }

  function cloneJson<T>(value: T): T {
    return value ? JSON.parse(JSON.stringify(value)) : value;
  }

  /** Merge typed temporal components without interpreting natural-language text. */
  function mergePendingSchedule(baseSchedule: TemporalSchedule | null | undefined, deltaSchedule: TemporalSchedule | null | undefined): TemporalSchedule | null {
    if (!deltaSchedule) return baseSchedule ? cloneJson(baseSchedule) : null;
    if (!baseSchedule || deltaSchedule.kind === 'relative_offset') return cloneJson(deltaSchedule);
    if (deltaSchedule.kind === 'inherit_context') return cloneJson(baseSchedule);

    if (deltaSchedule.kind === 'local_time' && isDateBearingSchedule(baseSchedule)) {
      return { ...cloneJson(baseSchedule), ...clockFields(deltaSchedule) };
    }

    if (isDateBearingSchedule(deltaSchedule)) {
      return {
        ...cloneJson(deltaSchedule),
        ...(scheduleHasClock(deltaSchedule) ? {} : clockFields(baseSchedule)),
      };
    }

    return cloneJson(deltaSchedule);
  }


  return { resolveTypedSchedule, mergePendingSchedule };
}
