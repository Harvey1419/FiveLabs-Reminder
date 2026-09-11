import { TOOL_NAMES } from './tool-names.js';
import { AGENDA_SCOPES } from '../../shared/agenda-scopes.js';

const DOMAINS = Object.freeze([
  'conversation', 'agenda', 'reminder', 'task', 'entity', 'calendar', 'memory', 'subscription', 'pending', 'clarification', 'admin',
]);
const RECURRENCES = Object.freeze(['daily', 'weekdays', 'weekly', 'monthly', 'hourly']);
const PENDING_INTENT_EFFECTS = Object.freeze(['resolve', 'replace', 'preserve']);
const MISSING_FIELDS = Object.freeze([
  'content', 'target', 'selection', 'scope', 'schedule', 'date', 'time', 'main_time', 'advance_minutes',
]);

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
const typedSchedule = {
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
    target: { type: 'string', description: 'Human reference to an EXISTING item, never an internal ID. Required by existing-object mutations except reminder.acknowledge when Node can bind one authoritative active follow-up. For pending actions it selects only the pending proposal.' },
    content: { type: 'string', description: 'Natural reply, create content, or requested update delta; never existing-object identity.' },
    title: { type: 'string', description: 'One actionable task/event title, not the name of its containing project.' }, description: { type: 'string' },
    entityName: { type: 'string', description: 'Human name of the related entity. On task actions this is the project container that owns the task; repeat it on every item in a compound operational collection.' }, oldName: { type: 'string' }, newName: { type: 'string' }, sourceName: { type: 'string' },
    category: { type: 'string', enum: ['person', 'company', 'project', 'place', 'pet', 'asset', 'other', 'fact', 'preference', 'decision', 'episode', 'observation'], description: 'Use project for an operational container whose members are tasks. A collection of people, companies or other knowledge remains entities according to what its members mean.' },
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
    missingFields: { type: 'array', uniqueItems: true, maxItems: 8, items: { type: 'string', enum: MISSING_FIELDS } },
    continuationIndex: { type: 'integer', minimum: 1, maximum: 12, description: 'One-based position of the pending action completed by this action. Required when a continuation has multiple pending actions; several actions may complete the same pending action.' },
    question: { type: 'string' },
  },
  required: ['domain', 'action'],
};

export const TURN_INTENT_SCHEMA = Object.freeze({
  type: 'object', additionalProperties: false,
  properties: {
    actions: { type: 'array', minItems: 1, maxItems: 12, items: actionSchema },
    pendingIntentEffect: {
      type: 'string',
      enum: PENDING_INTENT_EFFECTS,
      description: 'When a typed pending intent is present: resolve=these are its complete merged actions; replace=these partial actions supersede its prior draft and still need clarification; preserve=this is a separate topic and the pending intent remains untouched.',
    },
    excluded: { type: 'array', maxItems: 12, items: { type: 'object', additionalProperties: false, properties: { quote: { type: 'string' }, reason: { type: 'string', enum: ['prohibited', 'context_only', 'superseded', 'hypothetical'] } }, required: ['quote', 'reason'] } },
  },
  required: ['actions'],
});

