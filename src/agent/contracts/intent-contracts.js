import { TOOL_NAMES } from './tool-names.js';
import { AGENDA_SCOPES } from '../../shared/agenda-scopes.js';

const DOMAINS = Object.freeze([
  'conversation', 'agenda', 'reminder', 'task', 'entity', 'calendar', 'memory', 'subscription', 'pending', 'clarification', 'admin',
]);
const RECURRENCES = Object.freeze(['daily', 'weekdays', 'weekly', 'monthly', 'hourly']);

const DOMAIN_ACTIONS = Object.freeze({
  conversation: new Set(['reply']),
  agenda: new Set(['read']),
  reminder: new Set(['create', 'update', 'cancel', 'acknowledge', 'list', 'add_advance']),
  task: new Set(['create', 'update', 'complete', 'delete', 'list']),
  entity: new Set(['create', 'upsert', 'rename', 'merge', 'delete', 'deduplicate', 'list']),
  calendar: new Set(['create', 'update', 'delete', 'list', 'search', 'next', 'connect', 'disconnect']),
  memory: new Set(['save', 'search', 'list', 'forget']),
  subscription: new Set(['link', 'status', 'cancel']),
  pending: new Set(['execute', 'discard', 'revise']),
  clarification: new Set(['request']),
  admin: new Set(['metrics']),
});

const typedSchedule = {
  type: 'object',
  additionalProperties: false,
  description: 'Structured temporal meaning. Preserve the user’s temporal semantics exactly; Node owns calendar arithmetic and timezone resolution.',
  properties: {
    kind: {
      type: 'string',
      enum: ['relative_offset', 'relative_day_time', 'calendar_date_time', 'weekday_time', 'local_time', 'inherit_context'],
      description: 'Use relative_offset only for durations from now such as “in 30 minutes”. Use relative_day_time for “tomorrow at 10:15”. Use weekday_time for “Friday at 3”. Use local_time for a clock time without another day/date. Never encode a named/relative day plus clock time as relative_offset.',
    },
    offsetMinutes: { type: 'integer', minimum: 1, maximum: 525600, description: 'Only for relative_offset: elapsed minutes from now.' },
    dayOffset: { type: 'integer', minimum: 0, maximum: 365, description: 'For relative_day_time: 0=today, 1=tomorrow, 2=day after tomorrow.' },
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
  type: 'object',
  additionalProperties: false,
  properties: {
    domain: { type: 'string', enum: DOMAINS, description: 'Semantic domain. Choose by current user meaning, never by keyword matching or stale Working Memory.' },
    action: { type: 'string', description: 'Canonical semantic operation for the selected domain. Use only the action vocabulary documented for execute_turn; Node does not translate semantic aliases.' },
    target: { type: 'string', description: 'Human reference to an EXISTING item such as its title, “la segunda”, or “2”. Never an internal ID. Existing-object mutations require target. For pending actions, target selects the pending proposal only and is never reused as domain-object identity. Omit target for create actions.' },
    content: { type: 'string', description: 'For conversation.reply, the concise natural-language reply. For reminder/task create, the new object content. For update, only the requested content delta—not the existing object identity.' },
    title: { type: 'string' },
    description: { type: 'string' },
    entityName: { type: 'string', description: 'Entity/container name. On pending.revise this may express a revised entity identity; target still refers only to the pending proposal.' },
    oldName: { type: 'string' },
    newName: { type: 'string', description: 'New human-facing name/title when renaming an existing reminder, task, calendar event or entity.' },
    sourceName: { type: 'string' },
    category: {
      type: 'string',
      enum: ['person', 'company', 'project', 'place', 'pet', 'asset', 'other', 'fact', 'preference', 'decision', 'episode', 'observation'],
    },
    topicKey: { type: 'string' },
    priority: { type: 'string', enum: ['low', 'medium', 'high', 'urgent'] },
    status: { type: 'string', enum: ['pending', 'in_progress', 'completed', 'cancelled', 'all'] },
    scope: { type: 'string', description: `Semantic collection/time scope. Agenda canonical scopes include: ${AGENDA_SCOPES.join(', ')}.` },
    filter: { type: 'string', enum: ['upcoming', 'pending_today', 'remaining_today', 'created_today', 'completed_today'] },
    query: { type: 'string' },
    projectless: { type: 'boolean' },
    preserveNames: { type: 'array', maxItems: 20, items: { type: 'string' } },
    schedule: typedSchedule,
    endSchedule: typedSchedule,
    advanceMinutes: { type: 'integer', minimum: 1, maximum: 10080 },
    recurrence: {
      type: 'string',
      enum: RECURRENCES,
      description: 'Canonical recurrence semantics for reminders. “todos los días a las 9” => recurrence=daily plus schedule=local_time at 09:00.',
    },
    requiresConfirmation: { type: 'boolean' },
    nudgeIntervalMinutes: { type: 'integer', minimum: 1, maximum: 10080 },
    maxNudges: { type: 'integer', minimum: 1, maximum: 100 },
    durationMinutes: { type: 'integer', minimum: 1, maximum: 10080 },
    addGoogleMeet: { type: 'boolean' },
    limit: { type: 'integer', minimum: 1, maximum: 50 },
    missingFields: {
      type: 'array', uniqueItems: true, maxItems: 2,
      items: { type: 'string', enum: ['main_time', 'advance_minutes'] },
    },
    question: { type: 'string' },
  },
  required: ['domain', 'action'],
};

export const TURN_INTENT_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  properties: {
    actions: { type: 'array', minItems: 1, maxItems: 12, items: actionSchema },
    excluded: {
      type: 'array', maxItems: 12,
      description: 'Only clauses from a mixed turn that should not execute.',
      items: {
        type: 'object', additionalProperties: false,
        properties: {
          quote: { type: 'string' },
          reason: { type: 'string', enum: ['prohibited', 'context_only', 'superseded', 'hypothetical'] },
        },
        required: ['quote', 'reason'],
      },
    },
  },
  required: ['actions'],
});

