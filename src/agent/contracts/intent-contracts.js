import { TOOL_NAMES } from './tool-names.js';
import { AGENDA_SCOPES } from '../../shared/agenda-scopes.js';

const DOMAINS = Object.freeze([
  'conversation', 'agenda', 'reminder', 'task', 'project', 'entity', 'calendar', 'memory', 'subscription', 'clarification', 'admin',
]);
const RECURRENCES = Object.freeze(['daily', 'weekdays', 'weekly', 'monthly', 'hourly']);
const MISSING_FIELDS = Object.freeze([
  'content', 'target', 'selection', 'scope', 'schedule', 'date', 'time', 'main_time', 'advance_minutes',
]);

const DOMAIN_ACTIONS = Object.freeze({
  conversation: new Set(['reply']),
  agenda: new Set(['read']),
  reminder: new Set(['create', 'update', 'cancel', 'acknowledge', 'list', 'add_advance']),
  task: new Set(['create', 'update', 'complete', 'delete', 'list']),
  project: new Set(['create', 'upsert', 'rename', 'delete', 'list']),
  entity: new Set(['create', 'upsert', 'rename', 'merge', 'delete', 'deduplicate', 'list']),
  calendar: new Set(['create', 'update', 'delete', 'list', 'search', 'next', 'connect', 'disconnect']),
  memory: new Set(['save', 'search', 'list', 'forget']),
  subscription: new Set(['link', 'status', 'cancel']),
  clarification: new Set(['request']),
  admin: new Set(['metrics']),
});

const STRUCTURAL_ACTION_ALIASES = Object.freeze({
  reminder: Object.freeze({ delete: 'cancel' }),
});

function qualifyOperation(domain, action) { return `${domain}.${action}`; }

const CANONICAL_OPERATIONS = Object.freeze(Object.entries(DOMAIN_ACTIONS)
  .flatMap(([domain, actions]) => [...actions].map((action) => qualifyOperation(domain, action))));
