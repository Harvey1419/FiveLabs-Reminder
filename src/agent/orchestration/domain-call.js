import { TOOL_NAMES } from '../contracts/tool-names.js';
import { getWorkingMemory } from '../core/working-memory-store.js';
import { resolveContextReference } from '../core/context-reference.js';
import { normalizeAgendaScope } from '../../shared/agenda-scopes.js';
import { resolveTypedSchedule } from './typed-schedule.js';
import { formatAssistantClarification } from './clarification-presentation.js';
import { normalizeTurnActionForRuntime } from './intent-normalizer.js';

export function failedResult(errorCode, error, language = 'es', { requiresClarification = false } = {}) {
  const message = error || (language === 'en'
    ? 'I could not safely execute that action.'
    : 'No pude ejecutar esa acción de forma segura.');
  return {
    success: false,
    complete: false,
    action: requiresClarification ? 'clarification_required' : 'rejected_intent_action',
    errorCode: errorCode || 'INVALID_PARAMETERS',
    error: message,
    rawSummary: message,
    confirmation: message,
    requiresClarification,
  };
}

function requiredText(value, errorCode, message) {
  const text = typeof value === 'string' ? value.trim() : '';
  return text ? { valid: true, value: text } : { valid: false, errorCode, error: message };
}

function resolveWorkingItem(user, target, preferredType = null) {
  const reference = String(target || '').trim();
  if (!reference) return null;
  const resolved = resolveContextReference({
    reference,
    preferredType,
    workingMemory: getWorkingMemory(user),
  });
  return resolved.status === 'RESOLVED' ? resolved.item : null;
}

function baseDateFromItem(item, preferredType) {
  if (!item) return null;
  if (preferredType === 'reminder') {
    return item.time || item.raw?.sendAt || item.raw?.send_at || null;
  }
  if (preferredType === 'calendar_event') {
    return item.raw?.start?.dateTime || item.raw?.startDateTime || item.raw?.start || item.time || null;
  }
  if (preferredType === 'task') {
    return item.raw?.due_date || item.raw?.dueDate || item.time || null;
  }
  return item.time || null;
}

function resolveSchedule(action, context, preferredType = null) {
  if (!action.schedule) return { valid: false, errorCode: 'MISSING_SCHEDULE', error: 'Falta indicar la fecha u hora.' };
  if (action.schedule.clockMode === 'ambiguous_12h') {
    return {
      valid: false,
      errorCode: 'AMBIGUOUS_CLOCK_TIME',
      error: context.language === 'en'
        ? 'Please specify whether the time is AM or PM.'
        : 'Indica si la hora es de la mañana o de la tarde.',
      requiresClarification: true,
    };
  }
  const item = action.target ? resolveWorkingItem(context.user, action.target, preferredType) : null;
  const baseDate = baseDateFromItem(item, preferredType);
  return resolveTypedSchedule(action.schedule, {
    referenceTime: context.referenceTime,
    timezone: context.timezone,
    baseDate,
  });
}

function agendaScopeFromAction(action) {
  if (action.scope) return normalizeAgendaScope(action.scope, 'all_pending');
  const schedule = action.schedule;
  if (schedule?.kind === 'relative_day_time') {
    if (schedule.dayOffset === 0) return 'today';
    if (schedule.dayOffset === 1) return 'tomorrow';
    if (schedule.dayOffset === 2) return 'day_after_tomorrow';
  }
  if (schedule?.kind === 'weekday_time' && schedule.weekday) return normalizeAgendaScope(schedule.weekday, 'upcoming');
  return 'all_pending';
}

function explicitAgendaDate(action) {
  const schedule = action.schedule;
  if (schedule?.kind !== 'calendar_date_time') return null;
  if (!Number.isInteger(schedule.month) || !Number.isInteger(schedule.day)) return null;
  const year = Number.isInteger(schedule.year) ? schedule.year : new Date().getUTCFullYear();
  return [year, schedule.month, schedule.day]
    .map((part, index) => index === 0 ? String(part) : String(part).padStart(2, '0'))
    .join('-');
}