export const EXECUTE_TURN_DESCRIPTION = `Return the CURRENT user's meaning as canonical actions; TurnIntent is mandatory for every turn. Explicit current meaning overrides all context. Context resolves human references, never changes the operation. Never output internal IDs.
conversation.reply is non-operational and cannot claim reads/mutations. agenda.read is cross-domain live inventory; use reminder/task/calendar for domain-specific reads. Never reconstruct live state from chat history.
CREATE VS UPDATE IS A HARD SEMANTIC BOUNDARY: create has no target; update/cancel/complete/delete target an existing human-identified object and contain only requested deltas. A patch value is never identity.
Reminder removal is reminder.cancel; emit one cancel per target. reminder.acknowledge marks a real-world follow-up done; one authoritative active target may be bound by Node, otherwise identify or clarify. Completion is not an update.
OPERATIONAL COLLECTIONS: infer from members, not labels. Actionable members => entity.upsert category=project first + one task.create each sharing entityName/category=project; reuse it. Item add/read/complete/remove stays in task scoped by entityName. entity.list/delete concerns the container; people/company/place/knowledge collections stay entities. Never collapse members.
Temporal meaning must remain typed: relative_offset=duration; relative_day_time=relative day+clock; weekday_time=weekday+clock; local_time=clock only. Node owns date/timezone arithmetic.
For missing data, keep partial canonical actions with missingFields and a question; add one clarification.request when possible, never one per field/item. Given a typed pending intent, retain known fields, replace explicit corrections and map via continuationIndex. pendingIntentEffect is resolve only when complete, replace when still incomplete, preserve for another topic; pending.discard cancels.
Keep recurrence and advanceMinutes on their reminder/event. Durable personal statements use conversation.reply plus passive learning; memory.save only on explicit request.
pending.execute/discard/revise target only a pending proposal. For mixed messages emit valid actions, put non-executable clauses in excluded, and never duplicate backend cards with conversation.reply.`;

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
function hasCompleteReminderSchedule(schedule) {
  if (!schedule || typeof schedule !== 'object' || Array.isArray(schedule)) return false;
  if (schedule.kind === 'relative_offset') return Number.isInteger(schedule.offsetMinutes);
  if (schedule.kind === 'relative_day_time') return Number.isInteger(schedule.dayOffset) && Number.isInteger(schedule.hour);
  if (schedule.kind === 'calendar_date_time') return Number.isInteger(schedule.month) && Number.isInteger(schedule.day) && Number.isInteger(schedule.hour);
  if (schedule.kind === 'weekday_time') return typeof schedule.weekday === 'string' && Number.isInteger(schedule.hour);
  if (schedule.kind === 'local_time') return Number.isInteger(schedule.hour);
  return false;
}
function inferPartialReminderScheduleFields(schedule) {
  if (!schedule || typeof schedule !== 'object' || Array.isArray(schedule)) return [];
  const hasClock = Number.isInteger(schedule.hour);
  let hasDate = false;
  if (schedule.kind === 'relative_day_time') hasDate = Number.isInteger(schedule.dayOffset);
  if (schedule.kind === 'calendar_date_time') hasDate = Number.isInteger(schedule.month) && Number.isInteger(schedule.day);
  if (schedule.kind === 'weekday_time') hasDate = typeof schedule.weekday === 'string';
  if (schedule.kind === 'local_time') {
    return hasClock ? ['date'] : [];
  }
  if (!['relative_day_time', 'calendar_date_time', 'weekday_time'].includes(schedule.kind)) return [];
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

export function validateTurnIntent(intent, { isAdmin = false } = {}) {
  if (!intent || typeof intent !== 'object' || Array.isArray(intent)) return { valid: false, errorCode: 'INVALID_PARAMETERS', error: 'El intent del turno debe ser un objeto.' };
  if (!Array.isArray(intent.actions) || intent.actions.length === 0) return { valid: false, errorCode: 'INVALID_PARAMETERS', error: 'El turno requiere al menos una acción.' };
  if (intent.actions.length > 12) return { valid: false, errorCode: 'TURN_ACTION_LIMIT', error: 'El turno supera el límite de 12 acciones.' };
  const pendingIntentEffect = intent.pendingIntentEffect == null
    ? null
    : String(intent.pendingIntentEffect).trim().toLowerCase();
  if (pendingIntentEffect && !PENDING_INTENT_EFFECTS.includes(pendingIntentEffect)) {
    return { valid: false, errorCode: 'INVALID_PARAMETERS', error: 'La transición de intención pendiente no es válida.' };
  }
  if (['resolve', 'replace'].includes(pendingIntentEffect)) {
    const hasContinuationAction = intent.actions.some((raw) => !['conversation', 'clarification', 'pending'].includes(String(raw?.domain || '').trim().toLowerCase()));
    if (!hasContinuationAction) {
      return { valid: false, errorCode: 'INVALID_PENDING_CONTINUATION', error: 'La continuación pendiente requiere al menos una acción de dominio.' };
    }
  }
  const normalizedActions = [];
  for (const raw of intent.actions) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { valid: false, errorCode: 'INVALID_PARAMETERS', error: 'Cada acción debe ser un objeto.' };
    const domain = String(raw.domain || '').trim().toLowerCase();
    if (!DOMAINS.includes(domain) || (!isAdmin && domain === 'admin')) return { valid: false, errorCode: 'UNSUPPORTED_DOMAIN', error: `Dominio no disponible: ${raw.domain || '(vacío)'}.` };
    const action = normalizeIntentAction(domain, raw.action);
    if (!DOMAIN_ACTIONS[domain]?.has(action)) return { valid: false, errorCode: 'UNSUPPORTED_ACTION', error: `Capacidad no soportada: ${domain}.${raw.action}.` };
    if (domain === 'conversation' && action === 'reply' && !(typeof raw.content === 'string' && raw.content.trim())) return { valid: false, errorCode: 'MISSING_CONTENT', error: 'conversation.reply requiere contenido de respuesta.' };
    const mayInheritPending = ['resolve', 'replace'].includes(pendingIntentEffect)
      && !['conversation', 'clarification', 'pending'].includes(domain);
    const structurallyMissingScheduleFields = domain === 'reminder'
      && action === 'create'
      && !mayInheritPending
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
    if (mutationRequiresTarget(domain, action, normalizedRaw) && !hasTarget(normalizedRaw) && !mayRemainPending && !mayInheritPending) return { valid: false, errorCode: 'MISSING_TARGET', error: `${domain}.${action} requiere una referencia explícita al objeto existente.` };
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
        && !mayInheritPending) {
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
      if (!hasCompleteReminderSchedule(normalizedRaw.schedule) && !mayRemainPending && !mayInheritPending) {
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
      ...(pendingIntentEffect ? { pendingIntentEffect } : {}),
      excluded,
    },
  };
}

export function parseIntentArguments(rawArguments) {
  if (rawArguments && typeof rawArguments === 'object') return rawArguments;
  if (typeof rawArguments !== 'string' || !rawArguments.trim()) return {};
  try { const parsed = JSON.parse(rawArguments); return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null; } catch { return null; }
}
