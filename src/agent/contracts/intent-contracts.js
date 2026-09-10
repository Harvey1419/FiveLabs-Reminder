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
      description: 'relative_offset=duration from now; relative_day_time=relative day plus clock; weekday_time=named weekday plus clock; local_time=clock only.',
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
    target: { type: 'string', description: 'Human reference to an EXISTING item, never an internal ID. Required by existing-object mutations except reminder.acknowledge when Node can bind one authoritative active follow-up. For pending actions it selects only the pending proposal.' },
    content: { type: 'string', description: 'Natural reply, create content, or requested update delta; never existing-object identity.' },
    title: { type: 'string' }, description: { type: 'string' },
    entityName: { type: 'string' }, oldName: { type: 'string' }, newName: { type: 'string' }, sourceName: { type: 'string' },
    category: { type: 'string', enum: ['person', 'company', 'project', 'place', 'pet', 'asset', 'other', 'fact', 'preference', 'decision', 'episode', 'observation'] },
    topicKey: { type: 'string' }, priority: { type: 'string', enum: ['low', 'medium', 'high', 'urgent'] },
    status: { type: 'string', enum: ['pending', 'in_progress', 'completed', 'cancelled', 'all'] },
    scope: { type: 'string', description: `Agenda scopes include: ${AGENDA_SCOPES.join(', ')}.` },
    filter: { type: 'string', enum: ['upcoming', 'pending_today', 'remaining_today', 'created_today', 'completed_today'] },
    query: { type: 'string' }, projectless: { type: 'boolean' },
    preserveNames: { type: 'array', maxItems: 20, items: { type: 'string' } },
    schedule: typedSchedule, endSchedule: typedSchedule,
    advanceMinutes: { type: 'integer', minimum: 1, maximum: 10080 },
    recurrence: { type: 'string', enum: RECURRENCES },
    requiresConfirmation: { type: 'boolean' },
    nudgeIntervalMinutes: { type: 'integer', minimum: 1, maximum: 10080 }, maxNudges: { type: 'integer', minimum: 1, maximum: 100 },
    durationMinutes: { type: 'integer', minimum: 1, maximum: 10080 }, addGoogleMeet: { type: 'boolean' }, limit: { type: 'integer', minimum: 1, maximum: 50 },
    missingFields: { type: 'array', uniqueItems: true, maxItems: 2, items: { type: 'string', enum: ['main_time', 'advance_minutes'] } },
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

export const EXECUTE_TURN_DESCRIPTION = `Return the CURRENT user's meaning as canonical actions. A TurnIntent is mandatory for every turn, including ordinary conversation.
Current explicit meaning overrides history, Working Memory and persistent memory. Context may resolve human references but never change the requested operation. Never output internal IDs.
conversation.reply: ordinary conversation or a personal answer already supported by supplied context; it must never claim an operational read/mutation.
agenda.read: cross-domain live inventory such as pending/today/agenda. If the user explicitly asks only reminders, tasks or Calendar, use that domain instead. Never reconstruct live state from chat history.
CREATE VS UPDATE IS A HARD SEMANTIC BOUNDARY: create introduces a new object and has no target. update/cancel/complete/delete refer to an existing object: target is its human identity and patch fields contain only requested deltas. Never use a patch value to identify the object.
Reminder removal is reminder.cancel. reminder.delete is a tolerated provider-wire alias that Node canonicalizes to cancel because the flat strict provider schema must also expose delete for other domains; Hermes should still emit cancel. For several referenced reminders, emit one reminder.cancel action per referenced item.
reminder.acknowledge: use when an active follow-up's real-world action is done. With exactly one authoritative active follow-up target may be omitted for Node to bind; with several, identify it or clarify. Completion is not an update. Use reminder.update only when changing stored reminder fields.
Temporal meaning must remain typed: relative_offset only for durations from now; relative_day_time for a relative day plus clock; weekday_time for a named weekday plus clock; local_time for clock only. Node performs date/timezone arithmetic.
Recurring reminders keep recurrence on the reminder action. Advance notice stays on the same reminder/event via advanceMinutes.
A durable personal statement is conversation.reply plus passive learning; memory.save only when explicitly asked to remember/store it.
For pending.execute/discard/revise, target selects only the pending proposal and is never reused as domain-object identity.
For mixed messages emit all valid requested actions and put only non-executable clauses in excluded. Do not duplicate backend cards with conversation.reply.`;

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