const CANONICAL_OPERATION_PARTS = new Map(CANONICAL_OPERATIONS.map((operation) => {
  const separator = operation.indexOf('.');
  return [operation, Object.freeze({ domain: operation.slice(0, separator), action: operation.slice(separator + 1) })];
}));
export const typedSchedule = {
  type: 'object',
  additionalProperties: false,
  description: 'Structured temporal meaning. Preserve the user’s temporal semantics exactly; Node owns calendar arithmetic and timezone resolution.',
  properties: {
    kind: {
      type: 'string',
      enum: ['relative_offset', 'relative_day_time', 'calendar_date_time', 'weekday_time', 'local_time', 'inherit_context'],
      description: 'relative_offset=duration from now; relative_day_time=relative day plus clock; weekday_time=named weekday plus clock; local_time=clock-only delta with no date scope, mainly for merging into a typed pending intent. Never use local_time for a coordinated create action covered by a shared date; repeat that date with its date-bearing kind.',
    },
    offsetMinutes: { type: 'integer', minimum: 1, maximum: 525600 },
    dayOffset: { type: 'integer', minimum: 0, maximum: 365 },
    year: { type: 'integer', minimum: 2020, maximum: 2200 },
    month: { type: 'integer', minimum: 1, maximum: 12 },
    day: { type: 'integer', minimum: 1, maximum: 31 },
    weekday: { type: 'string', enum: ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'] },
    weekOffset: { type: 'integer', minimum: 0, maximum: 52 },
    hour: { type: 'integer', minimum: 0, maximum: 23 },
    minute: { type: 'integer', minimum: 0, maximum: 59 },
    clockMode: { type: 'string', enum: ['explicit_24h', 'explicit_am', 'explicit_pm', 'ambiguous_12h'] },
  },
  required: ['kind'],
};

const actionSchema = {
  type: 'object', additionalProperties: false,
  properties: {
    domain: { type: 'string', enum: DOMAINS },
    action: { type: 'string' },
    target: { type: 'string', description: 'Human reference to an EXISTING item, never an internal ID. Required by existing-object mutations except reminder.acknowledge when Node can bind one authoritative active follow-up. For entity.delete, the project or list name to delete (deleting a project automatically deletes all its tasks in cascade; never use scope="all" for one project).' },
    content: { type: 'string', description: 'Natural reply, create content, or requested update delta; never existing-object identity.' },
    title: { type: 'string', description: 'One actionable task/event title, not the name of its containing project.' }, description: { type: 'string' },
    entityName: { type: 'string', description: 'Entity name. For entity.create/upsert, its own name. For task actions, the explicit or implicit shared purpose/container repeated on every compound member. For task.complete/update/delete, include the owning container whenever the target belongs to a named project, so duplicate titles cannot cross containers.' }, oldName: { type: 'string' }, newName: { type: 'string' }, sourceName: { type: 'string' },
    category: { type: 'string', enum: ['person', 'company', 'project', 'place', 'pet', 'asset', 'other', 'fact', 'preference', 'decision', 'episode', 'observation'], description: 'Use project for an operational container whose members are tasks. A collection of people, companies or other knowledge remains entities according to what its members mean.' },
    topicKey: { type: 'string' }, priority: { type: 'string', enum: ['low', 'medium', 'high', 'urgent'] },
    status: { type: 'string', enum: ['pending', 'in_progress', 'completed', 'cancelled', 'all'] },
    scope: { type: 'string', description: `For entity.delete: "all" deletes EVERY project/entity across the user account (use ONLY when the user explicitly requests deleting all projects/lists). For single projects, leave scope null/omitted. Agenda scopes include: ${AGENDA_SCOPES.join(', ')}.` },
    filter: { type: 'string', enum: ['upcoming', 'pending_today', 'remaining_today', 'created_today', 'completed_today'] },
    query: { type: 'string' }, projectless: { type: 'boolean', description: 'For task.create, true only when there is no named grouping or shared purpose. Never true for actionable items grouped under an implicit or explicit purpose/container, even if the user never says list or project; provide entityName instead.' },
    preserveNames: { type: 'array', maxItems: 20, items: { type: 'string' } },
    schedule: typedSchedule, endSchedule: typedSchedule,
    advanceMinutes: { type: 'integer', minimum: 1, maximum: 10080 },
    recurrence: { type: 'string', enum: RECURRENCES },
    requiresConfirmation: { type: 'boolean' },
    nudgeIntervalMinutes: { type: 'integer', minimum: 1, maximum: 10080 }, maxNudges: { type: 'integer', minimum: 1, maximum: 100 },
    durationMinutes: { type: 'integer', minimum: 1, maximum: 10080 }, addGoogleMeet: { type: 'boolean' }, limit: { type: 'integer', minimum: 1, maximum: 50 },
    missingFields: { type: 'array', uniqueItems: true, maxItems: 8, items: { type: 'string', enum: MISSING_FIELDS } },
    question: { type: 'string' },
  },
  required: ['domain', 'action'],
};

export const TURN_INTENT_SCHEMA = Object.freeze({
  type: 'object', additionalProperties: false,
  properties: {
    actions: { type: 'array', minItems: 1, maxItems: 12, items: actionSchema },
    excluded: { type: 'array', maxItems: 12, items: { type: 'object', additionalProperties: false, properties: { quote: { type: 'string' }, reason: { type: 'string', enum: ['prohibited', 'context_only', 'superseded', 'hypothetical'] } }, required: ['quote', 'reason'] } },
  },
  required: ['actions'],
});

export const EXECUTE_TURN_DESCRIPTION = `Hermes decide significado. Node es la autoridad final sobre identidad, ownership, permisos, estado real, fechas/timezone, confirmaciones y resultados. Toda salida es un TurnIntent JSON conforme al schema estricto (TurnIntent is mandatory for every turn). El significado explícito actual domina todo contexto. Contexto previo resuelve referencias humanas, nunca cambia la operación. No expongas IDs internos.
conversation.reply es no operativo y no afirma lecturas ni mutaciones. agenda.read es inventario vivo multi-dominio; para recordatorios usa reminder.list. Nunca reconstruyas estado operativo desde el historial (Never reconstruct live state from chat history).
LÍMITE ESTRICTO ENTRE CREACIÓN Y EDICIÓN (CREATE VS UPDATE IS A HARD SEMANTIC BOUNDARY): crear no lleva target; actualizar/cancelar/completar/eliminar requieren target humano existente y solo los deltas pedidos. Un valor a cambiar nunca es identidad.
Eliminar recordatorios es reminder.cancel (uno por objetivo). reminder.acknowledge confirma un seguimiento real completado (Completion is not an update); Node vincula el objetivo autoritativo si es único.
COLECCIONES Y PROYECTOS: listas o proyectos con tareas usan project (o entity con category="project") + task.create por elemento. Listar usa project.list (o entity.list con category="project"); NUNCA sin categoría. Eliminar usa project.delete(target="Nombre"); scope="all" solo para borrar toda la cuenta.
CALENDARIO: Consultas de calendario/eventos ('dame mi calendario') usan calendar.list (o calendar.next/search); citas usan calendar.create; vincular/desvincular usa calendar.connect/disconnect. Node gestiona Google Calendar; NUNCA niegues acceso ni pidas conectar en conversation.reply.
PREGUNTAS DE VERIFICACIÓN: Preguntas JAMÁS autorizan mutaciones. Consultas de estado (ej. '¿los eliminaste?') se responden en conversation.reply o lectura viva (project.list, task.list), NUNCA con mutaciones.
Significado temporal tipado (Temporal meaning must remain typed): relative_offset=duración; relative_day_time=día relativo+hora; weekday_time=día semana+hora; local_time=solo hora. Node gestiona aritmética de fechas/zonas horarias.
Para datos faltantes, conserva acciones parciales con missingFields y una sola clarification.request.
Mantén recurrencia y advanceMinutes en su recordatorio/evento. Afirmaciones personales duraderas usan conversation.reply más aprendizaje pasivo; memory.save solo ante petición explícita.
Para mensajes mixtos emite acciones válidas, cláusulas no ejecutables en excluded, y no dupliques cards verificadas en conversation.reply.`;

export function getIntentToolDefinitions({ isAdmin = false } = {}) {
  const parameters = structuredClone(TURN_INTENT_SCHEMA);
  if (!isAdmin) parameters.properties.actions.items.properties.domain.enum = parameters.properties.actions.items.properties.domain.enum.filter((domain) => domain !== 'admin');
  return [{ type: 'function', function: { name: TOOL_NAMES.EXECUTE_TURN, description: EXECUTE_TURN_DESCRIPTION, parameters } }];
}

export function getConversationToolDefinition() {
  return {
    type: 'function',
    function: {
      name: TOOL_NAMES.REPLY_TO_USER,
      description: 'Reply naturally when the current turn requires no operational read or mutation. Never claim that a task, reminder, calendar, memory, subscription, pending proposal, or agenda operation was executed.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: { content: { type: 'string', minLength: 1 } },
        required: ['content'],
      },
    },
  };
}

