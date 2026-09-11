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
import {
  createPendingIntent,
  mergePendingIntentActions,
} from '../core/pending-intent.js';

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
          return { valid: false, errorCode: 'MISSING_UPDATES', error: 'No se indicó qué cambiar del recordatorio.' };
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
        const target = action.target;
        if (!target) return { valid: false, errorCode: 'MISSING_TARGET', error: 'Falta identificar el recordatorio que completaste.' };
        return { valid: true, toolName: TOOL_NAMES.MANAGE_REMINDER, params: { action: 'acknowledge', target } };
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
      if (action.title || action.content) updates.title = action.title || action.content;
      if (action.description) updates.description = action.description;
      if (action.priority) updates.priority = action.priority;
      if (action.status) updates.status = action.status;
      if (action.schedule) {
        const temporal = resolveSchedule(action, context, 'task');
        if (!temporal.valid) return temporal;
        updates.dueDate = temporal.canonical;
      }
      if (Object.keys(updates).length === 0) return { valid: false, errorCode: 'MISSING_UPDATES', error: 'No se indicó qué cambiar de la tarea.' };
      return { valid: true, toolName: TOOL_NAMES.MANAGE_TASK, params: { action: 'update', target, updates, ...(action.entityName ? { entityName: action.entityName } : {}) } };
    }

    case 'entity': {
      if (action.action === 'create' || action.action === 'upsert') {
        const name = intentTarget(action);
        if (!name) return { valid: false, errorCode: 'MISSING_TARGET', error: 'Falta el nombre.' };
        return { valid: true, toolName: TOOL_NAMES.MANAGE_ENTITY, params: { action: action.action, name, category: action.category || 'project' } };
      }
      if (action.action === 'rename') {
        if (!action.oldName && !action.target) return { valid: false, errorCode: 'MISSING_TARGET', error: 'Falta el nombre actual.' };
        if (!action.newName) return { valid: false, errorCode: 'MISSING_UPDATES', error: 'Falta el nombre nuevo.' };
        return { valid: true, toolName: TOOL_NAMES.MANAGE_ENTITY, params: { action: 'rename', oldName: action.oldName || action.target, newName: action.newName } };
      }
      if (action.action === 'merge') {
        if (!action.sourceName || !(action.target || action.entityName)) return { valid: false, errorCode: 'MISSING_TARGET', error: 'Faltan las entidades que quieres combinar.' };
        return { valid: true, toolName: TOOL_NAMES.MANAGE_ENTITY, params: { action: 'merge', sourceName: action.sourceName, targetName: action.target || action.entityName } };
      }
      if (action.action === 'delete') {
        const scope = Array.isArray(action.preserveNames) ? 'all' : (action.scope || 'single');
        if (scope !== 'all' && !(action.target || action.entityName)) return { valid: false, errorCode: 'MISSING_TARGET', error: 'Falta la entidad que quieres eliminar.' };
        if (scope === 'all' && !Array.isArray(action.preserveNames)) return { valid: false, errorCode: 'MISSING_PRESERVE_NAMES', error: 'Una eliminación masiva debe indicar las excepciones a preservar.' };
        if (scope === 'all' && !action.category) return { valid: false, errorCode: 'MISSING_CATEGORY', error: 'Una eliminación masiva debe indicar la categoría exacta.' };
        return {
          valid: true,
          toolName: TOOL_NAMES.MANAGE_ENTITY,
          params: {
            action: 'delete',
            ...(action.target || action.entityName ? { targetName: action.target || action.entityName } : {}),
            ...(action.category ? { category: action.category } : {}),
            scope,
            ...(Array.isArray(action.preserveNames) ? { preserveNames: action.preserveNames } : {}),
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
          return { valid: false, errorCode: 'MISSING_UPDATES', error: 'No se indicó qué cambiar del evento.' };
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

    case 'pending':
      return { valid: true, pending: true };

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
    if (content) return language === 'en'
      ? `When should I remind you about “${content}”?`
      : `¿Cuándo quieres que te recuerde “${content}”?`;
  }
  return language === 'en'
    ? 'What information should I use to continue?'
    : '¿Qué dato debo usar para continuar?';
}

function savePendingIntentState(user, actions, {
  question = '', missingFields = [], replace = false,
} = {}) {
  const memory = getWorkingMemory(user);
  const pendingIntent = createPendingIntent({ actions, missingFields, question });
  if (!pendingIntent) return false;
  saveWorkingMemory(user, {
    ...(memory || {}),
    source: memory?.source || actions[0]?.domain || 'unified',
    scope: 'clarification',
    entityType: memory?.entityType || actions[0]?.domain || 'all',
    lastAction: replace ? 'pending_intent_revised' : 'pending_intent_created',
    pendingIntent,
    pendingClarifications: memory?.pendingClarifications || [],
    pendingExpiresAt: null,
    refreshPendingExpiry: true,
    items: memory?.items || [],
  });
  return true;
}

function clearPendingIntentState(user) {
  const memory = getWorkingMemory(user);
  if (!memory) return;
  const hasLegacyPending = (memory.pendingClarifications || []).length > 0;
  if (!hasLegacyPending && (memory.items || []).length === 0) {
    clearWorkingMemory(user);
    return;
  }
  saveWorkingMemory(user, {
    ...memory,
    pendingIntent: null,
    pendingExpiresAt: hasLegacyPending ? memory.pendingExpiresAt : null,
    lastAction: 'pending_intent_resolved',
  });
}

function updateWorkingMemoryFromExecution({ user, action, toolName, params, result }) {
  const existingMemory = getWorkingMemory(user);
  const pendingClarifications = result.pendingClarifications || result.data?.pendingClarifications || [];

  if (pendingClarifications.length > 0) {
    const existingPending = existingMemory?.pendingClarifications || [];
    const combinedPending = [];
    const seen = new Set();
    for (const item of [...existingPending, ...pendingClarifications]) {
      const identity = [
        item?.type || 'clarification', item?.content || '', item?.proposedReminder?.targetTime || '',
        item?.proposedOperation?.kind || '', item?.proposedOperation?.targetName || '', item?.proposedOperation?.scope || '',
        ...(item?.proposedOperation?.preserveNames || []),
      ].join('|');
      if (seen.has(identity)) continue;
      seen.add(identity);
      combinedPending.push(item);
    }
    saveWorkingMemory(user, {
      source: toolName === TOOL_NAMES.MANAGE_REMINDER ? 'reminder' : (toolName === TOOL_NAMES.MANAGE_ENTITY ? 'entity' : 'unified'),
      scope: 'clarification',
      entityType: toolName === TOOL_NAMES.MANAGE_REMINDER ? 'reminder' : (toolName === TOOL_NAMES.MANAGE_ENTITY ? 'entity' : 'all'),
      lastAction: 'clarification_required',
      pendingIntent: existingMemory?.pendingIntent || null,
      pendingClarifications: combinedPending,
      pendingExpiresAt: null,
      refreshPendingExpiry: true,
      items: existingMemory?.items || [],
    });
    return;
  }

  if (result.requiresClarification && action?.domain && action?.action) {
    savePendingIntentState(user, [action], {
      question: result.error || result.rawSummary || '',
      missingFields: pendingMissingFields([action], null, result.errorCode),
      replace: Boolean(existingMemory?.pendingIntent),
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
        : toolName === TOOL_NAMES.MANAGE_ENTITY ? 'entity' : 'task';

  saveWorkingMemory(user, {
    source,
    scope: params.scope || 'current',
    semanticQuery: params.query || null,
    entityType: uniform ? firstType : 'all',
    activeEntity: result.data?.entityName || params.entityName || items[0]?.entityName || null,
    activeEntityId: result.data?.entityId || items[0]?.entityId || items[0]?.raw?.entity_id || null,
    lastAction: toolName,
    pendingIntent: existingMemory?.pendingIntent || null,
    pendingExpiresAt: existingMemory?.pendingExpiresAt || null,
    pendingClarifications: existingMemory?.pendingClarifications || [],
    items,
  });
}

function saveRemainingPendingState(user, memory, pendingClarifications) {
  if (pendingClarifications.length === 0) {
    if (!memory?.pendingIntent && (memory?.items || []).length === 0) {
      clearWorkingMemory(user);
      return;
    }
    saveWorkingMemory(user, {
      ...memory,
      pendingClarifications: [],
      pendingExpiresAt: memory?.pendingIntent ? memory.pendingExpiresAt : null,
      lastAction: memory.lastAction || 'pending_resolved',
    });
    return;
  }
  saveWorkingMemory(user, { ...memory, pendingClarifications });
}

function pendingPosition(action, count) {
  const numeric = Number.parseInt(String(action.target || ''), 10);
  if (Number.isInteger(numeric) && numeric >= 1 && numeric <= count) return numeric;
  const ordinal = parseStructuredOrdinal(String(action.target || ''));
  if (Number.isInteger(ordinal) && ordinal >= 1 && ordinal <= count) return ordinal;
  return count === 1 ? 1 : null;
}

async function executePendingAction(action, context) {
  const memory = getWorkingMemory(context.user);
  const pending = memory?.pendingClarifications || [];
  if (pending.length === 0) {
    if (memory?.pendingIntent && action.action === 'discard') {
      clearPendingIntentState(context.user);
      const confirmation = context.language === 'en' ? 'Understood — I discarded the pending request.' : 'Entendido — descarté la solicitud pendiente.';
      return { toolName: 'orchestrator', params: { action: 'discard_pending_intent' }, result: { success: true, complete: true, action: 'discarded_pending', rawSummary: confirmation, confirmation } };
    }
    return { toolName: 'orchestrator', params: {}, result: failedResult('NO_PENDING_STATE', context.language === 'en' ? 'There is no pending proposal.' : 'No hay ninguna propuesta pendiente.', context.language) };
  }

  const position = pendingPosition(action, pending.length);
  if (!position) {
    const labels = pending.slice(0, 5).map((item, index) => `${index + 1}. ${item.content}`).join('\n');
    const question = context.language === 'en' ? `Which pending proposal do you mean?\n${labels}` : `¿A cuál propuesta pendiente te refieres?\n${labels}`;
    return { toolName: 'orchestrator', params: {}, result: failedResult('AMBIGUOUS_PENDING_STATE', question, context.language, { requiresClarification: true }) };
  }

  const selected = pending[position - 1];
  const remaining = pending.filter((_item, index) => index !== position - 1);
  if (action.action === 'discard') {
    saveRemainingPendingState(context.user, memory, remaining);
    const confirmation = context.language === 'en' ? 'Understood — I discarded the pending proposal.' : 'Entendido — descarté la propuesta pendiente.';
    return { toolName: 'orchestrator', params: { action: 'discard_pending' }, result: { success: true, complete: true, action: 'discarded_pending', rawSummary: confirmation, confirmation } };
  }

  const proposed = selected.proposedOperation;
  if (proposed?.kind === 'entity_delete') {
    const params = {
      action: 'delete',
      ...(proposed.targetName ? { targetName: proposed.targetName } : {}),
      ...(proposed.category ? { category: proposed.category } : {}),
      scope: proposed.scope || 'single',
      ...(proposed.preserveNames?.length ? { preserveNames: proposed.preserveNames } : {}),
    };
    if (action.action === 'revise') {
      if (action.entityName) params.targetName = action.entityName;
      if (action.category) params.category = action.category;
      if (action.scope) params.scope = action.scope;
      if (action.preserveNames) params.preserveNames = action.preserveNames;
    }
    const result = await executeTool({ ...context, toolName: TOOL_NAMES.MANAGE_ENTITY, params, clarificationResolution: true });
    if (result.success) saveRemainingPendingState(context.user, memory, remaining);
    return { toolName: TOOL_NAMES.MANAGE_ENTITY, params, result };
  }

  if (proposed?.kind === 'reminder_cancel') {
    const params = { action: 'cancel', scope: proposed.scope, ...(proposed.cutoffAt ? { cutoffAt: proposed.cutoffAt } : {}) };
    const result = await executeTool({ ...context, toolName: TOOL_NAMES.MANAGE_REMINDER, params, clarificationResolution: true });
    if (result.success) saveRemainingPendingState(context.user, memory, remaining);
    return { toolName: TOOL_NAMES.MANAGE_REMINDER, params, result };
  }

  const proposal = selected.proposedReminder;
  if (!proposal?.targetTime) {
    return { toolName: 'orchestrator', params: {}, result: failedResult('INVALID_PENDING_PROPOSAL', context.language === 'en' ? 'The pending proposal has no valid time.' : 'La propuesta pendiente no tiene una hora válida.', context.language) };
  }

  let targetTime = proposal.targetTime;
  if (action.action === 'revise') {
    const temporal = resolveTypedSchedule(action.schedule, {
      referenceTime: context.referenceTime,
      timezone: context.timezone,
      baseDate: new Date(proposal.targetTime),
    });
    if (!temporal.valid) {
      return { toolName: 'orchestrator', params: {}, result: failedResult(temporal.errorCode, temporal.error, context.language, { requiresClarification: true }) };
    }
    targetTime = temporal.canonical;
  }

  const params = {
    action: 'create',
    items: [{ ...proposal, targetTime }],
  };
  const result = await executeTool({ ...context, toolName: TOOL_NAMES.MANAGE_REMINDER, params, clarificationResolution: true });
  if (result.success) saveRemainingPendingState(context.user, memory, remaining);
  return { toolName: TOOL_NAMES.MANAGE_REMINDER, params, result };
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

  const pendingEffect = intent?.pendingIntentEffect || null;
  const existingPendingIntent = getWorkingMemory(context.user)?.pendingIntent || null;
  const clarificationActions = actions.filter((action) => action.domain === 'clarification');
  const regularActions = actions.filter((action) => !['clarification', 'pending'].includes(action.domain));

  if (pendingEffect && !existingPendingIntent) {
    const result = failedResult('NO_PENDING_INTENT', context.language === 'en' ? 'That pending request is no longer active.' : 'Esa solicitud pendiente ya no está activa.', context.language, { requiresClarification: true });
    const fact = createExecutionFact({ toolName: 'orchestrator', params: {}, result, callId: 'pending_intent_missing', language: context.language });
    return { records: [{ toolName: 'orchestrator', params: {}, result, fact }], facts: [fact], excluded: intent?.excluded || [] };
  }

  if (existingPendingIntent && !pendingEffect && regularActions.length > 0) {
    const result = failedResult('PENDING_INTENT_EFFECT_REQUIRED', context.language === 'en' ? 'I need to know whether this continues the pending request or starts a separate one.' : 'Necesito distinguir si esto continúa la solicitud pendiente o inicia una diferente.', context.language, { requiresClarification: true });
    const fact = createExecutionFact({ toolName: 'orchestrator', params: {}, result, callId: 'pending_intent_effect', language: context.language });
    return { records: [{ toolName: 'orchestrator', params: {}, result, fact }], facts: [fact], excluded: intent?.excluded || [] };
  }

  if (pendingEffect === 'resolve' || pendingEffect === 'replace') {
    const merged = mergePendingIntentActions(existingPendingIntent, regularActions, {
      keepMissingFields: pendingEffect === 'replace',
    });
    if (!merged.valid) {
      const result = failedResult(merged.errorCode, merged.error, context.language, { requiresClarification: true });
      const fact = createExecutionFact({ toolName: 'orchestrator', params: {}, result, callId: 'pending_intent_merge', language: context.language });
      return { records: [{ toolName: 'orchestrator', params: {}, result, fact }], facts: [fact], excluded: intent?.excluded || [] };
    }

    if (pendingEffect === 'replace') {
      const clarification = clarificationActions[0] || null;
      const question = clarification?.question || existingPendingIntent.question || defaultPendingQuestion(merged.actions, context.language);
      savePendingIntentState(context.user, merged.actions, {
        question,
        missingFields: pendingMissingFields(merged.actions, clarification),
        replace: true,
      });
      actions = clarificationActions.length > 0
        ? [clarificationActions[0]]
        : [{ domain: 'clarification', action: 'request', question }];
    } else {
      const invalid = merged.actions.map((action) => ({ action, prepared: buildDomainCall(action, context) }))
        .find(({ prepared }) => !prepared.valid);
      if (invalid) {
        const result = failedResult(invalid.prepared.errorCode, invalid.prepared.error, context.language, { requiresClarification: true });
        const fact = createExecutionFact({ toolName: 'orchestrator', params: {}, result, callId: 'pending_intent_invalid', language: context.language });
        return { records: [{ toolName: 'orchestrator', params: {}, result, fact }], facts: [fact], excluded: intent?.excluded || [] };
      }
      actions = merged.actions;
    }
  } else if (!existingPendingIntent) {
    const staged = regularActions.filter((action) => {
      if (Array.isArray(action.missingFields) && action.missingFields.length > 0) return true;
      return !buildDomainCall(action, context).valid;
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
      savePendingIntentState(context.user, stagedDrafts, {
        question: clarification.question || '',
        missingFields: pendingMissingFields(stagedDrafts, clarification),
      });
      const stagedSet = new Set(staged);
      actions = actions.filter((action) => !stagedSet.has(action));
      if (clarificationActions.length === 0) actions.push(clarification);
    }
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
    const action = actions[index];
    let toolName = 'orchestrator';
    let params = {};
    let result;

    if (action.domain === 'pending') {
      const pendingOutcome = await executePendingAction(action, context);
      toolName = pendingOutcome.toolName;
      params = pendingOutcome.params;
      result = pendingOutcome.result;
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
          pinnedReminderTargets.has(index)
          && toolName === TOOL_NAMES.MANAGE_REMINDER
          && params.action === 'cancel'
          && !params.scope
        ) {
          params = { ...params, target: pinnedReminderTargets.get(index) };
        }
        result = await executeTool({
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

    const callId = `intent_${index + 1}`;
    const fact = createExecutionFact({ toolName, params, result, callId, language: context.language });
    records.push({ action, toolName, params, result, fact });
    facts.push(fact);

    if ((result.success || result.requiresClarification) && toolName !== 'orchestrator') {
      updateWorkingMemoryFromExecution({ user: context.user, action, toolName, params, result });
    }
  }

  if (pendingEffect === 'resolve' && records.length > 0 && records.every(({ result }) => result.success && !result.requiresClarification)) {
    clearPendingIntentState(context.user);
  }

  return { records, facts, excluded: intent?.excluded || [] };
}

export function inferIntentFromTool(toolName) {
  const intents = {
    [TOOL_NAMES.MANAGE_MEMORY]: 'memory',
    [TOOL_NAMES.MANAGE_REMINDER]: 'reminder',
    [TOOL_NAMES.MANAGE_TASK]: 'task',
    [TOOL_NAMES.MANAGE_ENTITY]: 'entity',
    [TOOL_NAMES.MANAGE_SUBSCRIPTION]: 'subscription',
    [TOOL_NAMES.MANAGE_GOOGLE_CALENDAR]: 'calendar',
    [TOOL_NAMES.GET_UNIFIED_AGENDA]: 'unified_agenda',
    [TOOL_NAMES.ADMIN_METRICS]: 'admin',
  };
  return intents[toolName] || 'chat';
}
