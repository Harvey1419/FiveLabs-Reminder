import { getWorkingMemory } from '../core/working-memory-store.js';
import {
  parseStructuredOrdinal,
  resolveContextReference,
} from '../core/context-reference.js';
import { getLocalDateParts } from '../../shared/time.js';
import { resolveTypedSchedule } from './typed-schedule.js';
import {
  normalizeAgendaScope,
  normalizeTaskScope,
  buildExplicitTaskDateScope,
} from '../../shared/agenda-scopes.js';

function resolveWorkingItem(user, target, preferredType) {
  const reference = String(target || '').trim();
  if (!reference) return null;
  const resolved = resolveContextReference({
    reference,
    preferredType,
    workingMemory: getWorkingMemory(user),
  });
  return resolved.status === 'RESOLVED' ? resolved.item : null;
}

function normalizePendingTarget(action, user) {
  if (action.domain !== 'pending') return action;
  const rawTarget = String(action.target || '').trim();
  const ordinal = parseStructuredOrdinal(rawTarget);
  if (rawTarget && ordinal !== -1) return action;
  const count = getWorkingMemory(user)?.pendingClarifications?.length || 0;
  return count > 0 ? { ...action, target: String(count) } : action;
}

function normalizeCalendarYear(action, context) {
  if (action.schedule?.kind !== 'calendar_date_time') return action;
  if (Number.isInteger(action.schedule.year)) return action;
  const parts = getLocalDateParts(context.referenceTime, context.timezone);
  return { ...action, schedule: { ...action.schedule, year: parts.year } };
}

function localDateFromOffset(referenceTime, timezone, dayOffset) {
  const base = referenceTime instanceof Date ? referenceTime : new Date(referenceTime || Date.now());
  const shifted = new Date(base.getTime() + Number(dayOffset || 0) * 24 * 60 * 60 * 1000);
  const parts = getLocalDateParts(shifted, timezone);
  return [parts.year, parts.month, parts.day]
    .map((part, index) => index === 0 ? String(part) : String(part).padStart(2, '0'))
    .join('-');
}

function normalizeReadScope(action, context) {
  if (action.domain === 'agenda' && action.action === 'read') {
    if (!action.scope) return action;
    return { ...action, scope: normalizeAgendaScope(action.scope, 'all_pending') };
  }

  if (action.domain !== 'task' || action.action !== 'list') return action;
  if (action.scope) return { ...action, scope: normalizeTaskScope(action.scope, 'all_pending') };

  const schedule = action.schedule;
  if (!schedule) return { ...action, scope: 'all_pending' };

  if (schedule.kind === 'relative_day_time') {
    if (schedule.dayOffset === 0) return { ...action, scope: 'today' };
    if (schedule.dayOffset === 1) return { ...action, scope: 'tomorrow' };
    if (schedule.dayOffset === 2) return { ...action, scope: 'day_after_tomorrow' };
    const explicit = buildExplicitTaskDateScope(localDateFromOffset(context.referenceTime, context.timezone, schedule.dayOffset));
    return explicit ? { ...action, scope: explicit } : { ...action, scope: 'upcoming' };
  }

  if (schedule.kind === 'weekday_time' && schedule.weekday) {
    return { ...action, scope: normalizeTaskScope(schedule.weekday, 'upcoming') };
  }

  if (schedule.kind === 'calendar_date_time') {
    const year = schedule.year;
    const month = schedule.month;
    const day = schedule.day;
    if (Number.isInteger(year) && Number.isInteger(month) && Number.isInteger(day)) {
      const localDate = [year, month, day]
        .map((part, index) => index === 0 ? String(part) : String(part).padStart(2, '0'))
        .join('-');
      const explicit = buildExplicitTaskDateScope(localDate);
      if (explicit) return { ...action, scope: explicit };
    }
  }

  if (schedule.kind === 'local_time') return { ...action, scope: 'today' };
  return { ...action, scope: 'upcoming' };
}

/** Natural rename/edit requests map semantic newName to the domain field. */
function normalizeUpdateFields(action) {
  if (action.action !== 'update' || !action.newName) return action;

  if (action.domain === 'reminder' && !action.content && !action.title) {
    return { ...action, content: action.newName };
  }
  if (action.domain === 'task' && !action.title && !action.content) {
    return { ...action, title: action.newName };
  }
  if (action.domain === 'calendar' && !action.title && !action.content) {
    return { ...action, title: action.newName };
  }
  return action;
}

/**
 * A recurring reminder represents the next occurrence of a routine, not an
 * already elapsed wall-clock occurrence. This invariant applies both when a
 * routine is created and when an existing recurring reminder is edited.
 */
function normalizeRecurringReminder(action, context) {
  if (action.domain !== 'reminder' || !['create', 'update'].includes(action.action)) return action;

  const workingItem = action.action === 'update' && action.target
    ? resolveWorkingItem(context.user, action.target, 'reminder')
    : null;
  const inheritedRecurrence = workingItem?.raw?.recurrence_rule
    || workingItem?.raw?.recurrenceRule
    || null;
  const recurrence = action.recurrence || inheritedRecurrence;

  if (recurrence !== 'daily' || !action.schedule) return action;
  if (!['local_time', 'relative_day_time'].includes(action.schedule.kind)) return action;
  if (action.schedule.kind === 'relative_day_time' && (action.schedule.dayOffset ?? 0) !== 0) return action;

  const resolved = resolveTypedSchedule(action.schedule, {
    referenceTime: context.referenceTime,
    timezone: context.timezone,
  });
  const reference = context.referenceTime instanceof Date ? context.referenceTime : new Date(context.referenceTime || Date.now());
  if (!resolved.valid || !resolved.date || resolved.date.getTime() > reference.getTime()) return action;

  return {
    ...action,
    schedule: {
      ...action.schedule,
      kind: 'relative_day_time',
      dayOffset: 1,
    },
  };
}

/**
 * Calendar updates are patches. Reuse live context when it is known, but never
 * turn an identity reference ("la segunda", an event name, etc.) into content.
 */
function normalizeCalendarPatch(action, context) {
  if (action.domain !== 'calendar' || action.action !== 'update') return action;

  const item = resolveWorkingItem(context.user, action.target, 'calendar_event');
  const existingTitle = item?.summary || item?.title || item?.content || item?.raw?.summary || null;
  const normalized = { ...action };

  if (!normalized.title && !normalized.content && existingTitle) {
    normalized.title = existingTitle;
  }
  if (!normalized.schedule) {
    normalized.schedule = { kind: 'inherit_context' };
  }
  return normalized;
}

/**
 * Add deterministic runtime context only. This layer never changes semantic
 * domain/action and never performs a second language classification.
 */
export function normalizeTurnIntentForRuntime(intent, context) {
  if (!intent || !Array.isArray(intent.actions)) return intent;
  const actions = intent.actions.map((original) => {
    let action = { ...original };
    action = normalizePendingTarget(action, context.user);
    action = normalizeCalendarYear(action, context);
    action = normalizeReadScope(action, context);
    action = normalizeUpdateFields(action);
    action = normalizeRecurringReminder(action, context);
    action = normalizeCalendarPatch(action, context);
    return action;
  });
  return { ...intent, actions };
}
