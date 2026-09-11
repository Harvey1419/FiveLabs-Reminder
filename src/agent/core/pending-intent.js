export const PENDING_INTENT_TTL_MS = 15 * 60 * 1000;

const ACTION_FIELDS = Object.freeze([
  'domain', 'action', 'target', 'content', 'title', 'description', 'entityName', 'oldName', 'newName',
  'sourceName', 'category', 'topicKey', 'priority', 'status', 'scope', 'filter', 'query', 'projectless',
  'preserveNames', 'schedule', 'endSchedule', 'advanceMinutes', 'recurrence', 'requiresConfirmation',
  'nudgeIntervalMinutes', 'maxNudges', 'durationMinutes', 'addGoogleMeet', 'limit', 'missingFields',
]);

function cloneJson(value) {
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return null;
  }
}

export function sanitizePendingAction(action) {
  if (!action || typeof action !== 'object' || Array.isArray(action)) return null;
  const sanitized = {};
  for (const field of ACTION_FIELDS) {
    if (action[field] !== undefined && action[field] !== null) sanitized[field] = cloneJson(action[field]);
  }
  if (!sanitized.domain || !sanitized.action) return null;
  return sanitized;
}

export function createPendingIntent({ actions = [], missingFields = [], question = '', now = Date.now() } = {}) {
  const safeActions = actions.map(sanitizePendingAction).filter(Boolean).slice(0, 12);
  if (safeActions.length === 0) return null;
  return {
    version: 1,
    actions: safeActions,
    missingFields: [...new Set((missingFields || []).map((field) => String(field).trim()).filter(Boolean))].slice(0, 12),
    question: String(question || '').trim(),
    createdAt: new Date(now).toISOString(),
    updatedAt: new Date(now).toISOString(),
  };
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

function mergeAction(base, delta, { keepMissingFields = false } = {}) {
  const merged = {
    ...cloneJson(base),
    ...cloneJson(delta),
    domain: base.domain,
    action: base.action,
  };
  if (base.schedule || delta.schedule) merged.schedule = mergePendingSchedule(base.schedule, delta.schedule);
  if (base.endSchedule || delta.endSchedule) merged.endSchedule = mergePendingSchedule(base.endSchedule, delta.endSchedule);
  delete merged.continuationIndex;
  delete merged.question;
  if (!keepMissingFields) delete merged.missingFields;
  return merged;
}

/**
 * Merge model-supplied structured deltas into one coherent pending intent.
 * Mapping is explicit by continuationIndex; Node never matches natural text.
 */
export function mergePendingIntentActions(pendingIntent, continuationActions, options = {}) {
  const pendingActions = Array.isArray(pendingIntent?.actions) ? pendingIntent.actions : [];
  const deltas = Array.isArray(continuationActions) ? continuationActions : [];
  if (pendingActions.length === 0 || deltas.length === 0) {
    return { valid: false, errorCode: 'INVALID_PENDING_CONTINUATION', error: 'La continuación no contiene acciones pendientes utilizables.' };
  }

  const mergedByPosition = new Map();
  for (const delta of deltas) {
    const position = Number.isInteger(delta?.continuationIndex)
      ? delta.continuationIndex
      : (pendingActions.length === 1 ? 1 : null);
    if (!position || position < 1 || position > pendingActions.length) {
      return { valid: false, errorCode: 'AMBIGUOUS_PENDING_CONTINUATION', error: 'Falta vincular la continuación con una acción pendiente concreta.' };
    }
    const base = pendingActions[position - 1];
    if (delta.domain !== base.domain || delta.action !== base.action) {
      return { valid: false, errorCode: 'INVALID_PENDING_CONTINUATION', error: 'La continuación cambió la operación pendiente.' };
    }
    const merged = mergeAction(base, delta, options);
    const existing = mergedByPosition.get(position) || [];
    existing.push(merged);
    mergedByPosition.set(position, existing);
  }

  if (!options.keepMissingFields && mergedByPosition.size !== pendingActions.length) {
    return { valid: false, errorCode: 'INCOMPLETE_PENDING_CONTINUATION', error: 'La continuación no completó todas las acciones de la intención pendiente.' };
  }

  const actions = pendingActions.flatMap((base, index) => (
    mergedByPosition.get(index + 1)
    || (options.keepMissingFields ? [cloneJson(base)] : [])
  ));
  return { valid: true, actions };
}

export function formatPendingIntentForPrompt(pendingIntent) {
  if (!pendingIntent?.actions?.length) return '';
  const compact = {
    status: 'NOT_EXECUTED',
    actions: pendingIntent.actions.map((action, index) => ({ position: index + 1, ...action })),
    missingFields: pendingIntent.missingFields || [],
    question: pendingIntent.question || null,
  };
  return JSON.stringify(compact);
}
