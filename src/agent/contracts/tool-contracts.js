import { TOOL_NAMES } from './tool-names.js';
import {
  TURN_INTENT_V2_SCHEMA,
  EXECUTE_TURN_V2_DESCRIPTION,
  compileTurnIntentV2,
  isTurnIntentV2,
} from '../orchestration/turn-intent-v2.js';

const stringField = (description) => ({ type: 'string', description });
const booleanField = (description) => ({ type: 'boolean', description });
const numberField = (description) => ({ type: 'number', description });
const canonicalDateTimeField = (purpose) => stringField(`${purpose} Use a language-independent canonical value only: an ISO 8601 duration for a relative time (PT10M, PT2H, P1D, P1W) or an ISO 8601 date/time for an absolute time (for example 2026-09-04T16:00:00-05:00). Never put natural-language time text in this field.`);

const targetFields = {
  target: stringField('Human reference to an item, such as its title or an ordinal from Working Memory (for example "la segunda"). Never invent an internal ID.'),
  scope: stringField('Requested time or collection scope. Use "all" only when the user explicitly refers to the whole active collection.'),
};

const typedSchedule = {
  type: 'object',
  additionalProperties: false,
  description: 'Language-independent time of the primary reminder/event itself. The backend performs all calendar and timezone arithmetic.',
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

const contextRef = {
  type: 'object',
  additionalProperties: false,
  properties: {
    source: { type: 'string', enum: ['working_memory', 'pending_state', 'turn_operation'] },
    position: { type: 'integer', minimum: 1, maximum: 20 },
  },
  required: ['source', 'position'],
};

const publicOperationKinds = [
  'agenda_read',
  'reminder_create', 'reminder_update', 'reminder_cancel', 'reminder_acknowledge', 'reminder_list', 'reminder_add_advance',
  'task_create', 'task_update', 'task_complete', 'task_delete', 'task_list',
  'entity_create', 'entity_upsert', 'entity_rename', 'entity_merge', 'entity_delete', 'entity_deduplicate', 'entity_list',
  'calendar_create', 'calendar_update', 'calendar_delete', 'calendar_list', 'calendar_search', 'calendar_next', 'calendar_connect', 'calendar_disconnect',
  'memory_save', 'memory_search', 'memory_list', 'memory_forget',
  'subscription_link', 'subscription_status', 'subscription_cancel',
  'execute_pending', 'discard_pending', 'revise_pending', 'clarification_request',
];

const turnOperation = {
  type: 'object',
  additionalProperties: false,
  properties: {
    sequence: { type: 'integer', minimum: 1, maximum: 12 },
    kind: { type: 'string', enum: [...publicOperationKinds, 'admin_metrics'] },
    sourceQuote: stringField('Literal contiguous evidence from the current user message.'),
    contextRef,
    content: stringField('Reminder content or durable memory content.'),
    title: stringField('Task or event title.'),
    description: stringField('Explicit description.'),
    entityName: stringField('User-facing project/list name.'),
    projectless: booleanField('Task explicitly outside every project/list.'),
    targetName: stringField('User-facing target reference.'),
    oldName: stringField('Current entity name.'),
    newName: stringField('Replacement entity name.'),
    sourceName: stringField('Entity to merge away.'),
    category: { type: 'string', enum: ['person', 'company', 'project', 'place', 'pet', 'asset', 'other'] },
    preserveNames: { type: 'array', maxItems: 20, items: { type: 'string' } },
    priority: { type: 'string', enum: ['low', 'medium', 'high', 'urgent'] },
    status: { type: 'string', enum: ['pending', 'in_progress', 'completed', 'cancelled', 'all'] },
    scope: { type: 'string' },
    filter: { type: 'string', enum: ['upcoming', 'pending_today', 'remaining_today', 'created_today', 'completed_today'] },
    query: { type: 'string' },
    date: { type: 'string' },
    dateFrom: { type: 'string' },
    dateTo: { type: 'string' },
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
    clarificationKind: { type: 'string', enum: ['reminder_schedule', 'generic'] },
    missingFields: {
      type: 'array', uniqueItems: true, maxItems: 2,
      items: { type: 'string', enum: ['main_time', 'advance_minutes'] },
    },
    question: { type: 'string' },
  },
  required: ['sequence', 'kind', 'sourceQuote'],
};

const executeTurnDefinition = {
  description: 'Legacy validated execution manifest. Kept as an internal compatibility contract while the model-facing boundary uses TurnIntent v2.',
  parameters: {
    type: 'object',
    additionalProperties: false,
    properties: {
      operations: { type: 'array', minItems: 1, maxItems: 12, items: turnOperation },
      excludedClauses: {
        type: 'array', maxItems: 12,
        items: {
          type: 'object', additionalProperties: false,
          properties: {
            sourceQuote: { type: 'string' },
            reason: { type: 'string', enum: ['prohibited', 'context_only', 'superseded', 'hypothetical'] },
          },
          required: ['sourceQuote', 'reason'],
        },
      },
    },
    required: ['operations', 'excludedClauses'],
  },
};

const reminderItem = {
  type: 'object',
  additionalProperties: false,
  properties: {
    content: stringField('What the user wants to be reminded about.'),
    targetTime: canonicalDateTimeField('When this reminder must fire.'),
    sourceTimeText: stringField('Copy the exact words from the current user message that express this item’s time.'),
    recurrence: stringField('Recurrence stated by the user.'),
    requiresConfirmation: booleanField('Whether Hermes should keep nudging until acknowledgement.'),
    nudgeIntervalMinutes: numberField('Minutes between confirmation nudges.'),
    maxNudges: numberField('Maximum confirmation nudges.'),
    advanceMinutes: {
      type: 'integer', minimum: 1, maximum: 10080,
      description: 'Lead time explicitly requested for an additional notice before a separate primary appointment/reminder time. Keep targetTime as the primary time; the backend creates both reminders.',
    },
  },
  required: ['content', 'targetTime'],
};

const taskItem = {
  type: 'object',
  additionalProperties: false,
  properties: {
    title: stringField('Natural task title without command-language wrappers.'),
    description: stringField('Optional task details explicitly provided by the user.'),
    dueDate: canonicalDateTimeField('Due date/time explicitly stated by the user. Omit when none was stated.'),
    priority: { type: 'string', enum: ['low', 'medium', 'high', 'urgent'] },
    entityName: stringField('User-facing project or list name. Never use an internal ID.'),
    entityCategory: stringField('Category of the project/list when explicitly identified.'),
  },
  required: ['title'],
};

const definitions = {
  [TOOL_NAMES.GET_UNIFIED_AGENDA]: {
    description: 'Read the user’s cross-domain agenda (Google Calendar, reminders, and dated tasks) for a requested period. Use for general schedule questions; do not use when the user explicitly asks only about one domain.',
    parameters: {
      type: 'object', additionalProperties: false,
      properties: {
        scope: {
          type: 'string',
          enum: ['today', 'remaining_today', 'tomorrow', 'day_after_tomorrow', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday', 'this_week', 'next_week', 'this_weekend', 'upcoming', 'month', 'full_year', 'explicit_date', 'explicit_range'],
        },
        date: stringField('Explicit date from the user, preferably YYYY-MM-DD.'),
        dateFrom: stringField('Start of an explicit date range.'),
        dateTo: stringField('End of an explicit date range.'),
        query: stringField('Optional semantic filter stated by the user.'),
      },
      required: ['scope'],
    },
  },
  [TOOL_NAMES.MANAGE_REMINDER]: {
    description: 'Create, update, cancel, acknowledge, or list WhatsApp reminders. A reminder is a notification at a specific time; it is not a project task or Google Calendar event. When the user requests advance notice, keep the primary targetTime and pass advanceMinutes so the backend can create both reminders.',
    parameters: {
      type: 'object', additionalProperties: false,
      properties: {
        action: { type: 'string', enum: ['create', 'update', 'cancel', 'acknowledge', 'list'] },
        items: { type: 'array', minItems: 1, items: reminderItem },
        ...targetFields,
        filter: { type: 'string', enum: ['upcoming', 'pending_today', 'remaining_today', 'created_today', 'completed_today'] },
        updates: {
          type: 'object', additionalProperties: false,
          properties: {
            content: stringField('Replacement reminder content explicitly requested.'),
            targetTime: canonicalDateTimeField('Replacement date/time explicitly requested.'),
            recurrence: stringField('Replacement recurrence explicitly requested.'),
          },
        },
        advanceMinutes: { type: 'integer', minimum: 1, maximum: 10080 },
      },
      required: ['action'],
    },
  },
  [TOOL_NAMES.MANAGE_TASK]: {
    description: 'Create, update, complete, delete, or list tasks, including tasks inside projects/lists. Tasks are actionable work items, not timed WhatsApp reminders or Google Calendar events.',
    parameters: {
      type: 'object', additionalProperties: false,
      properties: {
        action: { type: 'string', enum: ['create', 'update', 'complete', 'delete', 'list'] },
        items: { type: 'array', minItems: 1, items: taskItem },
        ...targetFields,
        entityName: stringField('User-facing project/list name.'),
        status: { type: 'string', enum: ['pending', 'in_progress', 'completed', 'cancelled', 'all'] },
        updates: {
          type: 'object', additionalProperties: false,
          properties: {
            title: stringField('Replacement task title explicitly requested.'),
            description: stringField('Replacement description explicitly requested.'),
            dueDate: canonicalDateTimeField('Replacement due date/time explicitly requested.'),
            priority: { type: 'string', enum: ['low', 'medium', 'high', 'urgent'] },
            status: { type: 'string', enum: ['pending', 'in_progress', 'completed', 'cancelled'] },
          },
        },
      },
      required: ['action'],
    },
  },
  [TOOL_NAMES.MANAGE_GOOGLE_CALENDAR]: {
    description: 'Read or mutate events specifically in the user’s connected Google Calendar. Do not use for general cross-domain agenda questions, WhatsApp reminders, or tasks.',
    parameters: {
      type: 'object', additionalProperties: false,
      properties: {
        action: { type: 'string', enum: ['list_events', 'search_events', 'next_event', 'create_event', 'update_event', 'delete_event', 'get_connect_link', 'disconnect'] },
        ...targetFields,
        query: stringField('Search text explicitly requested by the user.'),
        date: stringField('Explicit event date or date restriction, preferably YYYY-MM-DD.'),
        summary: stringField('Event title explicitly provided by the user.'),
        description: stringField('Event description explicitly provided by the user.'),
        startDateTime: canonicalDateTimeField('Event start date/time explicitly provided by the user.'),
        endDateTime: canonicalDateTimeField('Event end date/time explicitly provided by the user.'),
        durationMinutes: numberField('Duration explicitly provided by the user.'),
        advanceMinutes: numberField('WhatsApp notice lead time explicitly provided by the user.'),
        addGoogleMeet: booleanField('Whether the user explicitly requested a Google Meet link.'),
      },
      required: ['action'],
    },
  },
  [TOOL_NAMES.MANAGE_MEMORY]: {
    description: 'Save, search, list, or forget durable long-term personal context. Do not use for temporary conversational state.',
    parameters: {
      type: 'object', additionalProperties: false,
      properties: {
        action: { type: 'string', enum: ['save', 'search', 'list', 'forget'] },
        content: stringField('Standalone durable fact or preference to save.'),
        category: { type: 'string', enum: ['fact', 'preference', 'decision', 'episode', 'observation', 'project'] },
        topicKey: stringField('Stable semantic topic key when clearly known; omit otherwise.'),
        query: stringField('What memory to search for or forget.'),
        limit: { type: 'integer', minimum: 1, maximum: 20 },
      },
      required: ['action'],
    },
  },
  [TOOL_NAMES.MANAGE_ENTITY]: {
    description: 'Manage user-visible projects, lists, contacts, companies, places, or other named containers. Bulk deletion is staged and separately confirmed.',
    parameters: {
      type: 'object', additionalProperties: false,
      properties: {
        action: { type: 'string', enum: ['create', 'upsert', 'rename', 'merge', 'delete', 'deduplicate', 'list'] },
        name: stringField('Canonical user-facing entity name.'),
        category: { type: 'string', enum: ['person', 'company', 'project', 'place', 'pet', 'asset', 'other'] },
        oldName: stringField('Current entity name for rename.'),
        newName: stringField('New entity name for rename.'),
        sourceName: stringField('Entity to merge away.'),
        targetName: stringField('Entity to keep.'),
        scope: { type: 'string', enum: ['single', 'all'] },
        preserveNames: { type: 'array', maxItems: 20, items: { type: 'string' } },
        limit: { type: 'integer', minimum: 1, maximum: 50 },
      },
      required: ['action'],
    },
  },
  [TOOL_NAMES.MANAGE_SUBSCRIPTION]: {
    description: 'Get the user’s Hermes subscription status or checkout link, or cancel the active subscription.',
    parameters: {
      type: 'object', additionalProperties: false,
      properties: { action: { type: 'string', enum: ['get_link', 'status', 'cancel'] } },
      required: ['action'],
    },
  },
  [TOOL_NAMES.ADMIN_METRICS]: {
    description: 'Read Hermes administrative metrics. Available only to verified administrators.',
    parameters: {
      type: 'object', additionalProperties: false,
      properties: { action: { type: 'string', enum: ['get_overview', 'get_active_subscriptions', 'get_user_count'] } },
      required: ['action'],
    },
  },
};

export function getToolDefinitions({ isAdmin = false } = {}) {
  return Object.entries(definitions)
    .filter(([name]) => isAdmin || name !== TOOL_NAMES.ADMIN_METRICS)
    .map(([name, contract]) => {
      const parameters = structuredClone(contract.parameters);
      if (name === TOOL_NAMES.MANAGE_REMINDER) {
        const required = parameters.properties?.items?.items?.required || [];
        parameters.properties.items.items.required = [...new Set([...required, 'sourceTimeText'])];
      }
      return { type: 'function', function: { name, description: contract.description, parameters } };
    });
}

/**
 * Model-facing execution boundary.
 * V2 is on by default and can be rolled back immediately with AGENT_PLANNER_V2=false.
 * The router and domain tools continue to receive the legacy manifest after validation.
 */
export function getAgentToolDefinitions({ isAdmin = false } = {}) {
  const useV2 = process.env.AGENT_PLANNER_V2 !== 'false';
  if (useV2) {
    const parameters = structuredClone(TURN_INTENT_V2_SCHEMA);
    if (!isAdmin) {
      parameters.properties.actions.items.properties.domain.enum = parameters.properties.actions.items.properties.domain.enum
        .filter((domain) => domain !== 'admin');
    }
    return [{
      type: 'function',
      function: { name: TOOL_NAMES.EXECUTE_TURN, description: EXECUTE_TURN_V2_DESCRIPTION, parameters },
    }];
  }

  const parameters = structuredClone(executeTurnDefinition.parameters);
  if (!isAdmin) parameters.properties.operations.items.properties.kind.enum = publicOperationKinds.slice();
  return [{
    type: 'function',
    function: { name: TOOL_NAMES.EXECUTE_TURN, description: executeTurnDefinition.description, parameters },
  }];
}

const forbiddenIdentityFields = new Set([
  'userId', 'user_id', 'phoneNumber', 'phone_number', 'isPro', 'isAdmin', 'is_admin', 'subscription',
]);

export function validateToolCall({ toolName, params, isAdmin = false }) {
  if (toolName === TOOL_NAMES.EXECUTE_TURN) {
    if (!params || typeof params !== 'object' || Array.isArray(params)) {
      return { valid: false, errorCode: 'INVALID_PARAMETERS', error: 'El turno debe ser un objeto.' };
    }
    const forbidden = findForbiddenField(params);
    if (forbidden) {
      return { valid: false, errorCode: 'INVALID_PARAMETERS', error: `El modelo no puede definir el campo interno '${forbidden}'.` };
    }

    let normalizedParams;
    if (isTurnIntentV2(params)) {
      const v2Schema = structuredClone(TURN_INTENT_V2_SCHEMA);
      if (!isAdmin) {
        v2Schema.properties.actions.items.properties.domain.enum = v2Schema.properties.actions.items.properties.domain.enum
          .filter((domain) => domain !== 'admin');
      }
      const v2Error = validateAgainstSchema(params, v2Schema);
      if (v2Error) {
        return { valid: false, errorCode: 'INVALID_PARAMETERS', error: `TurnIntent v2 inválido: ${v2Error}.` };
      }
      const compiled = compileTurnIntentV2(params);
      if (!compiled.valid) return compiled;
      normalizedParams = compiled.manifest;
    } else {
      normalizedParams = Object.prototype.hasOwnProperty.call(params, 'excludedClauses')
        ? params
        : { ...params, excludedClauses: [] };
    }

    const schema = structuredClone(executeTurnDefinition.parameters);
    if (!isAdmin) schema.properties.operations.items.properties.kind.enum = publicOperationKinds.slice();
    const schemaError = validateAgainstSchema(normalizedParams, schema);
    if (schemaError) {
      return { valid: false, errorCode: 'INVALID_PARAMETERS', error: `Manifiesto compilado inválido: ${schemaError}.` };
    }
    return { valid: true, params: structuredClone(normalizedParams) };
  }

  if (!definitions[toolName] || (!isAdmin && toolName === TOOL_NAMES.ADMIN_METRICS)) {
    return { valid: false, errorCode: 'UNKNOWN_TOOL', error: `Herramienta no disponible: ${toolName}` };
  }
  if (!params || typeof params !== 'object' || Array.isArray(params)) {
    return { valid: false, errorCode: 'INVALID_PARAMETERS', error: 'Los argumentos de la herramienta deben ser un objeto.' };
  }
  const forbidden = findForbiddenField(params);
  if (forbidden) {
    return { valid: false, errorCode: 'INVALID_PARAMETERS', error: `El modelo no puede definir el campo interno '${forbidden}'.` };
  }

  const actionSchema = definitions[toolName].parameters.properties.action;
  if (actionSchema && (!params.action || !actionSchema.enum.includes(params.action))) {
    return { valid: false, errorCode: 'UNSUPPORTED_ACTION', error: `Acción no válida para ${toolName}.` };
  }

  const schemaError = validateAgainstSchema(params, definitions[toolName].parameters);
  if (schemaError) {
    return { valid: false, errorCode: 'INVALID_PARAMETERS', error: `Parámetros inválidos para ${toolName}: ${schemaError}.` };
  }
  return { valid: true, params: structuredClone(params) };
}

function findForbiddenField(value, seen = new WeakSet()) {
  if (!value || typeof value !== 'object') return null;
  if (seen.has(value)) return null;
  seen.add(value);
  for (const [key, nestedValue] of Object.entries(value)) {
    if (forbiddenIdentityFields.has(key)) return key;
    const nestedForbidden = findForbiddenField(nestedValue, seen);
    if (nestedForbidden) return nestedForbidden;
  }
  return null;
}

function validateAgainstSchema(value, schema, path = 'params') {
  if (!schema) return null;

  if (schema.type === 'object') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return `${path} debe ser un objeto`;
    for (const requiredKey of schema.required || []) {
      if (!Object.prototype.hasOwnProperty.call(value, requiredKey)) return `falta ${path}.${requiredKey}`;
    }
    if (schema.additionalProperties === false) {
      const unknownKey = Object.keys(value).find((key) => !Object.prototype.hasOwnProperty.call(schema.properties || {}, key));
      if (unknownKey) return `${path}.${unknownKey} no está permitido`;
    }
    for (const [key, nestedValue] of Object.entries(value)) {
      const nestedSchema = schema.properties?.[key];
      if (!nestedSchema || nestedValue === undefined) continue;
      const error = validateAgainstSchema(nestedValue, nestedSchema, `${path}.${key}`);
      if (error) return error;
    }
  } else if (schema.type === 'array') {
    if (!Array.isArray(value)) return `${path} debe ser una lista`;
    if (schema.minItems !== undefined && value.length < schema.minItems) return `${path} requiere al menos ${schema.minItems} elemento(s)`;
    if (schema.maxItems !== undefined && value.length > schema.maxItems) return `${path} permite máximo ${schema.maxItems} elemento(s)`;
    for (let index = 0; index < value.length; index += 1) {
      const error = validateAgainstSchema(value[index], schema.items, `${path}[${index}]`);
      if (error) return error;
    }
  } else if (schema.type === 'string' && typeof value !== 'string') {
    return `${path} debe ser texto`;
  } else if (schema.type === 'boolean' && typeof value !== 'boolean') {
    return `${path} debe ser booleano`;
  } else if (schema.type === 'number' && (typeof value !== 'number' || !Number.isFinite(value))) {
    return `${path} debe ser numérico`;
  } else if (schema.type === 'integer' && !Number.isInteger(value)) {
    return `${path} debe ser un entero`;
  }

  if (schema.enum && !schema.enum.includes(value)) return `${path} no tiene un valor permitido`;
  if (typeof value === 'number' && schema.minimum !== undefined && value < schema.minimum) return `${path} es menor que ${schema.minimum}`;
  if (typeof value === 'number' && schema.maximum !== undefined && value > schema.maximum) return `${path} es mayor que ${schema.maximum}`;
  return null;
}

export function parseToolArguments(rawArguments) {
  if (rawArguments && typeof rawArguments === 'object') return rawArguments;
  if (typeof rawArguments !== 'string' || !rawArguments.trim()) return {};
  try {
    const parsed = JSON.parse(rawArguments);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return null;
  }
}
