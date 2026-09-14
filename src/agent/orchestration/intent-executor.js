import { executeTool } from '../tools/index.js';
import { TOOL_NAMES } from '../contracts/tool-names.js';
import { createExecutionFact } from '../core/execution-facts.js';
import {
  getWorkingMemory,
  saveWorkingMemory,
  clearWorkingMemory,
} from '../core/working-memory-store.js';
import {
  parseStructuredOrdinal,
  resolveContextReference,
} from '../core/context-reference.js';
import { normalizeAgendaScope } from '../../shared/agenda-scopes.js';
import { resolveTypedSchedule } from './typed-schedule.js';
import { formatAssistantClarification } from './clarification-presentation.js';
import { pinReminderCancellationTargets } from './context-target-pinner.js';
import { createApprovalRun, createInputRun } from '../core/agent-run.js';

const MAX_ACTIONS_PER_TURN = 12;

function failedResult(errorCode, error, language = 'es', { requiresClarification = false } = {}) {
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

function intentTarget(action) {
  return action.target || action.entityName || action.title || action.content || null;
}

function buildDomainCall(action, context) {
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
              ...(action.advanceMinutes ? { advanceMinutes: action.advanceMinutes } : {}),
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
        if (action.advanceMinutes) params.advanceMinutes = action.advanceMinutes;
        if (Object.keys(updates).length === 0 && !action.advanceMinutes) {
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
        return { valid: true, toolName: TOOL_NAMES.MANAGE_REMINDER, params: { action: 'update', target, advanceMinutes: action.advanceMinutes } };
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
          item.dueDate = temporal.canonical;
        }
        return {
          valid: true,
          toolName: TOOL_NAMES.MANAGE_TASK,
          params: { action: 'create', items: [item], ...(item.entityName ? { entityName: item.entityName } : {}) },
        };
      }
      if (action.action === 'list') {
        return {
          valid: true,
          toolName: TOOL_NAMES.MANAGE_TASK,
          params: {
            action: 'list',
            ...(action.entityName || action.target ? { entityName: action.entityName || action.target } : {}),
            status: action.status || 'pending',
            ...(action.scope ? { scope: action.scope } : {}),
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
        updates.dueDate = temporal.canonical;
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
        if (action.endSchedule) {
          const end = resolveTypedSchedule(action.endSchedule, { referenceTime: context.referenceTime, timezone: context.timezone });
          if (!end.valid) return end;
          params.endDateTime = end.canonical;
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
        }
        if (action.endSchedule) {
          const end = resolveTypedSchedule(action.endSchedule, { referenceTime: context.referenceTime, timezone: context.timezone });
          if (!end.valid) return end;
          params.endDateTime = end.canonical;
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
        return { valid: true, toolName: TOOL_NAMES.MANAGE_GOOGLE_CALENDAR, params: { action: 'search_events', query: query.value } };
      }
      if (action.action === 'next') return { valid: true, toolName: TOOL_NAMES.MANAGE_GOOGLE_CALENDAR, params: { action: 'next_event' } };
      if (action.action === 'connect') return { valid: true, toolName: TOOL_NAMES.MANAGE_GOOGLE_CALENDAR, params: { action: 'get_connect_link' } };
      if (action.action === 'disconnect') return { valid: true, toolName: TOOL_NAMES.MANAGE_GOOGLE_CALENDAR, params: { action: 'disconnect' } };
      return { valid: true, toolName: TOOL_NAMES.MANAGE_GOOGLE_CALENDAR, params: { action: 'list_events', ...(action.scope ? { scope: action.scope } : {}) } };
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

function extractWorkingItems(data) {
  if (!data) return [];
  if (Array.isArray(data)) return data;
  if (Array.isArray(data.items)) return data.items;
  if (Array.isArray(data.events)) return data.events;
  if (Array.isArray(data.reminders)) return data.reminders;
  if (Array.isArray(data.tasks)) return data.tasks;
  if (data.id && (data.title || data.content || data.name || data.summary)) return [data];
  return [];
}

function inferItemType(toolName) {
  if (toolName === TOOL_NAMES.MANAGE_TASK) return 'task';
  if (toolName === TOOL_NAMES.MANAGE_PROJECT) return 'project';
  if (toolName === TOOL_NAMES.MANAGE_REMINDER) return 'reminder';
  if (toolName === TOOL_NAMES.MANAGE_GOOGLE_CALENDAR) return 'calendar_event';
  if (toolName === TOOL_NAMES.MANAGE_ENTITY) return 'entity';
  return 'all';
}

const MISSING_FIELD_BY_ERROR = Object.freeze({
  AMBIGUOUS_TARGET: 'selection',
  MISSING_TARGET: 'target',
  MISSING_TARGET_ID: 'target',
  MISSING_CONTENT: 'content',
  MISSING_SCHEDULE: 'schedule',
  MISSING_CLOCK_TIME: 'time',
  AMBIGUOUS_CLOCK_TIME: 'time',
  MISSING_CALENDAR_DATE: 'date',
  MISSING_UPDATES: 'content',
});

function pendingMissingFields(actions, clarification = null, fallbackErrorCode = null) {
  const fields = [
    ...actions.flatMap((action) => Array.isArray(action?.missingFields) ? action.missingFields : []),
    ...(Array.isArray(clarification?.missingFields) ? clarification.missingFields : []),
    ...(MISSING_FIELD_BY_ERROR[fallbackErrorCode] ? [MISSING_FIELD_BY_ERROR[fallbackErrorCode]] : []),
  ];
  return [...new Set(fields)];
}

function defaultPendingQuestion(actions, language = 'es') {
  const action = actions.find((candidate) => candidate?.question || candidate?.content || candidate?.title) || actions[0];
  if (action?.question) return action.question;
  if (action?.schedule?.clockMode === 'ambiguous_12h') {
    return language === 'en'
      ? 'Should I use that time in the morning or afternoon?'
      : '¿Esa hora es de la mañana o de la tarde?';
  }
  if (action?.domain === 'reminder' && action?.action === 'create') {
    const content = action.content || action.title;
    const missing = new Set(Array.isArray(action.missingFields) ? action.missingFields : []);
    if (content && missing.size === 1 && missing.has('time')) return language === 'en'
      ? `What time should I remind you about “${content}”?`
      : `¿A qué hora quieres que te recuerde “${content}”?`;
    if (content && missing.size === 1 && missing.has('date')) return language === 'en'
      ? `What day should I remind you about “${content}”?`
      : `¿Qué día quieres que te recuerde “${content}”?`;
    if (content) return language === 'en'
      ? `When should I remind you about “${content}”?`
      : `¿Cuándo quieres que te recuerde “${content}”?`;
  }
  return language === 'en'
    ? 'What information should I use to continue?'
    : '¿Qué dato debo usar para continuar?';
}

function updateWorkingMemoryFromExecution({ user, action, toolName, params, result }) {
  const existingMemory = getWorkingMemory(user);

  if (
    toolName === TOOL_NAMES.MANAGE_REMINDER
    && params.action === 'acknowledge'
    && result.success
  ) {
    if (!existingMemory) return;
    const acknowledgedId = String(result.data?.id || params.reminderId || '').trim();
    const remainingItems = (existingMemory.items || []).filter((item) => (
      !acknowledgedId || String(item?.internalId || '').trim() !== acknowledgedId
    ));
    if (remainingItems.length === 0 && !existingMemory.activeEntity) {
      clearWorkingMemory(user);
      return;
    }
    saveWorkingMemory(user, {
      ...existingMemory,
      lastAction: 'reminder_acknowledged',
      notificationReminderId: null,
      notificationContent: null,
      items: remainingItems,
    });
    return;
  }

  const items = extractWorkingItems(result.data);
  if (items.length === 0) return;
  const firstType = items[0]?.type || inferItemType(toolName);
  const uniform = items.every((item) => (item.type || firstType) === firstType);
  const source = toolName === TOOL_NAMES.GET_UNIFIED_AGENDA
    ? 'unified'
    : toolName === TOOL_NAMES.MANAGE_GOOGLE_CALENDAR
      ? 'calendar'
      : toolName === TOOL_NAMES.MANAGE_REMINDER
        ? 'reminder'
        : toolName === TOOL_NAMES.MANAGE_PROJECT
          ? 'project'
          : toolName === TOOL_NAMES.MANAGE_ENTITY ? 'entity' : 'task';

  const uniformEntityName = items.length > 0
    && items.every((item) => item?.entityName && item.entityName === items[0]?.entityName)
    ? items[0].entityName
    : null;
  const uniformEntityId = items.length > 0
    ? items
      .map((item) => item?.entityId || item?.raw?.entity_id || item?.raw?.entityId || item?.raw?.entities?.id || null)
      .filter(Boolean)
      .find((id, _index, ids) => ids.every((candidate) => candidate === id)) || null
    : null;
  const activeEntity = result.data?.entityName
    || params.entityName
    || ((toolName === TOOL_NAMES.MANAGE_PROJECT || toolName === TOOL_NAMES.MANAGE_ENTITY) ? result.data?.name : null)
    || uniformEntityName;
  const activeEntityId = result.data?.entityId
    || ((toolName === TOOL_NAMES.MANAGE_PROJECT || toolName === TOOL_NAMES.MANAGE_ENTITY) ? result.data?.id : null)
    || uniformEntityId;

  let workingItems = items;
  const sameContainer = Boolean(
    existingMemory
    && toolName === TOOL_NAMES.MANAGE_TASK
    && params.action === 'create'
    && (
      (activeEntityId && existingMemory.activeEntityId === activeEntityId)
      || (activeEntity && existingMemory.activeEntity === activeEntity)
    )
  );
  if (sameContainer) {
    const byId = new Map();
    for (const item of [...(existingMemory.items || []), ...items]) {
      const id = String(item?.internalId || item?.id || '').trim();
      if (id) byId.set(id, item);
    }
    workingItems = [...byId.values()].slice(-10);
  }

  saveWorkingMemory(user, {
    source,
    scope: params.scope || 'current',
    semanticQuery: params.query || null,
    entityType: uniform ? firstType : 'all',
    activeEntity,
    activeEntityId,
    lastAction: toolName,
    items: workingItems,
  });
}

/** Execute semantic TurnIntent directly against deterministic domain tools. */
export async function executeTurnIntent(intent, context) {
  let actions = Array.isArray(intent?.actions) ? intent.actions : [];
  if (actions.length === 0) return { records: [], facts: [], excluded: intent?.excluded || [] };
  if (actions.length > MAX_ACTIONS_PER_TURN) {
    const result = failedResult('TURN_ACTION_LIMIT', `El turno supera el límite de ${MAX_ACTIONS_PER_TURN} acciones.`, context.language);
    const fact = createExecutionFact({ toolName: 'orchestrator', params: {}, result, callId: 'intent_limit', language: context.language });
    return { records: [{ toolName: 'orchestrator', params: {}, result, fact }], facts: [fact], excluded: intent?.excluded || [] };
  }

  const clarificationActions = actions.filter((action) => action.domain === 'clarification');
  const regularActions = actions.filter((action) => action.domain !== 'clarification');

  const staged = regularActions.filter((action) => {
    if (Array.isArray(action.missingFields) && action.missingFields.length > 0) return true;
    return buildDomainCall(action, context).requiresClarification === true;
  });
  if (staged.length > 0) {
    const stagedDrafts = staged.map((action) => action.schedule?.clockMode === 'ambiguous_12h'
      ? { ...action, missingFields: [...new Set([...(action.missingFields || []), 'time'])] }
      : action);
    const clarification = clarificationActions[0] || {
      domain: 'clarification',
      action: 'request',
      question: defaultPendingQuestion(stagedDrafts, context.language),
      missingFields: pendingMissingFields(stagedDrafts),
    };

    await createInputRun({
      user: context.user,
      kind: stagedDrafts.every((d) => d.domain === 'reminder') ? 'reminder_creation' : 'input_draft',
      partialActions: stagedDrafts,
      missingFields: pendingMissingFields(stagedDrafts, clarification),
      question: clarification.question || '',
      context: { drafts: stagedDrafts },
      referenceTime: context.referenceTime,
    });

    const stagedSet = new Set(staged);
    actions = actions.filter((action) => !stagedSet.has(action));
    if (clarificationActions.length === 0) actions.push(clarification);
  }

  // Resolve contextual identities once against the pre-mutation snapshot. This
  // prevents ordinal drift and lets duplicate human labels be paired safely
  // when Hermes emitted one cancellation action per listed reminder.
  const pinnedReminderTargets = pinReminderCancellationTargets(
    actions,
    getWorkingMemory(context.user),
  );

  const records = [];
  const facts = [];

  for (let index = 0; index < actions.length; index += 1) {
    const actionIndex = index;
    const action = actions[index];
    let toolName = 'orchestrator';
    let params = {};
    let result;

    const taskCreateBatch = [];
    const projectDeleteBatch = [];
    const entityDeleteBatch = [];
    let batchEnd = index;

    if (action.domain === 'task' && action.action === 'create') {
      while (
        batchEnd < actions.length
        && actions[batchEnd]?.domain === 'task'
        && actions[batchEnd]?.action === 'create'
      ) {
        taskCreateBatch.push(buildDomainCall(actions[batchEnd], context));
        batchEnd += 1;
      }
    } else if (action.domain === 'project' && action.action === 'delete' && action.scope !== 'all' && intentTarget(action)) {
      while (
        batchEnd < actions.length
        && actions[batchEnd]?.domain === 'project'
        && actions[batchEnd]?.action === 'delete'
        && actions[batchEnd]?.scope !== 'all'
        && intentTarget(actions[batchEnd])
      ) {
        projectDeleteBatch.push(actions[batchEnd]);
        batchEnd += 1;
      }
    } else if (action.domain === 'entity' && action.action === 'delete' && action.scope !== 'all' && intentTarget(action)) {
      while (
        batchEnd < actions.length
        && actions[batchEnd]?.domain === 'entity'
        && actions[batchEnd]?.action === 'delete'
        && actions[batchEnd]?.scope !== 'all'
        && intentTarget(actions[batchEnd])
      ) {
        entityDeleteBatch.push(actions[batchEnd]);
        batchEnd += 1;
      }
    }

    const invalidBatchItem = taskCreateBatch.find((prepared) => !prepared.valid);
    if (invalidBatchItem) {
      result = failedResult(invalidBatchItem.errorCode, invalidBatchItem.error, context.language, { requiresClarification: invalidBatchItem.requiresClarification });
      index = batchEnd - 1;
    } else if (taskCreateBatch.length > 0) {
      toolName = TOOL_NAMES.MANAGE_TASK;
      params = {
        action: 'create',
        items: taskCreateBatch.flatMap((prepared) => prepared.params.items || []),
      };
      const runTool = context.executeTool || executeTool;
      result = await runTool({
        toolName,
        params,
        user: context.user,
        isPro: context.isPro,
        language: context.language,
        correlationId: context.correlationId,
        referenceTime: context.referenceTime,
      });
      index = batchEnd - 1;
    } else if (projectDeleteBatch.length > 1) {
      toolName = TOOL_NAMES.MANAGE_PROJECT;
      params = {
        action: 'delete',
        targetNames: projectDeleteBatch.map((a) => intentTarget(a)).filter(Boolean),
      };
      const runTool = context.executeTool || executeTool;
      result = await runTool({
        toolName,
        params,
        user: context.user,
        isPro: context.isPro,
        language: context.language,
        correlationId: context.correlationId,
        referenceTime: context.referenceTime,
      });
      index = batchEnd - 1;
    } else if (entityDeleteBatch.length > 1) {
      toolName = TOOL_NAMES.MANAGE_ENTITY;
      params = {
        action: 'delete',
        targetNames: entityDeleteBatch.map((a) => intentTarget(a)).filter(Boolean),
      };
      const runTool = context.executeTool || executeTool;
      result = await runTool({
        toolName,
        params,
        user: context.user,
        isPro: context.isPro,
        language: context.language,
        correlationId: context.correlationId,
        referenceTime: context.referenceTime,
      });
      index = batchEnd - 1;
    } else {
      const prepared = buildDomainCall(action, context);
      if (!prepared.valid) {
        result = failedResult(prepared.errorCode, prepared.error, context.language, { requiresClarification: prepared.requiresClarification });
      } else if (prepared.orchestrationOnly) {
        result = prepared.result;
      } else {
        toolName = prepared.toolName;
        params = prepared.params;
        if (
          pinnedReminderTargets instanceof Map
          && pinnedReminderTargets.has(index)
          && toolName === TOOL_NAMES.MANAGE_REMINDER
          && ['cancel', 'update'].includes(params.action)
          && !params.scope
        ) {
          const pinnedId = pinnedReminderTargets.get(index);
          if (pinnedId) {
            params = {
              ...params,
              target: pinnedId,
              reminderId: pinnedId,
            };
          }
        }
        const runTool = context.executeTool || executeTool;
        result = await runTool({
          toolName,
          params,
          user: context.user,
          isPro: context.isPro,
          language: context.language,
          correlationId: context.correlationId,
          referenceTime: context.referenceTime,
        });
      }
    }

    const fact = createExecutionFact({
      toolName,
      params,
      result,
      callId: `call_${actionIndex + 1}`,
      language: context.language,
    });
    records.push({ toolName, params, result, fact });
    facts.push(fact);

    if (
      (result.action === 'entity_deletion_confirmation_required' || result.action === 'project_deletion_confirmation_required')
      && (Array.isArray(result.data?.previewProjects) || Array.isArray(result.data?.previewEntities))
    ) {
      const isProject = result.action === 'project_deletion_confirmation_required';
      const items = (isProject ? result.data?.previewProjects : result.data?.previewEntities) || [];
      if (items.length > 0) {
        const preparedActions = items.map((item, idx) => ({
          callId: `call-${idx + 1}`,
          domain: isProject ? 'project' : 'entity',
          action: 'delete',
          targetId: item.id,
          targetName: item.name,
          payload: isProject ? { action: 'delete', projectIds: [item.id] } : { action: 'delete', entityIds: [item.id] },
          status: 'prepared',
        }));

        await createApprovalRun({
          user: context.user,
          kind: 'entity_destructive_batch',
          preparedActions,
          question: result.error || result.rawSummary,
          context: { previewEntities: items, isProject },
        });
      }
    }

    if ((result.success || result.requiresClarification) && toolName !== 'orchestrator') {
      updateWorkingMemoryFromExecution({ user: context.user, action, toolName, params, result });
    }
  }

  const allProposedReminders = records.flatMap(({ result }) => (
    Array.isArray(result?.data?.pendingClarifications)
      ? result.data.pendingClarifications.filter((item) => item?.proposedReminder?.targetTime)
      : []
  ));

  if (allProposedReminders.length > 0) {
    const preparedActions = allProposedReminders.map((item, idx) => ({
      callId: `call-${idx + 1}`,
      domain: 'reminder',
      action: 'create',
      targetId: null,
      targetName: item.content,
      payload: {
        action: 'create',
        items: [{
          content: item.content,
          targetTime: item.proposedReminder.targetTime,
          ...(item.proposedReminder.advanceMinutes ? { advanceMinutes: item.proposedReminder.advanceMinutes } : {}),
          ...(item.proposedReminder.recurrence ? { recurrence: item.proposedReminder.recurrence } : {}),
          ...(item.proposedReminder.requiresConfirmation ? { requiresConfirmation: true } : {}),
          ...(item.proposedReminder.nudgeIntervalMinutes ? { nudgeIntervalMinutes: item.proposedReminder.nudgeIntervalMinutes } : {}),
          ...(item.proposedReminder.maxNudges ? { maxNudges: item.proposedReminder.maxNudges } : {}),
        }],
      },
      status: 'prepared',
    }));

    const questions = allProposedReminders.map((p) => p.question).filter(Boolean);
    await createApprovalRun({
      user: context.user,
      kind: 'proposal_approval',
      preparedActions,
      question: questions.join('\n') || (context.language === 'en' ? 'Do you want me to schedule these reminders?' : '¿Deseas programar estos recordatorios?'),
      context: { proposedReminders: allProposedReminders },
      referenceTime: context.referenceTime,
    });
  }

  return { records, facts, excluded: intent?.excluded || [] };
}

export function inferIntentFromTool(toolName) {
  const intents = {
    [TOOL_NAMES.MANAGE_MEMORY]: 'memory',
    [TOOL_NAMES.MANAGE_REMINDER]: 'reminder',
    [TOOL_NAMES.MANAGE_TASK]: 'task',
    [TOOL_NAMES.MANAGE_PROJECT]: 'project',
    [TOOL_NAMES.MANAGE_ENTITY]: 'entity',
    [TOOL_NAMES.MANAGE_SUBSCRIPTION]: 'subscription',
    [TOOL_NAMES.MANAGE_GOOGLE_CALENDAR]: 'calendar',
    [TOOL_NAMES.GET_UNIFIED_AGENDA]: 'unified_agenda',
    [TOOL_NAMES.ADMIN_METRICS]: 'admin',
  };
  return intents[toolName] || 'chat';
}
