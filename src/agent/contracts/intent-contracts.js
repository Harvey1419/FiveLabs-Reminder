import { TOOL_NAMES } from './tool-names.js';
import { AGENDA_SCOPES } from '../../shared/agenda-scopes.js';

const DOMAINS = Object.freeze([
  'agenda', 'reminder', 'task', 'entity', 'calendar', 'memory', 'subscription', 'pending', 'clarification', 'admin',
]);

const DOMAIN_ACTIONS = Object.freeze({
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

const ACTION_ALIASES = Object.freeze({
  agenda: Object.freeze({ get: 'read', show: 'read', list: 'read', view: 'read', pending: 'read' }),
  reminder: Object.freeze({
    add: 'create', set: 'create', get: 'list', read: 'list', show: 'list', search: 'list',
    remove: 'cancel', delete: 'cancel', dismiss: 'acknowledge', done: 'acknowledge', complete: 'acknowledge',
  }),
  task: Object.freeze({
    add: 'create', get: 'list', read: 'list', show: 'list', search: 'list', done: 'complete', finish: 'complete',
    remove: 'delete', cancel: 'delete',
  }),
  entity: Object.freeze({ get: 'list', read: 'list', show: 'list', remove: 'delete' }),
  calendar: Object.freeze({
    add: 'create', get: 'list', read: 'list', show: 'list', find: 'search', remove: 'delete',
  }),
  memory: Object.freeze({
    read: 'search', get: 'search', recall: 'search', retrieve: 'search', remember: 'search', find: 'search',
    show: 'list', all: 'list',
    add: 'save', create: 'save', store: 'save', learn: 'save', set: 'save', write: 'save',
    remember_fact: 'save', memorize: 'save', persist: 'save',
    remove: 'forget', delete: 'forget', erase: 'forget',
  }),
  subscription: Object.freeze({ get: 'status', read: 'status', checkout: 'link', remove: 'cancel' }),
  pending: Object.freeze({ accept: 'execute', confirm: 'execute', reject: 'discard', cancel: 'discard', modify: 'revise', update: 'revise' }),
  clarification: Object.freeze({ ask: 'request' }),
  admin: Object.freeze({ read: 'metrics', get: 'metrics' }),
});

const typedSchedule = {
  type: 'object',
  additionalProperties: false,
  description: 'Structured temporal meaning. Node owns all calendar and timezone arithmetic.',
  properties: {
    kind: { type: 'string', enum: ['relative_offset', 'relative_day_time', 'calendar_date_time', 'weekday_time', 'local_time', 'inherit_context'] },
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
  type: 'object',
  additionalProperties: false,
  properties: {
    domain: { type: 'string', enum: DOMAINS, description: 'Semantic domain. Choose by user meaning, never by keyword matching.' },
    action: { type: 'string', description: 'Plain semantic operation. Natural synonyms are normalized by Node.' },
    target: { type: 'string', description: 'Human reference to an existing item such as its title, “la segunda”, or “2”. Never an internal ID.' },
    content: { type: 'string' },
    title: { type: 'string' },
    description: { type: 'string' },
    entityName: { type: 'string' },
    oldName: { type: 'string' },
    newName: { type: 'string' },
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
    recurrence: { type: 'string' },
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

export const EXECUTE_TURN_DESCRIPTION = `Express only the current user's actionable delta as semantic actions.
Think about the user's goal first. Do not produce backend IDs, sequence numbers, manifests, sourceQuote fields, tool names or protocol vocabulary.
For a general cross-domain question such as “qué tengo hoy”, “qué tenemos pendiente” or “cómo está mi agenda”, use domain=agenda action=read. If no time range is stated for a general pending query, omit scope; Node will use all_pending. If a specific period is stated, set its semantic scope.
If the user explicitly names only reminders, tasks or Google Calendar, use that domain instead of agenda.
A personal fact already present in supplied memories/profile is answered directly in prose, not with a memory action. A plain durable personal statement is also prose + background learning. Use memory.save only when the user explicitly asks to remember/store something now; use memory.search only when supplied memory context is insufficient.
Use target only for an existing item. Keep time meaning in schedule; Node resolves dates/timezones. Put an advance notice on the same reminder/event action via advanceMinutes whenever possible.
For mixed messages, excluded contains only the exact clauses that must not execute. Do not call this tool for ordinary conversation, emotional support, acknowledgements or conversation closes.`;

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

export function normalizeIntentAction(domain, action) {
  const normalizedDomain = String(domain || '').trim().toLowerCase();
  const normalizedAction = String(action || '').trim().toLowerCase().replace(/[\s-]+/g, '_');
  if (!normalizedAction) return '';
  if (DOMAIN_ACTIONS[normalizedDomain]?.has(normalizedAction)) return normalizedAction;
  return ACTION_ALIASES[normalizedDomain]?.[normalizedAction] || normalizedAction;
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
