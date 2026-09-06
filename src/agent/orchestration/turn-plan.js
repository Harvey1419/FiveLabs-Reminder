import { TOOL_NAMES } from '../contracts/tool-names.js';
import { getLocalDateParts, zonedTimeToUtc } from '../../shared/time.js';

export const TURN_OPERATION_LIMIT = 12;

const REPAIRABLE_MANIFEST_ERRORS = new Set([
  'INVALID_PARAMETERS',
  'UNTRUSTED_SOURCE_QUOTE',
  'UNTRUSTED_EXCLUDED_QUOTE',
  'MISSING_TARGET',
  'MISSING_UPDATES',
  'MISSING_CONTENT',
  'MISSING_TITLE',
  'MISSING_CONTEXT_TIME',
  'MISSING_SCHEDULE',
  'MISSING_CLOCK_TIME',
  'MISSING_CALENDAR_DATE',
  'MISSING_CATEGORY',
  'MISSING_PRESERVE_NAMES',
  'INVALID_CONTEXT_REFERENCE',
]);

const WEEKDAYS = Object.freeze({
  sunday: 0,
  monday: 1,
  tuesday: 2,
  wednesday: 3,
  thursday: 4,
  friday: 5,
  saturday: 6,
});

const READ_ONLY_OPERATION_KINDS = new Set([
  'agenda_read', 'reminder_list', 'task_list', 'entity_list',
  'calendar_list', 'calendar_search', 'calendar_next',
  'memory_search', 'memory_list', 'subscription_status',
]);

function failure(errorCode, error, extra = {}) {
  return { valid: false, errorCode, error, ...extra };
}