export const EXECUTE_TURN_DESCRIPTION = `Express the current user's meaning as structured semantic actions. This is the only response protocol for Hermes.
Think about the CURRENT user's goal first. The current explicit message has higher priority than Working Memory, history and persistent memory. Context can resolve references to existing objects, but it must never change the semantic operation explicitly requested now.
Do not produce backend IDs, sequence numbers, manifests, sourceQuote fields, tool names or protocol vocabulary.
For ordinary conversation, emotional support, acknowledgements, conversation closes, or a personal fact already answerable from supplied context/memory, use domain=conversation action=reply and put only the natural user-facing answer in content. conversation.reply must never claim a database read or mutation.
For a general cross-domain question such as “qué tengo hoy”, “qué tenemos pendiente” or “cómo está mi agenda”, use domain=agenda action=read. If no time range is stated for a general pending query, omit scope; Node will use all_pending. If a specific period is stated, set its semantic scope.
If the user explicitly names only reminders, tasks or Google Calendar, use that domain instead of agenda. Live operational state must never be answered with conversation.reply or reconstructed from chat history.
CREATE VS UPDATE IS A HARD SEMANTIC BOUNDARY: use reminder.create when the user introduces a new reminder, even if Working Memory contains an older reminder. A new reminder has content plus its requested schedule/recurrence and NO target. If one message introduces several new reminders, emit one reminder.create action for each requested reminder. Never reinterpret new reminders as edits merely because a previous reminder is in context.
Use reminder.update only when the user refers to an EXISTING reminder and asks to change it. update requires a human target identifying that existing reminder; content/title/schedule/recurrence carry only the requested delta. For a pure rename, put the existing item in target and the new title in newName. For time changes, keep only the temporal delta in schedule.
The same identity rule applies to task and calendar mutations: target identifies the existing object; title/content/schedule/description are patch fields only and can never substitute for a missing target.
When the current context contains an active reminder notification/follow-up and the user says the real-world action is already done or happened (for example “listo”, “ya salí”, “ya lo hice”, “ya está”, “te decía que ya salí”), use domain=reminder action=acknowledge with that reminder as target. Completion is not an update. Use reminder.update only when changing stored reminder fields such as content, time, recurrence or advance notice.
If the user asks to delete, remove, cancel or get rid of an existing reminder, use domain=reminder action=cancel, never update. For a recurring reminder, cancelling the reminder means cancelling its active series unless the user explicitly asks to skip only one occurrence.
For recurring reminders, keep recurrence on the same reminder action. Use recurrence=daily for “todos los días/every day”, weekdays for business days, weekly for weekly routines and monthly for monthly routines. A recurring clock time means the next future occurrence of that routine; Node chooses the correct first date if today's occurrence already passed.
TEMPORAL SEMANTICS ARE ALSO A HARD BOUNDARY: relative_offset is only for elapsed durations from now such as “en 30 minutos”. “mañana a las 10:15” => relative_day_time with dayOffset=1 and the clock fields. “el viernes a las 3” => weekday_time. A date/day plus clock time must never become relative_offset.
A plain durable personal statement is conversation.reply + background learning. Use memory.save only when the user explicitly asks to remember/store something now; use memory.search only when supplied memory context is insufficient.
Use target only for an existing item. For pending.execute/discard/revise, target selects the pending proposal; it must never be reused as the entity/reminder identity inside that proposal. Keep time meaning in schedule; Node resolves dates/timezones. Put an advance notice on the same reminder/event action via advanceMinutes whenever possible.
For mixed messages, excluded contains only the exact clauses that must not execute. Use conversation.reply only for a conversational clause that genuinely needs a user-facing reply; do not duplicate verified operational cards.`;