export function normalizeIntentAction(domain, action) {
  const normalized = String(action || '').trim().toLowerCase().replace(/[\s-]+/g, '_');
  // The Groq-compatible flat provider schema exposes `delete` because task,
  // calendar and entity use it. For reminders the canonical equivalent is
  // `cancel`; this is protocol normalization of an already-structured action,
  // not natural-language interpretation.
  if (domain === 'reminder' && normalized === 'delete') return 'cancel';
  return normalized;
}
function hasTarget(raw) { return typeof raw?.target === 'string' && raw.target.trim().length > 0; }
function mutationRequiresTarget(domain, action, raw) {
  if (domain === 'reminder') { if (action === 'cancel' && ['all', 'elapsed'].includes(raw.scope)) return false; return ['update', 'cancel', 'add_advance'].includes(action); }
  if (domain === 'task') return ['update', 'complete', 'delete'].includes(action);
  if (domain === 'calendar') return ['update', 'delete'].includes(action);
  return false;
}

export function validateTurnIntent(intent, { isAdmin = false } = {}) {
  if (!intent || typeof intent !== 'object' || Array.isArray(intent)) return { valid: false, errorCode: 'INVALID_PARAMETERS', error: 'El intent del turno debe ser un objeto.' };
  if (!Array.isArray(intent.actions) || intent.actions.length === 0) return { valid: false, errorCode: 'INVALID_PARAMETERS', error: 'El turno requiere al menos una acción.' };
  if (intent.actions.length > 12) return { valid: false, errorCode: 'TURN_ACTION_LIMIT', error: 'El turno supera el límite de 12 acciones.' };
  const normalizedActions = [];
  for (const raw of intent.actions) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { valid: false, errorCode: 'INVALID_PARAMETERS', error: 'Cada acción debe ser un objeto.' };
    const domain = String(raw.domain || '').trim().toLowerCase();
    if (!DOMAINS.includes(domain) || (!isAdmin && domain === 'admin')) return { valid: false, errorCode: 'UNSUPPORTED_DOMAIN', error: `Dominio no disponible: ${raw.domain || '(vacío)'}.` };
    const action = normalizeIntentAction(domain, raw.action);
    if (!DOMAIN_ACTIONS[domain]?.has(action)) return { valid: false, errorCode: 'UNSUPPORTED_ACTION', error: `Capacidad no soportada: ${domain}.${raw.action}.` };
    if (domain === 'conversation' && action === 'reply' && !(typeof raw.content === 'string' && raw.content.trim())) return { valid: false, errorCode: 'MISSING_CONTENT', error: 'conversation.reply requiere contenido de respuesta.' };
    if (mutationRequiresTarget(domain, action, raw) && !hasTarget(raw)) return { valid: false, errorCode: 'MISSING_TARGET', error: `${domain}.${action} requiere una referencia explícita al objeto existente.` };
    if (raw.recurrence !== undefined && !RECURRENCES.includes(raw.recurrence)) return { valid: false, errorCode: 'INVALID_RECURRENCE', error: `Recurrencia no soportada: ${raw.recurrence}.` };
    // Groq's provider-facing schema cannot enforce this canonical constraint.
    if (Array.isArray(raw.missingFields)
      && actionSchema.properties.missingFields.uniqueItems
      && new Set(raw.missingFields).size !== raw.missingFields.length) {
      return { valid: false, errorCode: 'INVALID_PARAMETERS', error: 'missingFields no admite valores duplicados.' };
    }
    if (domain === 'reminder' && action === 'create') {
      if (!(typeof raw.content === 'string' && raw.content.trim())
        && !(typeof raw.title === 'string' && raw.title.trim())) {
        return { valid: false, errorCode: 'MISSING_CONTENT', error: 'La decisión de creación no incluyó contenido.' };
      }
      if (!raw.schedule || typeof raw.schedule !== 'object' || Array.isArray(raw.schedule)
        || !typedSchedule.properties.kind.enum.includes(raw.schedule.kind)
        || raw.schedule.kind === 'inherit_context') {
        return { valid: false, errorCode: 'MISSING_SCHEDULE', error: 'La decisión de creación no incluyó una estructura temporal utilizable.' };
      }
    }
    normalizedActions.push({ ...raw, domain, action });
  }
  const excluded = Array.isArray(intent.excluded) ? intent.excluded.filter((item) => item && typeof item.quote === 'string' && item.quote.trim()) : [];
  return { valid: true, intent: { actions: normalizedActions, excluded } };
}

export function parseIntentArguments(rawArguments) {
  if (rawArguments && typeof rawArguments === 'object') return rawArguments;
  if (typeof rawArguments !== 'string' || !rawArguments.trim()) return {};
  try { const parsed = JSON.parse(rawArguments); return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null; } catch { return null; }
}
