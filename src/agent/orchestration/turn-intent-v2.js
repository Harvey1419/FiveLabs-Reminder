const DOMAINS = Object.freeze([
  'agenda', 'reminder', 'task', 'entity', 'calendar', 'memory', 'subscription', 'pending', 'clarification', 'admin',
]);

const DOMAIN_ACTION_TO_KIND = Object.freeze({
  agenda: Object.freeze({ read: 'agenda_read' }),
  reminder: Object.freeze({
    create: 'reminder_create', update: 'reminder_update', cancel: 'reminder_cancel',
    acknowledge: 'reminder_acknowledge', list: 'reminder_list', add_advance: 'reminder_add_advance',
  }),
  task: Object.freeze({
    create: 'task_create', update: 'task_update', complete: 'task_complete', delete: 'task_delete', list: 'task_list',
  }),
  entity: Object.freeze({
    create: 'entity_create', upsert: 'entity_upsert', rename: 'entity_rename', merge: 'entity_merge',
    delete: 'entity_delete', deduplicate: 'entity_deduplicate', list: 'entity_list',
  }),
  calendar: Object.freeze({
    create: 'calendar_create', update: 'calendar_update', delete: 'calendar_delete', list: 'calendar_list',
    search: 'calendar_search', next: 'calendar_next', connect: 'calendar_connect', disconnect: 'calendar_disconnect',
  }),
  memory: Object.freeze({ save: 'memory_save', search: 'memory_search', list: 'memory_list', forget: 'memory_forget' }),
  subscription: Object.freeze({ link: 'subscription_link', status: 'subscription_status', cancel: 'subscription_cancel' }),
  pending: Object.freeze({ execute: 'execute_pending', discard: 'discard_pending', revise: 'revise_pending' }),
  clarification: Object.freeze({ request: 'clarification_request' }),
  admin: Object.freeze({ metrics: 'admin_metrics' }),
});

const ACTION_ALIASES = Object.freeze({
  agenda: Object.freeze({ get: 'read', show: 'read', list: 'read', view: 'read' }),
  reminder: Object.freeze({
    add: 'create', set: 'create', get: 'list', read: 'list', show: 'list', search: 'list',
    remove: 'cancel', delete: 'cancel', dismiss: 'acknowledge', done: 'acknowledge',
  }),
  task: Object.freeze({
    add: 'create', get: 'list', read: 'list', show: 'list', search: 'list', done: 'complete',
    finish: 'complete', remove: 'delete', cancel: 'delete',
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
  description: 'Structured meaning of the primary time. Node performs all calendar and timezone arithmetic.',
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

export const TURN_INTENT_V2_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  properties: {
    sourceQuote: {
      type: 'string',
      description: 'Copy the current user message verbatim once. Node reuses it as provenance for every action; do not split it per action.',
    },
    actions: {
      type: 'array',
      minItems: 1,
      maxItems: 12,
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          domain: { type: 'string', enum: DOMAINS, description: 'Choose by user meaning, not keywords. admin is available only to verified administrators.' },
          action: { type: 'string', description: 'Plain semantic operation. Natural synonyms are accepted and normalized by Node.' },
          target: { type: 'string', description: 'Human reference to an existing item, e.g. its name, “la segunda”, or “2”. Never an internal ID.' },
          content: { type: 'string' }, title: { type: 'string' }, description: { type: 'string' },
          entityName: { type: 'string' }, oldName: { type: 'string' }, newName: { type: 'string' }, sourceName: { type: 'string' },
          category: { type: 'string', enum: ['person', 'company', 'project', 'place', 'pet', 'asset', 'other'] },
          priority: { type: 'string', enum: ['low', 'medium', 'high', 'urgent'] },
          status: { type: 'string', enum: ['pending', 'in_progress', 'completed', 'cancelled', 'all'] },
          scope: { type: 'string' },
          filter: { type: 'string', enum: ['upcoming', 'pending_today', 'remaining_today', 'created_today', 'completed_today'] },
          query: { type: 'string' }, projectless: { type: 'boolean' },
          preserveNames: { type: 'array', maxItems: 20, items: { type: 'string' } },
          schedule: typedSchedule,
          endSchedule: typedSchedule,
          advanceMinutes: { type: 'integer', minimum: 1, maximum: 10080 },
          recurrence: { type: 'string' }, requiresConfirmation: { type: 'boolean' },
          nudgeIntervalMinutes: { type: 'integer', minimum: 1, maximum: 10080 },
          maxNudges: { type: 'integer', minimum: 1, maximum: 100 },
          durationMinutes: { type: 'integer', minimum: 1, maximum: 10080 },
          addGoogleMeet: { type: 'boolean' }, limit: { type: 'integer', minimum: 1, maximum: 50 },
          missingFields: {
            type: 'array', uniqueItems: true, maxItems: 2,
            items: { type: 'string', enum: ['main_time', 'advance_minutes'] },
          },
          question: { type: 'string' },
        },
        required: ['domain', 'action'],
      },
    },
    excluded: {
      type: 'array',
      maxItems: 12,
      description: 'Only for a mixed turn that also contains valid actions. Put current-message clauses that must not execute here.',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          quote: { type: 'string', description: 'Exact current-message words for the excluded clause.' },
          reason: { type: 'string', enum: ['prohibited', 'context_only', 'superseded', 'hypothetical'] },
        },
        required: ['quote', 'reason'],
      },
    },
  },
  required: ['sourceQuote', 'actions'],
});