export function getIntentToolDefinitions({ isAdmin = false } = {}) {
  const parameters = structuredClone(TURN_INTENT_SCHEMA);
  if (!isAdmin) {
    parameters.properties.actions.items.properties.domain.enum = parameters.properties.actions.items.properties.domain.enum
      .filter((domain) => domain !== 'admin');
  }
  return [{
    type: 'function',
    function: {
      name: TOOL_NAMES.EXECUTE_TURN,
      description: EXECUTE_TURN_DESCRIPTION,
      parameters,
    },
  }];
}

export function normalizeIntentAction(_domain, action) {
  return String(action || '').trim().toLowerCase().replace(/[\s-]+/g, '_');
}

function hasTarget(raw) {
  return typeof raw?.target === 'string' && raw.target.trim().length > 0;
}

function mutationRequiresTarget(domain, action, raw) {
  if (domain === 'reminder') {
    if (action === 'cancel' && ['all', 'elapsed'].includes(raw.scope)) return false;
    return ['update', 'cancel', 'acknowledge', 'add_advance'].includes(action);
  }
  if (domain === 'task') return ['update', 'complete', 'delete'].includes(action);
  if (domain === 'calendar') return ['update', 'delete'].includes(action);
  return false;
}

export function validateTurnIntent(intent, { isAdmin = false } = {}) {
  if (!intent || typeof intent !== 'object' || Array.isArray(intent)) {
    return { valid: false, errorCode: 'INVALID_PARAMETERS', error: 'El intent del turno debe ser un objeto.' };
  }
  if (!Array.isArray(intent.actions) || intent.actions.length === 0) {
    return { valid: false, errorCode: 'INVALID_PARAMETERS', error: 'El turno requiere al menos una acción.' };
  }
  if (intent.actions.length > 12) {
    return { valid: false, errorCode: 'TURN_ACTION_LIMIT', error: 'El turno supera el límite de 12 acciones.' };
  }

  const normalizedActions = [];
  for (const raw of intent.actions) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      return { valid: false, errorCode: 'INVALID_PARAMETERS', error: 'Cada acción debe ser un objeto.' };
    }
    const domain = String(raw.domain || '').trim().toLowerCase();
    if (!DOMAINS.includes(domain) || (!isAdmin && domain === 'admin')) {
      return { valid: false, errorCode: 'UNSUPPORTED_DOMAIN', error: `Dominio no disponible: ${raw.domain || '(vacío)'}.` };
    }
    const action = normalizeIntentAction(domain, raw.action);
    if (!DOMAIN_ACTIONS[domain]?.has(action)) {
      return { valid: false, errorCode: 'UNSUPPORTED_ACTION', error: `Capacidad no soportada: ${domain}.${raw.action}.` };
    }
    if (domain === 'conversation' && action === 'reply' && !(typeof raw.content === 'string' && raw.content.trim())) {
      return { valid: false, errorCode: 'MISSING_CONTENT', error: 'conversation.reply requiere contenido de respuesta.' };
    }
    if (mutationRequiresTarget(domain, action, raw) && !hasTarget(raw)) {
      return { valid: false, errorCode: 'MISSING_TARGET', error: `${domain}.${action} requiere una referencia explícita al objeto existente.` };
    }
    if (raw.recurrence !== undefined && !RECURRENCES.includes(raw.recurrence)) {
      return { valid: false, errorCode: 'INVALID_RECURRENCE', error: `Recurrencia no soportada: ${raw.recurrence}.` };
    }
    normalizedActions.push({ ...raw, domain, action });
  }

  const excluded = Array.isArray(intent.excluded)
    ? intent.excluded.filter((item) => item && typeof item.quote === 'string' && item.quote.trim())
    : [];

  return { valid: true, intent: { actions: normalizedActions, excluded } };
}

export function parseIntentArguments(rawArguments) {
  if (rawArguments && typeof rawArguments === 'object') return rawArguments;
  if (typeof rawArguments !== 'string' || !rawArguments.trim()) return {};
  try {
    const parsed = JSON.parse(rawArguments);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}
