import { getLocalDateParts, zonedTimeToUtc } from '../../shared/time.js';

const WEEKDAYS = Object.freeze({
  sunday: 0,
  monday: 1,
  tuesday: 2,
  wednesday: 3,
  thursday: 4,
  friday: 5,
  saturday: 6,
});

function failure(errorCode, error) {
  return { valid: false, errorCode, error };
}

function localDateTimeParts(date, timezone) {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric', month: 'numeric', day: 'numeric',
    hour: 'numeric', minute: 'numeric', second: 'numeric',
    hourCycle: 'h23',
  });
  const result = {};
  for (const { type, value } of formatter.formatToParts(date)) {
    if (type !== 'literal') result[type] = Number(value);
  }
  return result;
}

function validClock(schedule) {
  return Number.isInteger(schedule?.hour)
    && schedule.hour >= 0 && schedule.hour <= 23
    && Number.isInteger(schedule?.minute)
    && schedule.minute >= 0 && schedule.minute <= 59;
}

function buildLocalDate({ year, month, day, hour, minute }, timezone) {
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

function clockHours(schedule) {
  const { hour, clockMode } = schedule;
  if (clockMode === 'explicit_am' || clockMode === 'explicit_pm' || clockMode === 'ambiguous_12h') {
    if (!Number.isInteger(hour) || hour < 1 || hour > 12) {
      return failure('INVALID_12H_CLOCK', 'La hora de 12 horas debe estar entre 1 y 12.');
    }
    const amHour = hour === 12 ? 0 : hour;
    if (clockMode === 'explicit_am') return { valid: true, hours: [amHour] };
    if (clockMode === 'explicit_pm') return { valid: true, hours: [amHour + 12] };
    return { valid: true, hours: [amHour, amHour + 12] };
  }
  return { valid: true, hours: [hour] };
}

function buildResolvedClockDate({ year, month, day }, schedule, timezone, referenceDate) {
  const resolvedHours = clockHours(schedule);
  if (!resolvedHours.valid) return resolvedHours;

  const candidates = resolvedHours.hours.map((hour) => buildLocalDate({
    year, month, day, hour, minute: schedule.minute,
  }, timezone));
  const invalid = candidates.find((candidate) => !candidate.valid);
  if (invalid) return invalid;

  if (schedule.clockMode !== 'ambiguous_12h') return candidates[0];
  const futureCandidate = candidates.find((candidate) => candidate.date.getTime() > referenceDate.getTime());
  const selected = futureCandidate || candidates[candidates.length - 1];
  return {
    ...selected,
    clockResolution: 'nearest_future_on_local_date',
    resolvedHour: resolvedHours.hours[candidates.indexOf(selected)],
  };
}

/**
 * Resolve already-typed temporal meaning. This function never interprets
 * natural-language phrases; the LLM provides semantic time components and
 * Node owns timezone/calendar arithmetic.
 */
export function resolveTypedSchedule(schedule, {
  referenceTime = new Date(), timezone = 'America/Bogota', baseDate = null,
} = {}) {
  if (!schedule?.kind) return failure('MISSING_SCHEDULE', 'Falta la estructura temporal.');

  let normalizedSchedule = Number.isInteger(schedule.hour) && schedule.minute == null
    ? { ...schedule, minute: 0 }
    : { ...schedule };

  if (normalizedSchedule.kind === 'local_time' && Number.isInteger(normalizedSchedule.dayOffset)) {
    normalizedSchedule.kind = 'relative_day_time';
  }

  const reference = referenceTime instanceof Date ? referenceTime : new Date(referenceTime);
  if (Number.isNaN(reference.getTime())) return failure('INVALID_REFERENCE_TIME', 'La hora de referencia no es válida.');

  if (normalizedSchedule.kind === 'relative_offset') {
    if (!Number.isInteger(normalizedSchedule.offsetMinutes) || normalizedSchedule.offsetMinutes < 1 || normalizedSchedule.offsetMinutes > 525600) {
      return failure('INVALID_RELATIVE_OFFSET', 'El desplazamiento temporal no es válido.');
    }
    const date = new Date(reference.getTime() + normalizedSchedule.offsetMinutes * 60_000);
    return { valid: true, date, canonical: date.toISOString(), temporalKind: normalizedSchedule.kind };
  }

  if (normalizedSchedule.kind === 'inherit_context') {
    const inherited = baseDate instanceof Date ? baseDate : new Date(baseDate || NaN);
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

  if (!validClock(normalizedSchedule)) return failure('MISSING_CLOCK_TIME', 'Falta una hora de reloj completa y válida.');

  if (normalizedSchedule.kind === 'calendar_date_time') {
    if (!Number.isInteger(normalizedSchedule.month) || !Number.isInteger(normalizedSchedule.day)) {
      return failure('MISSING_CALENDAR_DATE', 'Faltan componentes de la fecha de calendario.');
    }
    if (!Number.isInteger(normalizedSchedule.year)) {
      normalizedSchedule.year = getLocalDateParts(reference, timezone).year;
    }
    const built = buildResolvedClockDate(normalizedSchedule, normalizedSchedule, timezone, reference);
    return built.valid ? { ...built, temporalKind: normalizedSchedule.kind } : built;
  }

  const referenceParts = getLocalDateParts(reference, timezone);
  let year = referenceParts.year;
  let month = referenceParts.month;
  let day = referenceParts.day;

  if (normalizedSchedule.kind === 'relative_day_time') {
    if (!Number.isInteger(normalizedSchedule.dayOffset) || normalizedSchedule.dayOffset < 0 || normalizedSchedule.dayOffset > 365) {
      return failure('INVALID_DAY_OFFSET', 'El desplazamiento de días no es válido.');
    }
    const shifted = new Date(Date.UTC(year, month - 1, day + normalizedSchedule.dayOffset));
    year = shifted.getUTCFullYear();
    month = shifted.getUTCMonth() + 1;
    day = shifted.getUTCDate();
  } else if (normalizedSchedule.kind === 'weekday_time') {
    const targetWeekday = WEEKDAYS[normalizedSchedule.weekday];
    if (targetWeekday === undefined) return failure('INVALID_WEEKDAY', 'El día de la semana no es válido.');
    const weekOffset = normalizedSchedule.weekOffset ?? 0;
    if (!Number.isInteger(weekOffset) || weekOffset < 0 || weekOffset > 52) {
      return failure('INVALID_WEEK_OFFSET', 'La semana relativa no es válida.');
    }
    const dayOffset = ((targetWeekday - referenceParts.dayOfWeek + 7) % 7) + weekOffset * 7;
    const shifted = new Date(Date.UTC(year, month - 1, day + dayOffset));
    year = shifted.getUTCFullYear();
    month = shifted.getUTCMonth() + 1;
    day = shifted.getUTCDate();
  } else if (normalizedSchedule.kind === 'local_time') {
    const inherited = baseDate instanceof Date ? baseDate : new Date(baseDate || NaN);
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
  return built.valid ? { ...built, temporalKind: normalizedSchedule.kind } : built;
}

function scheduleHasClock(schedule) {
  return Number.isInteger(schedule?.hour);
}

function clockFields(schedule) {
  if (!scheduleHasClock(schedule)) return {};
  return {
    hour: schedule.hour,
    minute: Number.isInteger(schedule.minute) ? schedule.minute : 0,
    ...(schedule.clockMode ? { clockMode: schedule.clockMode } : {}),
  };
}

function isDateBearingSchedule(schedule) {
  return ['relative_day_time', 'calendar_date_time', 'weekday_time'].includes(schedule?.kind);
}

function cloneJson(value) {
  return value ? JSON.parse(JSON.stringify(value)) : value;
}

/** Merge typed temporal components without interpreting natural-language text. */
export function mergePendingSchedule(baseSchedule, deltaSchedule) {
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