export function getForegroundToolDefinitions({ isAdmin = false } = {}) {
  return [...getIntentToolDefinitions({ isAdmin }), getConversationToolDefinition()];
}

export function getIntentActionsForDomain(domain) { return [...(DOMAIN_ACTIONS[domain] || [])]; }

export function getCanonicalOperations({ domains = DOMAINS } = {}) {
  const allowedDomains = new Set(domains);
  return CANONICAL_OPERATIONS.filter((operation) => allowedDomains.has(CANONICAL_OPERATION_PARTS.get(operation).domain));
}

export function parseCanonicalOperation(operation) {
  const parsed = CANONICAL_OPERATION_PARTS.get(String(operation || '').trim().toLowerCase());
  return parsed ? { ...parsed } : null;
}

export function normalizeIntentAction(domain, action) {
  const normalized = String(action || '').trim().toLowerCase().replace(/[\s-]+/g, '_');
  // Structural wire aliases are accepted only when their canonical meaning is
  // exact. This never interprets the user's natural language.
  return STRUCTURAL_ACTION_ALIASES[domain]?.[normalized] || normalized;
}
function hasTarget(raw) { return typeof raw?.target === 'string' && raw.target.trim().length > 0; }
function hasEntityIdentity(raw) {
  return [raw?.target, raw?.entityName, raw?.title, raw?.content]
    .some((value) => typeof value === 'string' && value.trim().length > 0);
}