export function intentTarget(action) {
  return action.target || action.entityName || action.title || action.content || null;
}

function buildDomainCallForNormalizedAction(action, context) {
  const { language } = context;

  switch (action.domain) {
    case 'agenda': {
      let scope = agendaScopeFromAction(action);
      const date = explicitAgendaDate(action);
      if (date) scope = 'explicit_date';
      return {
        valid: true,
        toolName: TOOL_NAMES.GET_UNIFIED_AGENDA,
        params: {
          scope,
          ...(date ? { date } : {}),
          ...(action.query ? { query: action.query } : {}),
        },
      };
    }

    case 'reminder': {
      if (action.action === 'create') {
        const content = requiredText(action.content || action.title, 'MISSING_CONTENT', 'Falta el contenido del recordatorio.');
        if (!content.valid) return content;
        const temporal = resolveSchedule(action, context, 'reminder');
        if (!temporal.valid) return temporal;
        return {
          valid: true,
          toolName: TOOL_NAMES.MANAGE_REMINDER,
          params: {
            action: 'create',
            items: [{
              content: content.value,
              targetTime: temporal.canonical,
              ...(action.deliveryPolicy?.advanceNotice === 'offset'
                ? { advanceMinutes: action.deliveryPolicy.advanceMinutes }
                : (action.advanceMinutes ? { advanceMinutes: action.advanceMinutes } : {})),
              ...(action.recurrence ? { recurrence: action.recurrence } : {}),
              ...(action.requiresConfirmation ? { requiresConfirmation: true } : {}),
              ...(action.nudgeIntervalMinutes ? { nudgeIntervalMinutes: action.nudgeIntervalMinutes } : {}),
              ...(action.maxNudges ? { maxNudges: action.maxNudges } : {}),
            }],
          },
        };
      }
      if (action.action === 'update') {
        const target = action.target;
        if (!target) return { valid: false, errorCode: 'MISSING_TARGET', error: 'Falta identificar el recordatorio que quieres cambiar.' };
        const updates = {};
        if (action.content || action.title) updates.content = action.content || action.title;
        if (action.schedule) {
          const temporal = resolveSchedule(action, context, 'reminder');
          if (!temporal.valid) return temporal;
          updates.targetTime = temporal.canonical;
        }
        if (action.recurrence) updates.recurrence = action.recurrence;
        const params = { action: 'update', target, updates };
        if (action.deliveryPolicy) params.deliveryPolicy = action.deliveryPolicy;
        else if (action.advanceMinutes) params.advanceMinutes = action.advanceMinutes;
        if (Object.keys(updates).length === 0 && !action.deliveryPolicy && !action.advanceMinutes) {
          return {
            valid: false,
            errorCode: 'MISSING_UPDATES',
            error: context?.language === 'en'
              ? 'What would you like to change on the reminder? (time, date, or title)'
              : '¡De una! ¿Qué te gustaría cambiarle al recordatorio? ¿La hora, la fecha o el texto?',
          };
        }
        return { valid: true, toolName: TOOL_NAMES.MANAGE_REMINDER, params };
      }
      if (action.action === 'add_advance') {
        const target = action.target;
        if (!target) return { valid: false, errorCode: 'MISSING_TARGET', error: 'Falta identificar el recordatorio.' };
        if (!Number.isInteger(action.advanceMinutes)) {
          return { valid: false, errorCode: 'INVALID_ADVANCE_MINUTES', error: 'Falta indicar cuántos minutos antes.' };
        }
        return {
          valid: true,
          toolName: TOOL_NAMES.MANAGE_REMINDER,
          params: {
            action: 'update',
            target,
            deliveryPolicy: { advanceNotice: 'offset', advanceMinutes: action.advanceMinutes },
          },
        };
      }
      if (action.action === 'cancel') {
        if (['all', 'elapsed'].includes(action.scope)) {
          return { valid: true, toolName: TOOL_NAMES.MANAGE_REMINDER, params: { action: 'cancel', scope: action.scope } };
        }
        const target = action.target;
        if (!target) return { valid: false, errorCode: 'MISSING_TARGET', error: 'Falta identificar el recordatorio que quieres cancelar.' };
        return { valid: true, toolName: TOOL_NAMES.MANAGE_REMINDER, params: { action: 'cancel', target } };
      }
      if (action.action === 'acknowledge') {
        const target = action.target || (action.authoritativeReminderId ? '1' : null);
        if (!target) return { valid: false, errorCode: 'MISSING_TARGET', error: 'Falta identificar el recordatorio que completaste.', requiresClarification: true };
        return {
          valid: true,
          toolName: TOOL_NAMES.MANAGE_REMINDER,
          params: {
            action: 'acknowledge',
            target,
            ...(action.authoritativeReminderId
              ? { reminderId: action.authoritativeReminderId }
              : {}),
          },
        };
      }
      return {
        valid: true,
        toolName: TOOL_NAMES.MANAGE_REMINDER,
        params: { action: 'list', ...(action.filter ? { filter: action.filter } : {}), ...(action.scope ? { scope: action.scope } : {}) },
      };
    }

    case 'task': {
      if (action.action === 'create') {
        const title = requiredText(action.title || action.content, 'MISSING_TITLE', 'Falta el título de la tarea.');
        if (!title.valid) return title;
        const item = { title: title.value };
        if (action.description) item.description = action.description;
        if (!action.projectless && action.entityName) {
          item.entityName = action.entityName;
          item.entityCategory = action.category || 'project';
        }
        if (action.priority) item.priority = action.priority;
        if (action.schedule) {
          const temporal = resolveSchedule(action, context, 'task');
          if (!temporal.valid) return temporal;
          item.dueDate = temporal.canonicalDate || temporal.canonical;
        }
        return {
          valid: true,
          toolName: TOOL_NAMES.MANAGE_TASK,
          params: { action: 'create', items: [item], ...(item.entityName ? { entityName: item.entityName } : {}) },
        };
      }
      if (action.action === 'list') {
        const query = action.query || (action.entityName && action.target ? action.target : null);
        return {
          valid: true,
          toolName: TOOL_NAMES.MANAGE_TASK,
          params: {
            action: 'list',
            ...(action.entityName || action.target ? { entityName: action.entityName || action.target } : {}),
            status: action.status || 'pending',
            ...(action.scope ? { scope: action.scope } : {}),
            ...(query ? { query: String(query).trim() } : {}),
          },
        };
      }
      const target = action.target;
      if (!target) return { valid: false, errorCode: 'MISSING_TARGET', error: 'Falta identificar la tarea.' };
      if (action.action === 'complete' || action.action === 'delete') {
        return { valid: true, toolName: TOOL_NAMES.MANAGE_TASK, params: { action: action.action, target, ...(action.entityName ? { entityName: action.entityName } : {}) } };
      }
      const updates = {};
      if (action.title || action.newName) updates.title = action.title || action.newName;
      if (action.description) {
        updates.description = action.description;
        updates.append = true;
      } else if (action.content && !action.title && !action.newName) {
        updates.description = action.content;
        updates.append = true;
      }
      if (action.priority) updates.priority = action.priority;
      if (action.status) updates.status = action.status;
      if (action.schedule) {
        const temporal = resolveSchedule(action, context, 'task');
        if (!temporal.valid) return temporal;
        updates.dueDate = temporal.canonicalDate || temporal.canonical;
      }
      if (Object.keys(updates).length === 0) {
        return {
          valid: false,
          errorCode: 'MISSING_UPDATES',
          error: context?.language === 'en'
            ? 'What would you like to update on the task?'
            : '¡Listo! ¿Qué te gustaría modificar de la tarea? ¿El estado, la fecha o el nombre?',
        };
      }
      return { valid: true, toolName: TOOL_NAMES.MANAGE_TASK, params: { action: 'update', target, updates, ...(action.entityName ? { entityName: action.entityName } : {}) } };
    }

    case 'project': {
      if (action.action === 'create' || action.action === 'upsert') {
        const name = intentTarget(action);
        if (!name) return { valid: false, errorCode: 'MISSING_TARGET', error: 'Falta el nombre del proyecto o lista.' };
        return { valid: true, toolName: TOOL_NAMES.MANAGE_PROJECT, params: { action: action.action, name, description: action.description || null } };
      }
      if (action.action === 'rename') {
        if (!action.oldName && !action.target) return { valid: false, errorCode: 'MISSING_TARGET', error: 'Falta el nombre actual.' };
        if (!action.newName) return { valid: false, errorCode: 'MISSING_UPDATES', error: 'Falta el nombre nuevo.' };
        return { valid: true, toolName: TOOL_NAMES.MANAGE_PROJECT, params: { action: 'rename', oldName: action.oldName || action.target, newName: action.newName } };
      }
      if (action.action === 'delete') {
        const scope = Array.isArray(action.preserveNames) || action.scope === 'all' ? 'all' : (action.scope || 'single');
        const preserveNames = Array.isArray(action.preserveNames) ? action.preserveNames : [];
        if (scope !== 'all' && !(action.target || action.entityName)) return { valid: false, errorCode: 'MISSING_TARGET', error: 'Falta el proyecto que quieres eliminar.' };
        return {
          valid: true,
          toolName: TOOL_NAMES.MANAGE_PROJECT,
          params: {
            action: 'delete',
            ...(action.target || action.entityName ? { targetName: action.target || action.entityName } : {}),
            scope,
            preserveNames,
          },
        };
      }
      return { valid: true, toolName: TOOL_NAMES.MANAGE_PROJECT, params: { action: 'list', ...(action.query ? { query: action.query } : {}), ...(action.limit ? { limit: action.limit } : {}) } };
    }

    case 'entity': {
      if (action.action === 'create' || action.action === 'upsert') {
        const name = intentTarget(action);
        if (!name) return { valid: false, errorCode: 'MISSING_TARGET', error: 'Falta el nombre.' };
        return { valid: true, toolName: TOOL_NAMES.MANAGE_ENTITY, params: { action: action.action, name, category: action.category || 'other' } };
      }
      if (action.action === 'rename') {
        if (!action.oldName && !action.target) return { valid: false, errorCode: 'MISSING_TARGET', error: 'Falta el nombre actual.' };
        if (!action.newName) return { valid: false, errorCode: 'MISSING_UPDATES', error: 'Falta el nombre nuevo.' };
        return { valid: true, toolName: TOOL_NAMES.MANAGE_ENTITY, params: { action: 'rename', oldName: action.oldName || action.target, newName: action.newName } };
      }
      if (action.action === 'merge') {
        if (!action.sourceName || !(action.target || action.entityName)) return { valid: false, errorCode: 'MISSING_TARGET', error: 'Falta las entidades que quieres combinar.' };
        return { valid: true, toolName: TOOL_NAMES.MANAGE_ENTITY, params: { action: 'merge', sourceName: action.sourceName, targetName: action.target || action.entityName } };
      }
      if (action.action === 'delete') {
        const scope = Array.isArray(action.preserveNames) || action.scope === 'all' ? 'all' : (action.scope || 'single');
        const preserveNames = Array.isArray(action.preserveNames) ? action.preserveNames : [];
        if (scope !== 'all' && !(action.target || action.entityName)) return { valid: false, errorCode: 'MISSING_TARGET', error: 'Falta la entidad que quieres eliminar.' };
        if (scope === 'all' && !action.category) return { valid: false, errorCode: 'MISSING_CATEGORY', error: 'Una eliminación masiva debe indicar la categoría exacta.' };
        return {
          valid: true,
          toolName: TOOL_NAMES.MANAGE_ENTITY,
          params: {
            action: 'delete',
            ...(action.target || action.entityName ? { targetName: action.target || action.entityName } : {}),
            ...(action.category ? { category: action.category } : {}),
            scope,
            preserveNames,
          },
        };
      }
      if (action.action === 'deduplicate') {
        return { valid: true, toolName: TOOL_NAMES.MANAGE_ENTITY, params: { action: 'deduplicate', ...(action.category ? { category: action.category } : {}) } };
      }
      return { valid: true, toolName: TOOL_NAMES.MANAGE_ENTITY, params: { action: 'list', ...(action.category ? { category: action.category } : {}), ...(action.limit ? { limit: action.limit } : {}) } };
    }

    case 'calendar': {
      if (action.action === 'create') {
        const title = requiredText(action.title || action.content, 'MISSING_TITLE', 'Falta el nombre del evento.');
        if (!title.valid) return title;
        const temporal = resolveSchedule(action, context, 'calendar_event');
        if (!temporal.valid) return temporal;
        const params = {
          action: 'create_event',
          startDateTime: temporal.canonical,
          summary: title.value,
        };
        if (temporal.isAllDay) {
          params.allDay = true;
          params.startDate = temporal.canonicalDate;
        }
        if (action.recurrence) {
          params.recurrence = action.recurrence;
        }
        if (action.endSchedule) {
          const end = resolveTypedSchedule(action.endSchedule, { referenceTime: context.referenceTime, timezone: context.timezone, baseDate: temporal.date });
          if (!end.valid) return end;
          params.endDateTime = end.canonical;
          if (end.isAllDay) {
            params.endDate = end.canonicalDate;
          }
        } else if (action.durationMinutes) {
          params.durationMinutes = action.durationMinutes;
        }
        if (action.description) params.description = action.description;
        if (action.advanceMinutes) params.advanceMinutes = action.advanceMinutes;
        if (action.addGoogleMeet) params.addGoogleMeet = true;
        return { valid: true, toolName: TOOL_NAMES.MANAGE_GOOGLE_CALENDAR, params };
      }
      if (action.action === 'update') {
        const target = action.target;
        if (!target) return { valid: false, errorCode: 'MISSING_TARGET', error: 'Falta identificar el evento.' };
        const params = { action: 'update_event', target };
        if (action.title || action.content) params.summary = action.title || action.content;
        if (action.schedule) {
          const temporal = resolveSchedule(action, context, 'calendar_event');
          if (!temporal.valid) return temporal;
          params.startDateTime = temporal.canonical;
          if (temporal.isAllDay) {
            params.allDay = true;
            params.startDate = temporal.canonicalDate;
          }
        }
        if (action.recurrence) {
          params.recurrence = action.recurrence;
        }
        if (action.endSchedule) {
          const end = resolveTypedSchedule(action.endSchedule, { referenceTime: context.referenceTime, timezone: context.timezone });
          if (!end.valid) return end;
          params.endDateTime = end.canonical;
          if (end.isAllDay) {
            params.endDate = end.canonicalDate;
          }
        }
        if (action.durationMinutes) params.durationMinutes = action.durationMinutes;
        if (action.description) params.description = action.description;
        if (action.advanceMinutes) params.advanceMinutes = action.advanceMinutes;
        if (action.addGoogleMeet) params.addGoogleMeet = true;
        if (!params.summary && !params.startDateTime && !params.endDateTime && !params.durationMinutes && !params.description && !params.advanceMinutes && !params.addGoogleMeet) {
          return {
            valid: false,
            errorCode: 'MISSING_UPDATES',
            error: context?.language === 'en'
              ? 'What would you like to change on the event?'
              : '¡Entendido! ¿Qué te gustaría modificar del evento de tu calendario?',
          };
        }
        return { valid: true, toolName: TOOL_NAMES.MANAGE_GOOGLE_CALENDAR, params };
      }
      if (action.action === 'delete') {
        const target = action.target;
        if (!target) return { valid: false, errorCode: 'MISSING_TARGET', error: 'Falta identificar el evento.' };
        return { valid: true, toolName: TOOL_NAMES.MANAGE_GOOGLE_CALENDAR, params: { action: 'delete_event', target } };
      }
      if (action.action === 'search') {
        const query = requiredText(action.query || action.target || action.description, 'MISSING_TARGET', 'Falta indicar qué evento buscas.');
        if (!query.valid) return query;
        return {
          valid: true,
          toolName: TOOL_NAMES.MANAGE_GOOGLE_CALENDAR,
          params: {
            action: 'search_events',
            query: query.value,
            ...(action.scope ? { scope: action.scope } : {}),
          },
        };
      }
      if (action.action === 'next') return { valid: true, toolName: TOOL_NAMES.MANAGE_GOOGLE_CALENDAR, params: { action: 'next_event' } };
      if (action.action === 'connect') return { valid: true, toolName: TOOL_NAMES.MANAGE_GOOGLE_CALENDAR, params: { action: 'get_connect_link' } };
      if (action.action === 'disconnect') return { valid: true, toolName: TOOL_NAMES.MANAGE_GOOGLE_CALENDAR, params: { action: 'disconnect' } };
      return {
        valid: true,
        toolName: TOOL_NAMES.MANAGE_GOOGLE_CALENDAR,
        params: {
          action: 'list_events',
          ...(action.scope ? { scope: action.scope } : {}),
          ...(action.query ? { query: action.query } : {}),
        },
      };
    }

    case 'memory': {
      if (action.action === 'save') {
        const content = requiredText(action.content || action.target || action.title || action.description, 'MISSING_CONTENT', 'Falta el dato que quieres guardar.');
        if (!content.valid) return content;
        return {
          valid: true,
          toolName: TOOL_NAMES.MANAGE_MEMORY,
          params: {
            action: 'save', content: content.value,
            ...(action.category ? { category: action.category } : {}),
            ...(action.topicKey ? { topicKey: action.topicKey } : {}),
          },
        };
      }
      if (action.action === 'search') {
        const query = action.query || action.target || action.content || action.title;
        if (!query) return { valid: true, toolName: TOOL_NAMES.MANAGE_MEMORY, params: { action: 'list', ...(action.limit ? { limit: action.limit } : {}) } };
        return { valid: true, toolName: TOOL_NAMES.MANAGE_MEMORY, params: { action: 'search', query, ...(action.limit ? { limit: action.limit } : {}) } };
      }
      if (action.action === 'forget') {
        const query = action.query || action.target || action.content || action.title;
        if (!query) return { valid: false, errorCode: 'MISSING_TARGET', error: 'Falta indicar qué recuerdo quieres olvidar.' };
        return { valid: true, toolName: TOOL_NAMES.MANAGE_MEMORY, params: { action: 'forget', query } };
      }
      return { valid: true, toolName: TOOL_NAMES.MANAGE_MEMORY, params: { action: 'list', ...(action.limit ? { limit: action.limit } : {}) } };
    }

    case 'subscription':
      return {
        valid: true,
        toolName: TOOL_NAMES.MANAGE_SUBSCRIPTION,
        params: { action: action.action === 'link' ? 'get_link' : action.action },
      };

    case 'clarification': {
      let question = action.question || '';
      if (!question && Array.isArray(action.missingFields) && action.missingFields.length > 0) {
        question = formatAssistantClarification({ kind: 'reminder_schedule', subject: '', missingFields: action.missingFields }, language);
      }
      if (!question) question = language === 'en' ? 'I need one detail before I can continue.' : 'Necesito un dato antes de continuar.';
      return {
        valid: true,
        orchestrationOnly: true,
        result: failedResult('MISSING_REQUIRED_CONTEXT', question, language, { requiresClarification: true }),
      };
    }

    case 'admin':
      return { valid: true, toolName: TOOL_NAMES.ADMIN_METRICS, params: { action: action.query || 'get_overview' } };

    default:
      return { valid: false, errorCode: 'UNSUPPORTED_DOMAIN', error: `Dominio no soportado: ${action.domain}.` };
  }
}


/** Build the validated canonical tool call used by fresh and resumed actions. */
export function buildDomainCall(action, context = {}) {
  const normalized = normalizeTurnActionForRuntime(action, context);
  return buildDomainCallForNormalizedAction(normalized, context);
}