/** Identify provider-contract defects that merit one model repair before execution. */
export function findRepairableManifestIssue(validation, compiled) {
  if (!validation?.valid) {
    return REPAIRABLE_MANIFEST_ERRORS.has(validation?.errorCode)
      ? { errorCode: validation.errorCode, error: validation.error }
      : null;
  }
  if (!compiled) return null;
  if (!compiled.valid) {
    return REPAIRABLE_MANIFEST_ERRORS.has(compiled.errorCode)
      ? { errorCode: compiled.errorCode, error: compiled.error }
      : null;
  }
  const entry = compiled.entries?.find((candidate) => (
    !candidate.valid && REPAIRABLE_MANIFEST_ERRORS.has(candidate.errorCode)
  ));
  return entry ? { errorCode: entry.errorCode, error: entry.error, sequence: entry.sequence } : null;
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
  // Missing clockMode remains compatible with trusted legacy/direct callers.
  // Native agent calls are instructed and semantically verified to provide it.
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

/** Resolve model-supplied temporal meaning without interpreting natural language. */
export function resolveTypedSchedule(schedule, {
  referenceTime = new Date(), timezone = 'America/Bogota', baseDate = null,
} = {}) {
  if (!schedule?.kind) return failure('MISSING_SCHEDULE', 'Falta la estructura temporal.');
  // Whole-hour clocks have an exact minute of zero. This is deterministic
  // normalization of an already typed schedule, not natural-language parsing.
  let normalizedSchedule = Number.isInteger(schedule.hour) && schedule.minute == null
    ? { ...schedule, minute: 0 }
    : schedule;
  // Some providers correctly type the relative day but leave kind=local_time.
  // Preserve the structured dayOffset instead of silently dropping it and
  // scheduling on the reference day.
  if (normalizedSchedule.kind === 'local_time' && Number.isInteger(normalizedSchedule.dayOffset)) {
    normalizedSchedule = { ...normalizedSchedule, kind: 'relative_day_time' };
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
    if (Number.isNaN(inherited.getTime())) return failure('MISSING_CONTEXT_TIME', 'El elemento referenciado no tiene una hora válida.');
    return { valid: true, date: inherited, canonical: inherited.toISOString(), temporalKind: normalizedSchedule.kind };
  }

  if (!validClock(normalizedSchedule)) return failure('MISSING_CLOCK_TIME', 'Falta una hora de reloj completa y válida.');

  if (normalizedSchedule.kind === 'calendar_date_time') {
    if (!Number.isInteger(normalizedSchedule.month) || !Number.isInteger(normalizedSchedule.day)) {
      return failure('MISSING_CALENDAR_DATE', 'Faltan componentes de la fecha de calendario.');
    }
    if (!Number.isInteger(normalizedSchedule.year)) {
      normalizedSchedule = {
        ...normalizedSchedule,
        year: getLocalDateParts(reference, timezone).year,
      };
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

function exactQuotePresent(message, quote) {
  const source = String(message || '').toLocaleLowerCase();
  const evidence = String(quote || '').trim().toLocaleLowerCase();
  return Boolean(evidence && source.includes(evidence));
}

const wordSegmenter = new Intl.Segmenter('es', { granularity: 'word' });

function evidenceTokens(value) {
  return [...wordSegmenter.segment(String(value || '').normalize('NFD'))]
    .filter((segment) => segment.isWordLike)
    .map((segment) => [...segment.segment.toLocaleLowerCase()]
      .filter((character) => {
        const code = character.charCodeAt(0);
        return code < 0x0300 || code > 0x036f;
      })
      .join(''))
    .filter(Boolean);
}

function editDistance(left, right) {
  const previous = Array.from({ length: right.length + 1 }, (_unused, index) => index);
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    const current = [leftIndex];
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      current[rightIndex] = Math.min(
        current[rightIndex - 1] + 1,
        previous[rightIndex] + 1,
        previous[rightIndex - 1] + (left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1),
      );
    }
    previous.splice(0, previous.length, ...current);
  }
  return previous[right.length];
}

/**
 * Authorize only evidence anchored to one contiguous span in the current turn.
 * Exact text wins; a high-confidence alignment tolerates a tiny transcription
 * or conjugation variation without accepting a semantic paraphrase.
 */
function sourceEvidencePresent(message, quote) {
  if (exactQuotePresent(message, quote)) return true;
  const sourceTokens = evidenceTokens(message);
  const quoteTokens = evidenceTokens(quote);
  if (quoteTokens.length < 3 || sourceTokens.length < quoteTokens.length) return false;
  const normalizedQuote = quoteTokens.join(' ');
  for (let index = 0; index <= sourceTokens.length - quoteTokens.length; index += 1) {
    const candidate = sourceTokens.slice(index, index + quoteTokens.length).join(' ');
    const longest = Math.max(candidate.length, normalizedQuote.length);
    if (longest > 0 && 1 - editDistance(candidate, normalizedQuote) / longest >= 0.94) return true;
  }
  return false;
}

function selectContextItem(contextRef, workingMemory, preferredType = null) {
  if (!contextRef || contextRef.source !== 'working_memory') return null;
  const item = (workingMemory?.items || []).find((candidate) => candidate.position === contextRef.position) || null;
  if (!item || (preferredType && item.type !== preferredType)) return null;
  return item;
}

function inferContextPositionFromSource(operation, workingMemory, preferredType) {
  const source = normalizedText(operation?.sourceQuote);
  if (!source) return null;
  const matches = (workingMemory?.items || []).filter((item) => {
    if (preferredType && item.type !== preferredType) return false;
    const label = normalizedText(item.title || item.summary || item.content);
    return Boolean(label && source.includes(label));
  });
  return matches.length === 1 ? String(matches[0].position) : null;
}

function calendarTargetFromOperation(operation, workingMemory) {
  if (operation.contextRef?.source === 'working_memory') {
    const item = selectContextItem(operation.contextRef, workingMemory, 'calendar_event');
    if (!item) return failure('INVALID_CONTEXT_REFERENCE', 'La referencia no coincide con el estado conversacional activo.');
    return { valid: true, target: String(operation.contextRef.position) };
  }

  const explicitTarget = operation.targetName || operation.entityName || operation.title;
  if (explicitTarget) return { valid: true, target: explicitTarget };

  const inferredPosition = inferContextPositionFromSource(operation, workingMemory, 'calendar_event');
  if (inferredPosition) return { valid: true, target: inferredPosition };

  // sourceQuote is already authenticated against the current message. It is a
  // safe semantic target when no conversational item can be resolved uniquely.
  if (operation.sourceQuote) return { valid: true, target: operation.sourceQuote };
  return failure('MISSING_TARGET', 'Falta identificar el evento que se quiere modificar.');
}

function targetFromOperation(operation, workingMemory, preferredType = null, fallbackFields = []) {
  if (operation.contextRef?.source === 'working_memory') {
    const item = selectContextItem(operation.contextRef, workingMemory, preferredType);
    if (!item) return failure('INVALID_CONTEXT_REFERENCE', 'La referencia no coincide con el estado conversacional activo.');
    return { valid: true, target: String(operation.contextRef.position), item };
  }
  if (operation.targetName) return { valid: true, target: operation.targetName, item: null };
  for (const field of fallbackFields) {
    if (typeof operation[field] === 'string' && operation[field].trim()) {
      return { valid: true, target: operation[field].trim(), item: null };
    }
  }
  return failure('MISSING_TARGET', 'Falta identificar el elemento que se quiere modificar.');
}

function scheduleField(operation, options, field = 'schedule') {
  let schedule = operation[field];
  if (schedule?.kind === 'local_time' && typeof operation.date === 'string') {
    const parts = operation.date.split('-').map((part) => Number(part));
    if (parts.length === 3 && parts.every(Number.isInteger)) {
      schedule = {
        ...schedule,
        kind: 'calendar_date_time',
        year: parts[0],
        month: parts[1],
        day: parts[2],
      };
    }
  }
  const resolved = resolveTypedSchedule(schedule, options);
  return resolved.valid ? resolved : failure(resolved.errorCode, resolved.error);
}

function toolEntry(operation, toolName, params, extra = {}) {
  return { valid: true, type: 'tool', sequence: operation.sequence, operation, toolName, params, ...extra };
}

function requireText(value, code, message) {
  return typeof value === 'string' && value.trim() ? { valid: true, value: value.trim() } : failure(code, message);
}

function agendaScopeFromTypedOperation(operation) {
  if (operation.scope) return { scope: operation.scope };
  const schedule = operation.schedule;
  if (schedule?.kind === 'relative_day_time') {
    if (schedule.dayOffset === 0) return { scope: 'today' };
    if (schedule.dayOffset === 1) return { scope: 'tomorrow' };
    if (schedule.dayOffset === 2) return { scope: 'day_after_tomorrow' };
  }
  if (schedule?.kind === 'weekday_time' && WEEKDAYS[schedule.weekday] !== undefined) {
    return { scope: schedule.weekday };
  }
  if (
    schedule?.kind === 'calendar_date_time'
    && Number.isInteger(schedule.year)
    && Number.isInteger(schedule.month)
    && Number.isInteger(schedule.day)
  ) {
    const date = [schedule.year, schedule.month, schedule.day]
      .map((part, index) => index === 0 ? String(part) : String(part).padStart(2, '0'))
      .join('-');
    return { scope: 'explicit_date', date };
  }
  return { scope: 'upcoming' };
}

function normalizedText(value) {
  return String(value || '').trim().toLocaleLowerCase();
}

function attachSameTurnAdvanceNotices(operations, context) {
  const { workingMemory, userMessage } = context;
  const normalized = operations.map((operation) => ({ ...operation }));
  const bySequence = new Map(normalized.map((operation) => [operation.sequence, operation]));
  const suppressedSequences = new Set();

  for (const operation of normalized) {
    if (operation.kind !== 'reminder_add_advance') continue;
    const earlierCreates = normalized.filter((candidate) => (
      candidate.kind === 'reminder_create' && candidate.sequence < operation.sequence
    ));
    let target = null;

    if (operation.contextRef?.source === 'turn_operation') {
      const candidate = bySequence.get(operation.contextRef.position);
      if (candidate?.kind === 'reminder_create' && candidate.sequence < operation.sequence) target = candidate;
    } else if (operation.targetName) {
      const requestedTarget = normalizedText(operation.targetName);
      target = [...earlierCreates].reverse().find((candidate) => (
        normalizedText(candidate.content || candidate.title) === requestedTarget
      )) || null;
    } else if (operation.contextRef?.source === 'working_memory') {
      const existingItem = selectContextItem(operation.contextRef, workingMemory, 'reminder');
      const samePositionCreate = bySequence.get(operation.contextRef.position);
      if (existingItem && samePositionCreate?.kind === 'reminder_create') {
        return failure(
          'AMBIGUOUS_CONTEXT_REFERENCE',
          'La referencia puede señalar tanto un recordatorio anterior como uno creado en este turno.',
        );
      }
      if (!existingItem && samePositionCreate?.kind === 'reminder_create' && samePositionCreate.sequence < operation.sequence) {
        target = samePositionCreate;
      }
    } else if (!operation.contextRef && earlierCreates.length === 1) {
      [target] = earlierCreates;
    }

    if (!target || !sourceEvidencePresent(userMessage, operation.sourceQuote)) continue;
    if (target.advanceMinutes && target.advanceMinutes !== operation.advanceMinutes) {
      return failure('CONFLICTING_ADVANCE_NOTICE', 'El plan contiene dos anticipos distintos para el mismo recordatorio.');
    }
    target.advanceMinutes = operation.advanceMinutes;
    suppressedSequences.add(operation.sequence);
  }

  return {
    valid: true,
    operations: normalized.filter((operation) => !suppressedSequences.has(operation.sequence)),
  };
}

function schedulesEquivalent(left, right) {
  if (!left?.kind || left.kind !== right?.kind) return false;
  const fields = ['offsetMinutes', 'dayOffset', 'year', 'month', 'day', 'weekday', 'weekOffset', 'hour', 'minute'];
  return fields.every((field) => (left[field] ?? null) === (right[field] ?? null));
}

function scheduleRepresentsAdvance(calendarSchedule, reminderSchedule, advanceMinutes, context) {
  if (schedulesEquivalent(calendarSchedule, reminderSchedule)) return true;
  const calendarTime = resolveTypedSchedule(calendarSchedule, context);
  const reminderTime = resolveTypedSchedule(reminderSchedule, context);
  if (!calendarTime.valid || !reminderTime.valid) return false;
  return calendarTime.date.getTime() - reminderTime.date.getTime() === advanceMinutes * 60_000;
}

/** Fold a provider-split WhatsApp notice back into its calendar event. */
function attachCalendarAdvanceNotices(operations, context) {
  const normalized = operations.map((operation) => ({ ...operation }));
  const suppressedSequences = new Set();
  const bySequence = new Map(normalized.map((operation) => [operation.sequence, operation]));

  for (const reminder of normalized) {
    if (reminder.kind !== 'reminder_create' || !Number.isInteger(reminder.advanceMinutes)) continue;
    if (!sourceEvidencePresent(context.userMessage, reminder.sourceQuote)) continue;
    const reminderSubject = normalizedText(reminder.content || reminder.title);
    let calendar = null;
    if (reminder.contextRef?.source === 'turn_operation') {
      const referenced = bySequence.get(reminder.contextRef.position);
      if (referenced?.kind === 'calendar_create' && referenced.sequence < reminder.sequence) calendar = referenced;
    }
    if (!calendar) {
      const earlierCalendars = normalized.filter((candidate) => (
        candidate.kind === 'calendar_create' && candidate.sequence < reminder.sequence
      ));
      const temporallyAligned = reminder.schedule?.kind === 'inherit_context'
        ? earlierCalendars
        : earlierCalendars.filter((candidate) => (
          scheduleRepresentsAdvance(candidate.schedule, reminder.schedule, reminder.advanceMinutes, context)
        ));
      calendar = temporallyAligned.find((candidate) => (
        normalizedText(candidate.title || candidate.content) === reminderSubject
      )) || (temporallyAligned.length === 1 ? temporallyAligned[0] : null);
    }
    if (!calendar) continue;
    if (calendar.advanceMinutes && calendar.advanceMinutes !== reminder.advanceMinutes) {
      return failure('CONFLICTING_ADVANCE_NOTICE', 'El plan contiene dos anticipos distintos para el mismo evento.');
    }
    calendar.advanceMinutes = reminder.advanceMinutes;
    suppressedSequences.add(reminder.sequence);
  }

  return {
    valid: true,
    operations: normalized.filter((operation) => !suppressedSequences.has(operation.sequence)),
  };
}

function batchAdjacentReminderCreates(entries) {
  const batched = [];
  for (const entry of entries) {
    const isReminderCreate = entry.valid
      && entry.type === 'tool'
      && entry.toolName === TOOL_NAMES.MANAGE_REMINDER
      && entry.params?.action === 'create'
      && entry.operation?.kind === 'reminder_create';
    const previous = batched.at(-1);
    const canJoinPrevious = isReminderCreate
      && previous?.valid
      && previous.type === 'tool'
      && previous.toolName === TOOL_NAMES.MANAGE_REMINDER
      && previous.params?.action === 'create'
      && previous.isReminderCreateBatch === true;

    if (canJoinPrevious) {
      previous.params.items.push(...entry.params.items);
      previous.operations.push(entry.operation);
      previous.temporalKind = 'typed_batch';
      continue;
    }
    if (isReminderCreate) {
      batched.push({
        ...entry,
        params: { ...entry.params, items: entry.params.items.slice() },
        operations: [entry.operation],
        isReminderCreateBatch: true,
      });
      continue;
    }
    batched.push(entry);
  }
  return batched;
}

function compileOperation(operation, context) {
  const { referenceTime, timezone, workingMemory } = context;
  const scheduleOptions = { referenceTime, timezone };
  const title = operation.title || operation.content;

  switch (operation.kind) {
    case 'reminder_create': {
      const content = requireText(operation.content || operation.title, 'MISSING_CONTENT', 'Falta el contenido del recordatorio.');
      if (!content.valid) return content;
      const temporal = scheduleField(operation, scheduleOptions);
      if (!temporal.valid) return temporal;
      return toolEntry(operation, TOOL_NAMES.MANAGE_REMINDER, {
        action: 'create',
        items: [{
          content: content.value,
          targetTime: temporal.canonical,
          sourceTimeText: operation.sourceQuote,
          ...(operation.advanceMinutes ? { advanceMinutes: operation.advanceMinutes } : {}),
          ...(operation.recurrence ? { recurrence: operation.recurrence } : {}),
          ...(operation.requiresConfirmation ? { requiresConfirmation: true } : {}),
          ...(operation.nudgeIntervalMinutes ? { nudgeIntervalMinutes: operation.nudgeIntervalMinutes } : {}),
          ...(operation.maxNudges ? { maxNudges: operation.maxNudges } : {}),
        }],
      }, { temporalKind: temporal.temporalKind });
    }
    case 'reminder_update': {
      const target = targetFromOperation(operation, workingMemory, 'reminder');
      if (!target.valid) return target;
      const updates = {};
      if (operation.content) updates.content = operation.content;
      if (operation.schedule) {
        const baseDate = target.item?.time || target.item?.raw?.sendAt || target.item?.raw?.send_at || null;
        const temporal = scheduleField(operation, { ...scheduleOptions, baseDate });
        if (!temporal.valid) return temporal;
        updates.targetTime = temporal.canonical;
      }
      if (operation.recurrence) updates.recurrence = operation.recurrence;
      if (Object.keys(updates).length === 0) return failure('MISSING_UPDATES', 'No se indicó qué cambiar del recordatorio.');
      return toolEntry(operation, TOOL_NAMES.MANAGE_REMINDER, { action: 'update', target: target.target, updates });
    }
    case 'reminder_add_advance': {
      let target = targetFromOperation(operation, workingMemory, 'reminder');
      if (!target.valid && !operation.contextRef && !operation.targetName) {
        const reminders = (workingMemory?.items || []).filter((item) => item.type === 'reminder');
        if (reminders.length === 1) target = { valid: true, target: String(reminders[0].position), item: reminders[0] };
        if (reminders.length > 1) {
          return failure('AMBIGUOUS_REFERENCE', 'Hay más de un recordatorio activo; necesito saber a cuál aplicar el aviso previo.', {
            requiresClarification: true,
          });
        }
      }
      if (!target.valid) return target;
      if (!Number.isInteger(operation.advanceMinutes) || operation.advanceMinutes < 1) {
        return failure('INVALID_ADVANCE_MINUTES', 'El anticipo debe indicar minutos válidos.');
      }
      return toolEntry(operation, TOOL_NAMES.MANAGE_REMINDER, {
        action: 'update', target: target.target, advanceMinutes: operation.advanceMinutes,
      });
    }
    case 'reminder_cancel': {
      if (operation.scope === 'elapsed' || operation.scope === 'all') {
        return toolEntry(operation, TOOL_NAMES.MANAGE_REMINDER, {
          action: 'cancel', scope: operation.scope,
        });
      }
      const target = targetFromOperation(operation, workingMemory, 'reminder', ['content', 'title']);
      if (!target.valid) return target;
      return toolEntry(operation, TOOL_NAMES.MANAGE_REMINDER, {
        action: 'cancel', target: target.target,
      });
    }
    case 'reminder_acknowledge': {
      const target = targetFromOperation(operation, workingMemory, 'reminder', ['content', 'title']);
      if (!target.valid) return target;
      return toolEntry(operation, TOOL_NAMES.MANAGE_REMINDER, {
        action: 'acknowledge', target: target.target,
      });
    }
    case 'reminder_list':
      return toolEntry(operation, TOOL_NAMES.MANAGE_REMINDER, { action: 'list', ...(operation.filter ? { filter: operation.filter } : {}), ...(operation.scope ? { scope: operation.scope } : {}) });

    case 'task_create': {
      const requiredTitle = requireText(title, 'MISSING_TITLE', 'Falta el título de la tarea.');
      if (!requiredTitle.valid) return requiredTitle;
      const item = { title: requiredTitle.value };
      if (operation.description) item.description = operation.description;
      if (!operation.projectless && (operation.entityName || operation.targetName)) {
        item.entityName = operation.entityName || operation.targetName;
      }
      if (operation.priority) item.priority = operation.priority;
      if (operation.schedule) {
        const temporal = scheduleField(operation, scheduleOptions);
        if (!temporal.valid) return temporal;
        item.dueDate = temporal.canonical;
      }
      if (item.entityName) item.entityCategory = operation.category || 'project';
      return toolEntry(operation, TOOL_NAMES.MANAGE_TASK, { action: 'create', items: [item], ...(item.entityName ? { entityName: item.entityName } : {}) });
    }
    case 'task_update':
    case 'task_complete':
    case 'task_delete': {
      const target = targetFromOperation(
        operation,
        workingMemory,
        'task',
        operation.kind === 'task_update' ? [] : ['title', 'content', 'sourceQuote'],
      );
      if (!target.valid) return target;
      const action = operation.kind === 'task_complete' ? 'complete' : operation.kind === 'task_delete' ? 'delete' : 'update';
      const params = { action, target: target.target };
      if (operation.entityName) params.entityName = operation.entityName;
      if (action === 'update') {
        params.updates = {};
        if (operation.content || operation.title) params.updates.title = operation.content || operation.title;
        if (operation.description) params.updates.description = operation.description;
        if (operation.priority) params.updates.priority = operation.priority;
        if (operation.status) params.updates.status = operation.status;
        if (operation.schedule) {
          const temporal = scheduleField(operation, scheduleOptions);
          if (!temporal.valid) return temporal;
          params.updates.dueDate = temporal.canonical;
        }
        if (Object.keys(params.updates).length === 0) return failure('MISSING_UPDATES', 'No se indicó qué cambiar de la tarea.');
      }
      return toolEntry(operation, TOOL_NAMES.MANAGE_TASK, params);
    }
    case 'task_list':
      return toolEntry(operation, TOOL_NAMES.MANAGE_TASK, {
        action: 'list',
        ...(operation.entityName || operation.targetName ? { entityName: operation.entityName || operation.targetName } : {}),
        status: operation.status || 'pending',
        ...(operation.scope ? { scope: operation.scope } : {}),
      });

    case 'entity_create':
    case 'entity_upsert':
      return toolEntry(operation, TOOL_NAMES.MANAGE_ENTITY, {
        action: operation.kind === 'entity_create' ? 'create' : 'upsert',
        name: operation.entityName || operation.targetName || title,
        category: operation.category || 'project',
      });
    case 'entity_rename':
      return toolEntry(operation, TOOL_NAMES.MANAGE_ENTITY, { action: 'rename', oldName: operation.oldName || operation.targetName, newName: operation.newName });
    case 'entity_merge':
      return toolEntry(operation, TOOL_NAMES.MANAGE_ENTITY, {
        action: 'merge',
        sourceName: operation.sourceName,
        targetName: operation.targetName || operation.entityName,
      });
    case 'entity_delete': {
      // An exception list has meaning only for a collection-wide deletion.
      // Normalize this typed structural signal instead of trying to recognize
      // natural-language variants of “all”.
      const deletionScope = Array.isArray(operation.preserveNames) ? 'all' : (operation.scope || 'single');
      if (deletionScope !== 'all' && !operation.targetName && !operation.entityName) {
        return failure('MISSING_TARGET', 'Falta el proyecto o alcance que se desea eliminar.');
      }
      if (deletionScope === 'all' && !Array.isArray(operation.preserveNames)) {
        return failure(
          'MISSING_PRESERVE_NAMES',
          'Una eliminación masiva debe declarar preserveNames, aunque sea una lista vacía, para no perder excepciones.',
        );
      }
      if (deletionScope === 'all' && !operation.category) {
        return failure(
          'MISSING_CATEGORY',
          'Una eliminación masiva debe indicar la categoría exacta; no se puede ampliar “proyectos” a todas las entidades.',
        );
      }
      return toolEntry(operation, TOOL_NAMES.MANAGE_ENTITY, {
        action: 'delete',
        ...(operation.targetName || operation.entityName ? { targetName: operation.targetName || operation.entityName } : {}),
        ...(operation.category ? { category: operation.category } : {}),
        scope: deletionScope,
        ...(Array.isArray(operation.preserveNames) ? { preserveNames: operation.preserveNames } : {}),
      });
    }
    case 'entity_deduplicate':
      return toolEntry(operation, TOOL_NAMES.MANAGE_ENTITY, { action: 'deduplicate', ...(operation.category ? { category: operation.category } : {}) });
    case 'entity_list':
      return toolEntry(operation, TOOL_NAMES.MANAGE_ENTITY, { action: 'list', ...(operation.category ? { category: operation.category } : {}), ...(operation.limit ? { limit: operation.limit } : {}) });

    case 'agenda_read': {
      const agendaScope = agendaScopeFromTypedOperation(operation);
      return toolEntry(operation, TOOL_NAMES.GET_UNIFIED_AGENDA, {
        ...agendaScope, ...(operation.date ? { date: operation.date } : {}),
        ...(operation.dateFrom ? { dateFrom: operation.dateFrom } : {}), ...(operation.dateTo ? { dateTo: operation.dateTo } : {}),
        ...(operation.query ? { query: operation.query } : {}),
      });
    }

    case 'calendar_create':
    case 'calendar_update': {
      const start = scheduleField(operation, scheduleOptions);
      if (!start.valid) return start;
      const calendarTarget = operation.kind === 'calendar_update'
        ? calendarTargetFromOperation(operation, workingMemory)
        : null;
      if (calendarTarget && !calendarTarget.valid) return calendarTarget;
      const params = {
        action: operation.kind === 'calendar_create' ? 'create_event' : 'update_event',
        startDateTime: start.canonical,
        summary: title || operation.targetName,
      };
      if (operation.kind === 'calendar_update') {
        params.target = calendarTarget.target;
      }
      if (operation.endSchedule) {
        const end = scheduleField(operation, scheduleOptions, 'endSchedule');
        if (!end.valid) return end;
        params.endDateTime = end.canonical;
      } else if (operation.durationMinutes) params.durationMinutes = operation.durationMinutes;
      if (operation.description) params.description = operation.description;
      if (operation.advanceMinutes) params.advanceMinutes = operation.advanceMinutes;
      if (operation.addGoogleMeet) params.addGoogleMeet = true;
      return toolEntry(operation, TOOL_NAMES.MANAGE_GOOGLE_CALENDAR, params);
    }
    case 'calendar_delete': {
      const calendarTarget = calendarTargetFromOperation(operation, workingMemory);
      if (!calendarTarget.valid) return calendarTarget;
      return toolEntry(operation, TOOL_NAMES.MANAGE_GOOGLE_CALENDAR, {
        action: 'delete_event',
        target: calendarTarget.target,
      });
    }
    case 'calendar_list':
      return toolEntry(operation, TOOL_NAMES.MANAGE_GOOGLE_CALENDAR, { action: 'list_events', ...(operation.scope ? { scope: operation.scope } : {}), ...(operation.date ? { date: operation.date } : {}) });
    case 'calendar_search': {
      const searchQuery = requireText(
        operation.query || operation.targetName || operation.description,
        'MISSING_TARGET',
        'Falta el asunto que se desea buscar en Google Calendar.',
      );
      if (!searchQuery.valid) return searchQuery;
      return toolEntry(operation, TOOL_NAMES.MANAGE_GOOGLE_CALENDAR, { action: 'search_events', query: searchQuery.value });
    }
    case 'calendar_next':
      return toolEntry(operation, TOOL_NAMES.MANAGE_GOOGLE_CALENDAR, { action: 'next_event' });
    case 'calendar_connect':
      return toolEntry(operation, TOOL_NAMES.MANAGE_GOOGLE_CALENDAR, { action: 'get_connect_link' });
    case 'calendar_disconnect':
      return toolEntry(operation, TOOL_NAMES.MANAGE_GOOGLE_CALENDAR, { action: 'disconnect' });

    case 'memory_save':
      return toolEntry(operation, TOOL_NAMES.MANAGE_MEMORY, {
        action: 'save',
        content: operation.content || operation.sourceQuote,
        ...(operation.category ? { category: operation.category } : {}),
      });
    case 'memory_search':
      return toolEntry(operation, TOOL_NAMES.MANAGE_MEMORY, { action: 'search', query: operation.query || operation.targetName, ...(operation.limit ? { limit: operation.limit } : {}) });
    case 'memory_list':
      return toolEntry(operation, TOOL_NAMES.MANAGE_MEMORY, { action: 'list', ...(operation.limit ? { limit: operation.limit } : {}) });
    case 'memory_forget':
      return toolEntry(operation, TOOL_NAMES.MANAGE_MEMORY, {
        action: 'forget',
        query: operation.query || operation.targetName || operation.sourceQuote,
      });

    case 'subscription_link':
    case 'subscription_status':
    case 'subscription_cancel':
      return toolEntry(operation, TOOL_NAMES.MANAGE_SUBSCRIPTION, {
        action: operation.kind === 'subscription_link' ? 'get_link' : operation.kind === 'subscription_status' ? 'status' : 'cancel',
      });

    case 'execute_pending':
    case 'discard_pending':
    case 'revise_pending':
      return { valid: true, type: 'pending', sequence: operation.sequence, operation };
    case 'clarification_request':
      if (operation.clarificationKind === 'reminder_schedule') {
        const missingFields = Array.isArray(operation.missingFields)
          ? operation.missingFields.filter((field) => ['main_time', 'advance_minutes'].includes(field))
          : [];
        if (missingFields.length === 0) {
          return failure('MISSING_CLARIFICATION_FIELDS', 'Falta indicar qué dato de horario necesita el recordatorio.');
        }
        return {
          valid: true, type: 'clarification', sequence: operation.sequence, operation,
          result: {
            success: false, action: 'clarification_required', errorCode: 'MISSING_REQUIRED_CONTEXT',
            error: '', confirmation: '', requiresClarification: true, complete: false,
          },
        };
      }
      if (!operation.question) {
        return failure('MISSING_CLARIFICATION_QUESTION', 'Falta la pregunta de aclaración.');
      }
      return {
        valid: true, type: 'clarification', sequence: operation.sequence, operation,
        result: {
          success: false, action: 'clarification_required', errorCode: 'MISSING_REQUIRED_CONTEXT',
          error: operation.question || 'Necesito una aclaración antes de continuar.',
          confirmation: operation.question || 'Necesito una aclaración antes de continuar.',
          requiresClarification: true, complete: false,
        },
      };
    case 'admin_metrics':
      return toolEntry(operation, TOOL_NAMES.ADMIN_METRICS, { action: operation.query || 'get_overview' });
    default:
      return failure('UNSUPPORTED_OPERATION', `Operación no soportada: ${operation.kind}.`);
  }
}

/** Validate a complete turn before any domain mutation is attempted. */
export function compileTurnManifest(manifest, context = {}) {
  const operations = Array.isArray(manifest?.operations) ? manifest.operations : [];
  if (operations.length === 0) return failure('EMPTY_TURN_PLAN', 'El plan no contiene operaciones.');
  if (operations.length > TURN_OPERATION_LIMIT) {
    return failure('TURN_OPERATION_LIMIT', `El plan supera el límite de ${TURN_OPERATION_LIMIT} operaciones.`);
  }

  const ordered = operations.slice().sort((left, right) => left.sequence - right.sequence);
  const sequenceValues = new Set();
  for (const operation of ordered) {
    if (sequenceValues.has(operation.sequence)) return failure('DUPLICATE_SEQUENCE', 'El plan contiene posiciones duplicadas.');
    sequenceValues.add(operation.sequence);
  }

  const advanceNormalization = attachSameTurnAdvanceNotices(ordered, context);
  if (!advanceNormalization.valid) return advanceNormalization;
  const calendarAdvanceNormalization = attachCalendarAdvanceNotices(advanceNormalization.operations, context);
  if (!calendarAdvanceNormalization.valid) return calendarAdvanceNormalization;
  const executableOperations = calendarAdvanceNormalization.operations;
  const pendingTransitions = new Map();
  const redundantPendingSequences = new Set();

  for (const operation of executableOperations) {
    if (!['execute_pending', 'discard_pending', 'revise_pending'].includes(operation.kind)) continue;
    const key = operation.contextRef?.source === 'pending_state'
      ? `pending:${operation.contextRef.position}`
      : 'pending:implicit';
    const previous = pendingTransitions.get(key);
    if (!previous) {
      pendingTransitions.set(key, operation);
      continue;
    }
    if (previous.kind === 'revise_pending' && operation.kind === 'execute_pending') {
      // revise_pending is already an execute-once transition. Some providers
      // redundantly emit execute_pending afterwards; suppress it structurally
      // rather than replaying the proposal or failing after a real mutation.
      redundantPendingSequences.add(operation.sequence);
      continue;
    }
    return failure('CONFLICTING_PENDING_TRANSITIONS', 'El plan contiene transiciones incompatibles para la misma propuesta pendiente.');
  }

  const entries = [];
  for (const operation of executableOperations) {
    if (redundantPendingSequences.has(operation.sequence)) continue;
    const hasTrustedEvidence = sourceEvidencePresent(context.userMessage, operation.sourceQuote);
    const canRepairSafeRead = READ_ONLY_OPERATION_KINDS.has(operation.kind)
      && typeof context.userMessage === 'string'
      && context.userMessage.trim().length > 0;
    if (!hasTrustedEvidence && !canRepairSafeRead) {
      entries.push({
        valid: false, type: 'error', sequence: operation.sequence, operation,
        errorCode: 'UNTRUSTED_SOURCE_QUOTE', error: 'La evidencia de la operación no aparece en el mensaje actual.',
      });
      continue;
    }
    const authorizedOperation = hasTrustedEvidence
      ? operation
      : { ...operation, sourceQuote: context.userMessage, sourceQuoteRepaired: true };
    const compiled = compileOperation(authorizedOperation, context);
    entries.push({ ...compiled, sequence: authorizedOperation.sequence, operation: authorizedOperation });
  }

  for (const excluded of manifest.excludedClauses || []) {
    if (!sourceEvidencePresent(context.userMessage, excluded.sourceQuote)) {
      return failure('UNTRUSTED_EXCLUDED_QUOTE', 'Una cláusula excluida no aparece en el mensaje actual.');
    }
  }
  return {
    valid: true,
    entries: batchAdjacentReminderCreates(entries),
    excludedClauses: manifest.excludedClauses || [],
  };
}