/**
 * Complete a single project-container action from the one exact structured
 * entityName already repeated by all of its task.create members. This links
 * fields that Hermes already interpreted; it never inspects user prose.
 */
function linkOperationalCollectionContainer(actions) {
  const copies = actions.map((action) => (
    action && typeof action === 'object' && !Array.isArray(action) ? { ...action } : action
  ));
  const unnamedProjectContainers = copies
    .map((action, index) => ({ action, index }))
    .filter(({ action }) => (
      action
      && String(action.domain || '').trim().toLowerCase() === 'entity'
      && ['create', 'upsert'].includes(normalizeIntentAction('entity', action.action))
      && action.category === 'project'
      && !hasEntityIdentity(action)
    ));
  if (unnamedProjectContainers.length !== 1) return copies;

  const memberNames = [...new Set(copies
    .filter((action) => (
      action
      && String(action.domain || '').trim().toLowerCase() === 'task'
      && normalizeIntentAction('task', action.action) === 'create'
      && action.projectless !== true
      && (!action.category || action.category === 'project')
      && typeof action.entityName === 'string'
      && action.entityName.trim()
    ))
    .map((action) => action.entityName.trim()))];
  if (memberNames.length !== 1) return copies;

  const [{ index }] = unnamedProjectContainers;
  copies[index] = { ...copies[index], entityName: memberNames[0] };
  return copies;
}
function getEffectiveScheduleKind(schedule) {
  if (schedule?.kind === 'calendar_date_time' && Number.isInteger(schedule.dayOffset) && (!Number.isInteger(schedule.month) || !Number.isInteger(schedule.day))) {
    return 'relative_day_time';
  }
  return schedule?.kind;
}
function hasCompleteReminderSchedule(schedule) {
  if (!schedule || typeof schedule !== 'object' || Array.isArray(schedule)) return false;
  const kind = getEffectiveScheduleKind(schedule);
  if (kind === 'relative_offset') return Number.isInteger(schedule.offsetMinutes);
  if (kind === 'relative_day_time') return Number.isInteger(schedule.dayOffset) && Number.isInteger(schedule.hour);
  if (kind === 'calendar_date_time') return Number.isInteger(schedule.month) && Number.isInteger(schedule.day) && Number.isInteger(schedule.hour);
  if (kind === 'weekday_time') return typeof schedule.weekday === 'string' && Number.isInteger(schedule.hour);
  if (kind === 'local_time') return Number.isInteger(schedule.hour);
  return false;
}
function inferPartialReminderScheduleFields(schedule) {
  if (!schedule || typeof schedule !== 'object' || Array.isArray(schedule)) return [];
  const kind = getEffectiveScheduleKind(schedule);
  const hasClock = Number.isInteger(schedule.hour);
  let hasDate = false;
  if (kind === 'relative_day_time') hasDate = Number.isInteger(schedule.dayOffset);
  if (kind === 'calendar_date_time') hasDate = Number.isInteger(schedule.month) && Number.isInteger(schedule.day);
  if (kind === 'weekday_time') hasDate = typeof schedule.weekday === 'string';
  if (kind === 'local_time') {
    return hasClock ? ['date'] : [];
  }
  if (!['relative_day_time', 'calendar_date_time', 'weekday_time'].includes(kind)) return [];
  if (!hasDate && !hasClock) return [];
  return [
    ...(!hasDate ? ['date'] : []),
    ...(!hasClock ? ['time'] : []),
  ];
}
function mutationRequiresTarget(domain, action, raw) {
  if (domain === 'reminder') { if (action === 'cancel' && ['all', 'elapsed'].includes(raw.scope)) return false; return ['update', 'cancel', 'add_advance'].includes(action); }
  if (domain === 'task') return ['update', 'complete', 'delete'].includes(action);
  if (domain === 'calendar') return ['update', 'delete'].includes(action);
  return false;
}

function scheduleBearingMutation(domain, action, field = 'schedule') {
  if (field === 'endSchedule') return domain === 'calendar' && ['create', 'update'].includes(action);
  return (
    (domain === 'reminder' && ['create', 'update'].includes(action))
    || (domain === 'task' && ['create', 'update'].includes(action))
    || (domain === 'calendar' && ['create', 'update'].includes(action))
  );
}

