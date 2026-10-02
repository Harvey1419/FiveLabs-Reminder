import { getWorkingMemory } from '../core/working-memory-store.js';
import { resolveContextReference, parseStructuredOrdinal } from '../core/context-reference.js';
import { getLocalDateParts, shiftZonedCalendarDays } from '../../shared/time.js';
import { resolveTypedSchedule } from './typed-schedule.js';
import {
  normalizeAgendaScope,
  normalizeTaskScope,
  buildExplicitTaskDateScope,
  buildExplicitReminderDateScope,
  parseReminderScope,
} from '../../shared/agenda-scopes.js';
import { sanitizeCalendarQueryAndScope } from '../tools/calendar.js';

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

function normalizeCalendarYear(action, context) {
  if (action.schedule?.kind !== 'calendar_date_time') return action;
  if (Number.isInteger(action.schedule.year)) return action;
  const parts = getLocalDateParts(context.referenceTime, context.timezone);
  return { ...action, schedule: { ...action.schedule, year: parts.year } };
}

function localDateFromOffset(referenceTime, timezone, dayOffset) {
  const base = referenceTime instanceof Date ? referenceTime : new Date(referenceTime || Date.now());
  const shifted = shiftZonedCalendarDays(base, Number(dayOffset || 0), timezone);
  if (!shifted) return null;
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

  if (action.domain === 'calendar') {
    if (action.action === 'list' || action.action === 'search') {
      const rawQuery = action.query || action.target || action.description;
      const sanitized = sanitizeCalendarQueryAndScope({ query: rawQuery, scope: action.scope });

      let scope = sanitized.scope;
      let date;
      if (!scope && action.schedule) {
        const schedule = action.schedule;
        if (schedule.kind === 'relative_day_time') {
          if (schedule.dayOffset === 0) scope = 'today';
          else if (schedule.dayOffset === 1) scope = 'tomorrow';
          else if (schedule.dayOffset === 2) scope = 'day_after_tomorrow';
          else if (Number.isInteger(schedule.dayOffset)) {
            date = localDateFromOffset(context.referenceTime, context.timezone, schedule.dayOffset);
            scope = 'explicit_date';
          }
        } else if (schedule.kind === 'weekday_time' && schedule.weekday) {
          scope = schedule.weekday;
        } else if (schedule.kind === 'local_time') {
          scope = 'today';
        } else if (schedule.kind === 'calendar_date_time'
          && Number.isInteger(schedule.month) && Number.isInteger(schedule.day)) {
          const year = Number.isInteger(schedule.year)
            ? schedule.year
            : getLocalDateParts(context.referenceTime, context.timezone).year;
          date = [year, schedule.month, schedule.day]
            .map((part, index) => index === 0 ? String(part) : String(part).padStart(2, '0'))
            .join('-');
          scope = 'explicit_date';
        }
      }

      const normalizedScope = scope ? normalizeAgendaScope(scope, 'upcoming') : (action.scope ? normalizeAgendaScope(action.scope, 'upcoming') : undefined);

      if (action.action === 'search') {
        if (!sanitized.query) {
          const { query: _q, target: _t, ...rest } = action;
          return {
            ...rest,
            ...(date ? { date } : {}),
            action: 'list',
            scope: normalizedScope || 'today',
          };
        }
        return {
          ...action,
          query: sanitized.query,
          ...(date ? { date } : {}),
          ...(normalizedScope ? { scope: normalizedScope } : {}),
        };
      }

      const { query: _q, ...rest } = action;
      return {
        ...rest,
        ...(date ? { date } : {}),
        ...(normalizedScope ? { scope: normalizedScope } : {}),
        ...(sanitized.query ? { query: sanitized.query } : {}),
      };
    }
  }

  if (action.domain === 'reminder' && action.action === 'list') {
    let raw = action.filter || action.scope;
    if (!raw && action.schedule) {
      const schedule = action.schedule;
      let date = null;
      if (schedule.kind === 'calendar_date_time' && Number.isInteger(schedule.month) && Number.isInteger(schedule.day)) {
        const year = Number.isInteger(schedule.year) ? schedule.year : getLocalDateParts(context.referenceTime, context.timezone).year;
        date = [year, schedule.month, schedule.day].map((part, index) => index === 0 ? String(part) : String(part).padStart(2, '0')).join('-');
      } else if (schedule.kind === 'relative_day_time' && Number.isInteger(schedule.dayOffset)) {
        date = localDateFromOffset(context.referenceTime, context.timezone, schedule.dayOffset);
      }
      raw = date ? buildExplicitReminderDateScope(date) : undefined;
    }
    if (raw) {
      const parsed = parseReminderScope(raw, 'upcoming');
      return {
        ...action,
        filter: parsed.scope,
        scope: parsed.runtimeScope,
      };
    }
    return action;
  }

  if (action.domain !== 'task' || action.action !== 'list') return action;

  const query = action.query || (action.entityName && action.target ? action.target : null);

  const base = {
    ...action,
    ...(query ? { query: String(query).trim() } : {}),
  };
  if (base.scope) return { ...base, scope: normalizeTaskScope(base.scope, 'all_pending') };

  const schedule = base.schedule;
  if (!schedule) return { ...base, scope: 'all_pending' };

  if (schedule.kind === 'relative_day_time') {
    if (schedule.dayOffset === 0) return { ...base, scope: 'today' };
    if (schedule.dayOffset === 1) return { ...base, scope: 'tomorrow' };
    if (schedule.dayOffset === 2) return { ...base, scope: 'day_after_tomorrow' };
    const explicit = buildExplicitTaskDateScope(localDateFromOffset(context.referenceTime, context.timezone, schedule.dayOffset));
    return explicit ? { ...base, scope: explicit } : { ...base, scope: 'upcoming' };
  }

  if (schedule.kind === 'weekday_time' && schedule.weekday) {
    return { ...base, scope: normalizeTaskScope(schedule.weekday, 'upcoming') };
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
      return explicit ? { ...base, scope: explicit } : { ...base, scope: 'upcoming' };
    }
  }

  if (schedule.kind === 'local_time') return { ...base, scope: 'today' };
  return { ...base, scope: 'upcoming' };
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
  const recurrence = action.clearFields?.includes('recurrence') ? null : action.recurrence || inheritedRecurrence;

  if (recurrence !== 'daily' || !action.schedule) return action;
  if (!['local_time', 'relative_day_time'].includes(action.schedule.kind)) return action;
  if (action.schedule.kind === 'relative_day_time' && (action.schedule.dayOffset ?? 0) !== 0) return action;

  const resolved = resolveTypedSchedule(action.schedule, {
    referenceTime: context.referenceTime,
    timezone: context.timezone,
    baseDate: workingItem?.raw?.sendAt || workingItem?.raw?.send_at || workingItem?.time || null,
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
 * Bridges conversational references (e.g. "recuérdame la 1 a las 5pm") into
 * concrete reminder content using items currently active in working memory.
 */
function normalizeReminderCreateFromWorkingTarget(action, context) {
  if (action.domain !== 'reminder' || action.action !== 'create') return action;

  const candidateRef = action.target
    || (action.content && parseStructuredOrdinal(action.content) !== null ? action.content : null)
    || (action.title && parseStructuredOrdinal(action.title) !== null ? action.title : null)
    || (action.content && /^(?:hacer\s+)?(?:la\s+|el\s+)?(?:tarea\s+|item\s+|pendiente\s+)?#?(\d+)$/i.test(action.content.trim()) ? action.content.trim() : null);

  if (!candidateRef) return action;

  const hasSubstantiveContent = action.content
    && parseStructuredOrdinal(action.content) === null
    && !/^(?:hacer\s+)?(?:la\s+|el\s+)?(?:tarea\s+|item\s+|pendiente\s+)?#?(\d+)$/i.test(action.content.trim());

  if (hasSubstantiveContent && !action.target) return action;

  const workingItem = resolveWorkingItem(context?.user, candidateRef, 'task')
    || resolveWorkingItem(context?.user, candidateRef);

  if (workingItem) {
    const title = workingItem.title || workingItem.summary || workingItem.content;
    if (title) {
      const updated = { ...action, content: title };
      delete updated.target;
      return updated;
    }
  }

  return action;
}

/**
 * Structural bulk entity deletion normalizer:
 * Enforces scope="all", category="project" fallback, and preserveNames array
 * ONLY when scope="all" or preserveNames is already structurally provided.
 * Node never infers bulk operations from natural-language target strings.
 */
function normalizeEntityDelete(action) {
  if (action.domain !== 'entity' || action.action !== 'delete') return action;

  if (action.scope === 'all' || Array.isArray(action.preserveNames)) {
    return {
      ...action,
      scope: 'all',
      category: action.category || 'project',
      preserveNames: Array.isArray(action.preserveNames) ? action.preserveNames : [],
    };
  }

  return action;
}

function normalizeProjectOperations(action) {
  if (action.domain === 'project' && action.action === 'delete') {
    if (action.scope === 'all' || Array.isArray(action.preserveNames)) {
      return {
        ...action,
        scope: 'all',
        preserveNames: Array.isArray(action.preserveNames) ? action.preserveNames : [],
      };
    }
  }
  return action;
}

function normalizeTaskEntityName(action, context) {
  if (action.domain !== 'task' || !action.entityName) return action;
  const target = String(action.entityName).trim();
  const workingItem = resolveWorkingItem(context?.user, target, 'project');
  if (workingItem) {
    const resolvedName = workingItem.title || workingItem.name || workingItem.summary;
    if (resolvedName) {
      return { ...action, entityName: resolvedName };
    }
  }
  return action;
}

/**
 * Add deterministic runtime context only. This layer never changes semantic
 * domain/action and never turns identity/context into patch content.
 */
function bindTypedContextReference(action, context) {
  if (!action.contextRef) return action;
  const expectedType = { reminder: 'reminder', task: 'task', calendar: 'calendar_event' }[action.domain];
  const item = getWorkingMemory(context.user)?.items?.find(item => item.position === action.contextRef.position);
  const compatible = item?.type === expectedType;
  if (action.contextRef.source !== 'working_memory' || !expectedType || !compatible || !item?.internalId || ['deleted', 'cancelled'].includes(item.raw?.status)) {
    return { ...action, _referenceError: true };
  }
  // Freeze the selected identity before any sibling action can replace working memory.
  const { contextRef, ...bound } = action;
  return { ...bound, target: item.internalId };
}

export function normalizeTurnActionForRuntime(original, context = {}) {
  let action = bindTypedContextReference({ ...original }, context);
  action = normalizeCalendarYear(action, context);
  action = normalizeReadScope(action, context);
  action = normalizeUpdateFields(action);
  action = normalizeRecurringReminder(action, context);
  action = normalizeReminderCreateFromWorkingTarget(action, context);
  action = normalizeEntityDelete(action);
  action = normalizeProjectOperations(action);
  action = normalizeTaskEntityName(action, context);
  return action;
}

export function normalizeTurnIntentForRuntime(intent, context) {
  if (!intent || !Array.isArray(intent.actions)) return intent;
  return { ...intent, actions: intent.actions.map((action) => normalizeTurnActionForRuntime(action, context)) };
}
