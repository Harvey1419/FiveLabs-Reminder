const DOMAINS = Object.freeze([
  'agenda', 'reminder', 'task', 'entity', 'calendar', 'memory', 'subscription', 'pending', 'clarification',
]);

const DOMAIN_ACTION_TO_KIND = Object.freeze({
  agenda: Object.freeze({ read: 'agenda_read' }),
  reminder: Object.freeze({
    create: 'reminder_create',
    update: 'reminder_update',
    cancel: 'reminder_cancel',
    acknowledge: 'reminder_acknowledge',
    list: 'reminder_list',
    add_advance: 'reminder_add_advance',
  }),
  task: Object.freeze({
    create: 'task_create',
    update: 'task_update',
    complete: 'task_complete',
    delete: 'task_delete',
    list: 'task_list',
  }),
  entity: Object.freeze({
    create: 'entity_create',
    upsert: 'entity_upsert',
    rename: 'entity_rename',
    merge: 'entity_merge',
    delete: 'entity_delete',
    deduplicate: 'entity_deduplicate',
    list: 'entity_list',
  }),
  calendar: Object.freeze({
    create: 'calendar_create',
    update: 'calendar_update',
    delete: 'calendar_delete',
    list: 'calendar_list',
    search: 'calendar_search',
    next: 'calendar_next',
    connect: 'calendar_connect',
    disconnect: 'calendar_disconnect',
  }),
  memory: Object.freeze({
    save: 'memory_save',
    search: 'memory_search',
    list: 'memory_list',
    forget: 'memory_forget',
  }),
  subscription: Object.freeze({
    link: 'subscription_link',
    status: 'subscription_status',
    cancel: 'subscription_cancel',
  }),
  pending: Object.freeze({
    execute: 'execute_pending',
    discard: 'discard_pending',
    revise: 'revise_pending',
  }),
  clarification: Object.freeze({ request: 'clarification_request' }),
});

export const TURN_INTENT_V2_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  properties: {
    actions: {
      type: 'array',
      minItems: 1,
      maxItems: 12,
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          domain: {
            type: 'string',
            enum: DOMAINS,
            description: 'What kind of user goal this action belongs to. Choose by meaning, not keywords.',
          },
          action: {
            type: 'string',
            description: 'Plain operation inside the selected domain, such as create, update, complete, list, read, search, cancel, acknowledge, connect or forget.',
          },
          target: {
            type: 'string',
            description: 'Human reference to an existing item, such as its visible name, “la segunda”, or “2”. Never provide an internal ID.',
          },
          content: { type: 'string' },
          title: { type: 'string' },
          description: { type: 'string' },
          entityName: { type: 'string' },
          oldName: { type: 'string' },
          newName: { type: 'string' },
          sourceName: { type: 'string' },
          category: { type: 'string', enum: ['person', 'company', 'project', 'place', 'pet', 'asset', 'other'] },
          priority: { type: 'string', enum: ['low', 'medium', 'high', 'urgent'] },
          status: { type: 'string', enum: ['pending', 'in_progress', 'completed', 'cancelled', 'all'] },
          scope: { type: 'string' },
          filter: { type: 'string', enum: ['upcoming', 'pending_today', 'remaining_today', 'created_today', 'completed_today'] },
          query: { type: 'string' },
          projectless: { type: 'boolean' },
          preserveNames: { type: 'array', maxItems: 20, items: { type: 'string' } },
          schedule: {
            type: 'object',
            additionalProperties: false,
            description: 'Structured meaning of the primary time. Node performs calendar/timezone arithmetic.',
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
          },
          endSchedule: { type: 'object' },
          advanceMinutes: { type: 'integer', minimum: 1, maximum: 10080 },
          recurrence: { type: 'string' },
          requiresConfirmation: { type: 'boolean' },
          nudgeIntervalMinutes: { type: 'integer', minimum: 1, maximum: 10080 },
          maxNudges: { type: 'integer', minimum: 1, maximum: 100 },
          durationMinutes: { type: 'integer', minimum: 1, maximum: 10080 },
          addGoogleMeet: { type: 'boolean' },
          limit: { type: 'integer', minimum: 1, maximum: 50 },
          missingFields: {
            type: 'array',
            uniqueItems: true,
            maxItems: 2,
            items: { type: 'string', enum: ['main_time', 'advance_minutes'] },
          },
          question: { type: 'string' },
        },
        required: ['domain', 'action'],
      },
    },
  },
  required: ['actions'],
});

export const EXECUTE_TURN_V2_DESCRIPTION = `Execute the user's current in-scope goal using a small semantic action list.
Think about the user's objective first. Do not encode backend protocol, IDs, evidence quotes, sequence numbers or internal state references.
Use one action per independent user goal. Use target only for an existing item the user refers to. Keep time meaning in schedule; Node resolves actual dates and timezone arithmetic.
Do not call for ordinary conversation, acknowledgements, emotional support, conversation closes or wholly out-of-scope requests.`;

function copyDefined(source, keys) {
  const result = {};
  for (const key of keys) {
    if (source[key] !== undefined) result[key] = source[key];
  }
  return result;
}

function resolveKind(domain, action) {
  return DOMAIN_ACTION_TO_KIND[domain]?.[action] || null;
}

function pendingContextRef(target) {
  const parsed = Number.parseInt(String(target || '1'), 10);
  return { source: 'pending_state', position: Number.isInteger(parsed) && parsed > 0 ? parsed : 1 };
}

/**
 * Convert the small model-facing TurnIntent into the existing validated manifest.
 * This adapter intentionally owns protocol fields such as sequence/sourceQuote.
 */
export function compileTurnIntentV2(intent, { userMessage = '' } = {}) {
  if (!intent || typeof intent !== 'object' || !Array.isArray(intent.actions) || intent.actions.length === 0) {
    return { valid: false, errorCode: 'INVALID_PARAMETERS', error: 'TurnIntent v2 requiere al menos una acción.' };
  }

  const sourceQuote = String(userMessage || '').trim();
  if (!sourceQuote) {
    return { valid: false, errorCode: 'UNTRUSTED_SOURCE_QUOTE', error: 'Falta el mensaje actual para autorizar la acción.' };
  }

  const operations = [];
  for (let index = 0; index < intent.actions.length; index += 1) {
    const action = intent.actions[index] || {};
    const kind = resolveKind(action.domain, action.action);
    if (!kind) {
      return {
        valid: false,
        errorCode: 'UNSUPPORTED_ACTION',
        error: `Acción no soportada en TurnIntent v2: ${action.domain}.${action.action}.`,
      };
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

    if (action.domain === 'pending') {
      operation.contextRef = pendingContextRef(action.target);
    }

    if (kind === 'clarification_request') {
      operation.clarificationKind = action.missingFields?.length ? 'reminder_schedule' : 'generic';
    }

    operations.push(operation);
  }

  return {
    valid: true,
    manifest: {
      operations,
      excludedClauses: [],
    },
  };
}

export function isTurnIntentV2(value) {
  return Boolean(value && typeof value === 'object' && Array.isArray(value.actions));
}