export const EXECUTE_TURN_V2_DESCRIPTION = `Execute only the current user's in-scope action delta as a small semantic action list.
Think about the user's goal first. Do not encode sequence numbers, backend operation kinds, contextRef objects or IDs.
Copy the current message once into sourceQuote. Use one action per independent goal. Use target only for an existing item the user refers to. Keep temporal meaning in schedule; Node resolves dates/timezones.
Live-state questions are not ordinary conversation. A cross-domain read of what is pending, scheduled, due, on the agenda, or coming up must use agenda.read. Use scope=all_pending when no time range is stated; preserve explicit scopes such as today, tomorrow, this_week or a supplied date/range. Use reminder/task/calendar reads only when the user explicitly narrows the request to that single domain.
Do not use memory actions merely to answer a personal fact that is already present in the supplied user memories or profile context; answer those directly in prose.
A plain personal statement such as a stable fact, preference, employer, residence or relationship normally does NOT require a memory tool: answer naturally and let the background learning pipeline persist it. Use memory.save only when the user explicitly asks to remember/store/save something now. Use memory.search only when supplied context is insufficient and persistent recall is actually needed.
For a mixed message, use excluded only for the exact prohibited, hypothetical, superseded or context-only clause. A wholly out-of-scope turn should be answered naturally without this tool.
Do not call this tool for ordinary conversation, acknowledgements, emotional support or conversation closes.`;

function copyDefined(source, keys) {
  const result = {};
  for (const key of keys) if (source[key] !== undefined) result[key] = source[key];
  return result;
}

function normalizeAction(domain, action) {
  const normalized = String(action || '').trim().toLowerCase().replace(/[\s-]+/g, '_');
  if (!normalized) return '';
  if (DOMAIN_ACTION_TO_KIND[domain]?.[normalized]) return normalized;
  return ACTION_ALIASES[domain]?.[normalized] || normalized;
}

function resolveKind(domain, action) {
  const normalizedAction = normalizeAction(domain, action);
  return DOMAIN_ACTION_TO_KIND[domain]?.[normalizedAction] || null;
}

function pendingContextRef(target) {
  const parsed = Number.parseInt(String(target || '1'), 10);
  return { source: 'pending_state', position: Number.isInteger(parsed) && parsed > 0 ? parsed : 1 };
}

function memoryQueryFromAction(action) {
  return action.query || action.target || action.content || action.title || null;
}

/** Convert the small model-facing TurnIntent into the existing validated manifest. */
export function compileTurnIntentV2(intent, { userMessage = '' } = {}) {
  if (!intent || typeof intent !== 'object' || !Array.isArray(intent.actions) || intent.actions.length === 0) {
    return { valid: false, errorCode: 'INVALID_PARAMETERS', error: 'TurnIntent v2 requiere al menos una acción.' };
  }

  const sourceQuote = String(userMessage || intent.sourceQuote || '').trim();
  if (!sourceQuote) {
    return { valid: false, errorCode: 'UNTRUSTED_SOURCE_QUOTE', error: 'Falta evidencia literal del mensaje actual.' };
  }

  const operations = [];
  for (let index = 0; index < intent.actions.length; index += 1) {
    const action = intent.actions[index] || {};
    const normalizedAction = normalizeAction(action.domain, action.action);
    const kind = resolveKind(action.domain, action.action);
    if (!kind) {
      return { valid: false, errorCode: 'UNSUPPORTED_ACTION', error: `Capacidad no soportada en TurnIntent v2: ${action.domain}.${action.action}.` };
    }

    const operation = {
      sequence: index + 1,
      kind,
      sourceQuote,
      ...copyDefined(action, [
        'content', 'title', 'description', 'entityName', 'oldName', 'newName', 'sourceName',
        'category', 'priority', 'status', 'scope', 'filter', 'query', 'projectless', 'preserveNames',
        'schedule', 'endSchedule', 'advanceMinutes', 'recurrence', 'requiresConfirmation',
        'nudgeIntervalMinutes', 'maxNudges', 'durationMinutes', 'addGoogleMeet', 'limit', 'missingFields', 'question',
      ]),
    };

    if (action.target) operation.targetName = action.target;
    if (action.domain === 'pending') operation.contextRef = pendingContextRef(action.target);
    if (kind === 'clarification_request') {
      operation.clarificationKind = action.missingFields?.length ? 'reminder_schedule' : 'generic';
    }

    // Generic agenda reads converge on current pending state. Temporal queries
    // carry an explicit scope from Hermes and are left untouched.
    if (action.domain === 'agenda' && normalizedAction === 'read' && !operation.scope) {
      operation.scope = 'all_pending';
    }

    if (action.domain === 'memory' && normalizedAction === 'search') {
      const query = memoryQueryFromAction(action);
      if (query) operation.query = query;
      else operation.kind = 'memory_list';
      delete operation.targetName;
    }

    if (action.domain === 'memory' && normalizedAction === 'save') {
      const content = action.content || action.target || action.title || action.description || null;
      if (content) operation.content = content;
      delete operation.targetName;
    }

    operations.push(operation);
  }

  const excludedClauses = Array.isArray(intent.excluded)
    ? intent.excluded.map((item) => ({ sourceQuote: item.quote, reason: item.reason }))
    : [];

  return { valid: true, manifest: { operations, excludedClauses } };
}

export function isTurnIntentV2(value) {
  return Boolean(value && typeof value === 'object' && Array.isArray(value.actions));
}