export function validateTurnIntent(intent, { isAdmin = false } = {}) {
  if (!intent || typeof intent !== 'object' || Array.isArray(intent)) return { valid: false, errorCode: 'INVALID_PARAMETERS', error: 'El intent del turno debe ser un objeto.' };
  if (intent.pendingIntentEffect !== undefined) {
    return { valid: false, errorCode: 'INVALID_PARAMETERS', error: 'pendingIntentEffect ha sido deprecado y no es soportado.' };
  }
  if (!Array.isArray(intent.actions) || intent.actions.length === 0) return { valid: false, errorCode: 'INVALID_PARAMETERS', error: 'El turno requiere al menos una acción.' };
  if (intent.actions.length > 12) return { valid: false, errorCode: 'TURN_ACTION_LIMIT', error: 'El turno supera el límite de 12 acciones.' };
  const normalizedActions = [];
  const structurallyLinkedActions = linkOperationalCollectionContainer(intent.actions);
  for (const raw of structurallyLinkedActions) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { valid: false, errorCode: 'INVALID_PARAMETERS', error: 'Cada acción debe ser un objeto.' };
    const domain = String(raw.domain || '').trim().toLowerCase();
    if (!DOMAINS.includes(domain) || (!isAdmin && domain === 'admin')) return { valid: false, errorCode: 'UNSUPPORTED_DOMAIN', error: `Dominio no disponible: ${raw.domain || '(vacío)'}.` };
    const action = normalizeIntentAction(domain, raw.action);
    if (!DOMAIN_ACTIONS[domain]?.has(action)) return { valid: false, errorCode: 'UNSUPPORTED_ACTION', error: `Capacidad no soportada: ${domain}.${raw.action}.` };
    if (domain === 'conversation' && action === 'reply' && !(typeof raw.content === 'string' && raw.content.trim())) return { valid: false, errorCode: 'MISSING_CONTENT', error: 'conversation.reply requiere contenido de respuesta.' };
    const structurallyMissingScheduleFields = domain === 'reminder'
      && action === 'create'
      ? inferPartialReminderScheduleFields(raw.schedule)
      : [];
    const declaredMissingFields = Array.isArray(raw.missingFields) ? raw.missingFields : [];
    if (structurallyMissingScheduleFields.length > 0
      && declaredMissingFields.length > 0
      && !structurallyMissingScheduleFields.every((field) => declaredMissingFields.includes(field))) {
      return { valid: false, errorCode: 'MISSING_SCHEDULE', error: 'missingFields no representa los componentes temporales ausentes.' };
    }
    const normalizedRaw = structurallyMissingScheduleFields.length > 0 && declaredMissingFields.length === 0
      ? { ...raw, missingFields: structurallyMissingScheduleFields }
      : raw;
    const declaredPendingFields = Array.isArray(normalizedRaw.missingFields) && normalizedRaw.missingFields.length > 0;
    const mayRemainPending = declaredPendingFields;

    // Every schedule-bearing mutation crosses the same canonical boundary.
    // A partial schedule is valid only when Hermes explicitly represents the
    // missing component as a pending clarification; otherwise it must be
    // rejected before any executor can perform temporal arithmetic.
    for (const scheduleField of ['schedule', 'endSchedule']) {
      const schedule = normalizedRaw[scheduleField];
      if (!schedule || !scheduleBearingMutation(domain, action, scheduleField)) continue;
      const knownKind = typeof schedule === 'object'
        && !Array.isArray(schedule)
        && typedSchedule.properties.kind.enum.includes(schedule.kind)
        && schedule.kind !== 'inherit_context';
      if (!knownKind) return { valid: false, errorCode: 'MISSING_SCHEDULE', error: 'La estructura temporal no es utilizable.' };
      if (!hasCompleteReminderSchedule(schedule) && !mayRemainPending) {
        return { valid: false, errorCode: 'MISSING_SCHEDULE', error: 'La estructura temporal está incompleta.' };
      }
    }
    if (mutationRequiresTarget(domain, action, normalizedRaw) && !hasTarget(normalizedRaw) && !mayRemainPending) return { valid: false, errorCode: 'MISSING_TARGET', error: `${domain}.${action} requiere una referencia explícita al objeto existente.` };
    if (domain === 'entity'
      && ['create', 'upsert'].includes(action)
      && !hasEntityIdentity(normalizedRaw)
      && !mayRemainPending) {
      return { valid: false, errorCode: 'MISSING_TARGET', error: `entity.${action} requiere el nombre de la entidad.` };
    }
    if (domain === 'task' && action === 'create') {
      const hasTitle = [normalizedRaw.title, normalizedRaw.content]
        .some((value) => typeof value === 'string' && value.trim().length > 0);
      if (!hasTitle && !mayRemainPending) {
        return { valid: false, errorCode: 'MISSING_TITLE', error: 'task.create requiere el título de la tarea.' };
      }
      const hasProject = typeof normalizedRaw.entityName === 'string' && normalizedRaw.entityName.trim().length > 0;
      if (hasProject && normalizedRaw.projectless === true) {
        return { valid: false, errorCode: 'INVALID_PARAMETERS', error: 'task.create no puede ser projectless y pertenecer a una entidad al mismo tiempo.' };
      }
      if (!hasProject && normalizedRaw.projectless !== true && !mayRemainPending) {
        return { valid: false, errorCode: 'MISSING_TARGET', error: 'task.create debe declarar entityName o projectless=true.' };
      }
      if (normalizedRaw.schedule
        && !hasCompleteReminderSchedule(normalizedRaw.schedule)
        && !mayRemainPending) {
        return { valid: false, errorCode: 'MISSING_SCHEDULE', error: 'task.create incluyó una estructura temporal incompleta.' };
      }
    }
    if (normalizedRaw.recurrence !== undefined && !RECURRENCES.includes(normalizedRaw.recurrence)) return { valid: false, errorCode: 'INVALID_RECURRENCE', error: `Recurrencia no soportada: ${normalizedRaw.recurrence}.` };
    // Groq's provider-facing schema cannot enforce this canonical constraint.
    if (Array.isArray(normalizedRaw.missingFields)
      && actionSchema.properties.missingFields.uniqueItems
      && new Set(normalizedRaw.missingFields).size !== normalizedRaw.missingFields.length) {
      return { valid: false, errorCode: 'INVALID_PARAMETERS', error: 'missingFields no admite valores duplicados.' };
    }
    if (domain === 'reminder' && action === 'create') {
      if (!(typeof normalizedRaw.content === 'string' && normalizedRaw.content.trim())
        && !(typeof normalizedRaw.title === 'string' && normalizedRaw.title.trim())
        && !mayRemainPending) {
        return { valid: false, errorCode: 'MISSING_CONTENT', error: 'La decisión de creación no incluyó contenido.' };
      }
      const knownScheduleKind = normalizedRaw.schedule
        && typeof normalizedRaw.schedule === 'object'
        && !Array.isArray(normalizedRaw.schedule)
        && typedSchedule.properties.kind.enum.includes(normalizedRaw.schedule.kind)
        && normalizedRaw.schedule.kind !== 'inherit_context';
      if (normalizedRaw.schedule && !knownScheduleKind) {
        return { valid: false, errorCode: 'MISSING_SCHEDULE', error: 'La decisión de creación no incluyó una estructura temporal utilizable.' };
      }
      if (!hasCompleteReminderSchedule(normalizedRaw.schedule) && !mayRemainPending) {
        return { valid: false, errorCode: 'MISSING_SCHEDULE', error: 'La decisión de creación no incluyó una estructura temporal utilizable.' };
      }
    }
    normalizedActions.push({ ...normalizedRaw, domain, action });
  }
  const excluded = Array.isArray(intent.excluded) ? intent.excluded.filter((item) => item && typeof item.quote === 'string' && item.quote.trim()) : [];
  return {
    valid: true,
    intent: {
      actions: normalizedActions,
      excluded,
    },
  };
}

export function parseIntentArguments(rawArguments) {
  if (rawArguments && typeof rawArguments === 'object') return rawArguments;
  if (typeof rawArguments !== 'string' || !rawArguments.trim()) return {};
  try { const parsed = JSON.parse(rawArguments); return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null; } catch { return null; }
}
