import { TOOL_NAMES } from './tool-names.js';

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
  description: 'Language-independent time of the primary reminder/event itself. The backend performs all calendar and timezone arithmetic. Never pre-subtract advanceMinutes from this schedule; advanceMinutes is a separate lead-time instruction.',
  properties: {
    kind: {
      type: 'string',
      enum: ['relative_offset', 'relative_day_time', 'calendar_date_time', 'weekday_time', 'local_time', 'inherit_context'],
      description: 'Use relative_offset only for an actual elapsed offset such as “in 10 minutes”; relative_day_time for tomorrow/day-after; weekday_time for a named weekday; calendar_date_time for an explicit calendar date; local_time for a clock with no day; inherit_context only when preserving the referenced item time.',
    },
    offsetMinutes: { type: 'integer', minimum: 1, maximum: 525600, description: 'Exact elapsed minutes stated by the user; never calculate this from a named day or calendar clock.' },
    dayOffset: { type: 'integer', minimum: 0, maximum: 365, description: 'Calendar-day distance stated by the user: today=0, tomorrow=1, day after tomorrow=2.' },
    year: { type: 'integer', minimum: 2020, maximum: 2200 },
    month: { type: 'integer', minimum: 1, maximum: 12 },
    day: { type: 'integer', minimum: 1, maximum: 31 },
    weekday: { type: 'string', enum: ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'] },
    weekOffset: { type: 'integer', minimum: 0, maximum: 52, description: 'Additional whole weeks after the nearest matching weekday. Use 0 unless the user explicitly says a later/next week occurrence.' },
    hour: { type: 'integer', minimum: 0, maximum: 23 },
    minute: { type: 'integer', minimum: 0, maximum: 59, description: 'Minute of the clock time. Use 0 when the user gives a whole hour such as “at three”.' },
    clockMode: {
      type: 'string',
      enum: ['explicit_24h', 'explicit_am', 'explicit_pm', 'ambiguous_12h'],
      description: 'Required whenever the schedule has hour/minute. Preserve how the user expressed the clock: explicit_am or explicit_pm for stated meridiem; explicit_24h only for an unmistakable 24-hour clock such as 20:00; ambiguous_12h for an unqualified 1-12 clock such as “a las 8”. With ambiguous_12h keep hour in 1-12 form; the backend selects the nearest occurrence that is still future on the requested local date.',
    },
  },
  required: ['kind'],
};

const contextRef = {
  type: 'object',
  additionalProperties: false,
  description: 'Typed reference to conversational state. Never copy an internal ID. An ordinal that matches a visible Working Memory position (for example “the second one”) is an exact, unambiguous reference to that position.',
  properties: {
    source: { type: 'string', enum: ['working_memory', 'pending_state', 'turn_operation'] },
    position: { type: 'integer', minimum: 1, maximum: 20, description: 'For turn_operation, this is the sequence number of an earlier operation in the same manifest.' },
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
    sequence: { type: 'integer', minimum: 1, maximum: 12, description: 'User-request order, starting at 1.' },
    kind: {
      type: 'string',
      enum: [...publicOperationKinds, 'admin_metrics'],
      description: 'Choose the domain from the meaning of the explicitly requested object, never from an exact phrase, keyword, spelling, or the mere presence of a date. A broad request about the user’s overall pending commitments or upcoming schedule that names no single domain uses one agenda_read with scope=upcoming. reminder_list is the only operation when the user asks specifically for WhatsApp reminders/alerts, even when filtered to today or another period. For an explicit request to remove every reminder whose scheduled time already passed, use one reminder_cancel with scope=elapsed and no target; its first execution only stages one backend confirmation. An ordinary mention of an appointment plus a request to be alerted is reminder_create unless the user explicitly says Google Calendar or calendar event; never infer Calendar merely from the existence of a date or appointment. task_list is the only operation for pending tasks, tasks inside a project/list, or determining which projects currently have active work; do not pair entity_list with it merely to discover active projects. An unequivocal statement that an identified pending task has already been done is a task_complete authorization even without imperative wording. entity_list is only the static catalog of projects/containers themselves, including empty or inactive containers. agenda_read is one time-bounded cross-domain read for a general schedule question or an explicit combination of domains; it already combines Google Calendar, reminders, and dated tasks, so never add reminder_list or task_list merely to enumerate those agenda components, and never use it for a single-domain reminder request or a project task inventory. An explicit request that the assistant remember or retain a fact/preference authorizes memory_save directly; emit one memory_save per independent durable fact and do not ask whether to save it. calendar_* means Google Calendar only and requires an explicit Calendar request; reminder_* means WhatsApp alerts only.',
    },
    sourceQuote: { type: 'string', description: 'Copy one contiguous verbatim substring from the current user message, including its original punctuation. Never paraphrase, join non-adjacent fragments, normalize spelling, add punctuation, or copy wording from history/memory. For memory_forget quote the current request to forget, not the remembered fact being removed. Inherited details belong in contextRef, not in this quote.' },
    contextRef,
    content: stringField('Required for reminder_create and memory_save. For memory_save, write the durable fact or preference itself in concise natural language; sourceQuote alone is only evidence and does not replace content.'),
    title: stringField('Task title or user-visible item title.'),
    description: stringField('Explicitly supplied description.'),
    entityName: stringField('User-facing project or list name.'),
    projectless: booleanField('For task_create only: true when the user explicitly wants the task outside every project/list. When true, omit entityName and never invent a container such as General.'),
    targetName: stringField('User-facing item or entity to change, cancel, complete, delete, search, or list.'),
    oldName: stringField('Current entity name for rename.'),
    newName: stringField('Replacement entity name.'),
    sourceName: stringField('Entity to merge away.'),
    category: {
      type: 'string',
      enum: ['person', 'company', 'project', 'place', 'pet', 'asset', 'other'],
      description: 'Entity category explicitly requested or implied by the named container type. For entity_list, “projects/proyectos” requires category=project so companies and contacts are not returned. Required for every entity_delete with scope=all so a category-specific request can never broaden to all entities.',
    },
    preserveNames: {
      type: 'array',
      maxItems: 20,
      items: { type: 'string' },
      description: 'Required whenever entity_delete uses scope=all. Include every exact user-facing name that must be kept, or [] only when the user gave no exception.',
    },
    priority: { type: 'string', enum: ['low', 'medium', 'high', 'urgent'] },
    status: { type: 'string', enum: ['pending', 'in_progress', 'completed', 'cancelled', 'all'], description: 'Task state explicitly requested. The ordinary word “pending/pendiente” means pending. Use in_progress only when the user explicitly distinguishes work already in progress.' },
    scope: stringField('Requested collection or semantic time scope. For reminder_cancel, elapsed means every non-cancelled reminder scheduled before the backend reference time and all means the full active collection. For agenda/calendar reads preserve relative periods as words such as today, tomorrow, this_week, or next_week; never convert a relative day into date.'),
    filter: { type: 'string', enum: ['upcoming', 'pending_today', 'remaining_today', 'created_today', 'completed_today'], description: 'For reminder_list only. upcoming means every reminder still awaiting future delivery; it never means sent, missed, failed, cancelled, or elapsed history.' },
    query: stringField('Explicit search or semantic filter. Required for memory_search and memory_forget; summarize the requested subject from the current message rather than copying old memory text.'),
    date: stringField('YYYY-MM-DD only when the user explicitly supplied that calendar date. Never calculate this field from today, tomorrow, a weekday, or another relative expression.'),
    dateFrom: stringField('Explicit range start.'),
    dateTo: stringField('Explicit range end.'),
    schedule: typedSchedule,
    endSchedule: typedSchedule,
    advanceMinutes: { type: 'integer', minimum: 1, maximum: 10080, description: 'Lead time before the primary schedule. Keep schedule at the main reminder/event time; the backend subtracts this value and creates the related notice.' },
    recurrence: stringField('Recurrence explicitly requested by the user.'),
    requiresConfirmation: booleanField('Whether the user explicitly asked Hermes to keep checking until they confirm completion. This is unrelated to an advance notice before an appointment.'),
    nudgeIntervalMinutes: {
      type: 'integer',
      minimum: 1,
      maximum: 10080,
      description: 'Interval between repeated follow-up checks after a reminder when requiresConfirmation=true. Never use this for “avísame N minutos antes”; that is advanceMinutes.',
    },
    maxNudges: {
      type: 'integer',
      minimum: 1,
      maximum: 100,
      description: 'Maximum number of repeated follow-up checks after the reminder. Only valid when requiresConfirmation=true; never represents advance notices.',
    },
    durationMinutes: { type: 'integer', minimum: 1, maximum: 10080 },
    addGoogleMeet: booleanField('Whether a Google Meet link was explicitly requested.'),
    limit: { type: 'integer', minimum: 1, maximum: 50 },
    clarificationKind: {
      type: 'string',
      enum: ['reminder_schedule', 'generic'],
      description: 'For clarification_request. Use reminder_schedule whenever a reminder/appointment lacks required scheduling data; the application renders the localized question. Use generic only for other genuinely ambiguous operations.',
    },
    missingFields: {
      type: 'array',
      uniqueItems: true,
      maxItems: 2,
      items: { type: 'string', enum: ['main_time', 'advance_minutes'] },
      description: 'For reminder_schedule clarification. main_time is the missing primary clock. advance_minutes is included only when the user explicitly requested advance notice without its amount; optional preferences are not missing fields.',
    },
    question: stringField('One concise clarification question only when clarificationKind=generic. For reminder_schedule omit this field because the application renders it. Never ask for permission to perform an explicitly requested safe read.'),
  },
  required: ['sequence', 'kind', 'sourceQuote'],
};

const executeTurnDefinition = {
  description: 'Execute the complete in-scope action delta authorized by the current user message. Send one ordered manifest and include every independent read or mutation exactly once. Do not call this tool for social conversation, acknowledgments, emotional support, conversation closes, or a wholly out-of-scope request. Never replay resources from history or Working Memory. Put prohibited, hypothetical, superseded, contextual, or out-of-scope clauses in excludedClauses when they coexist with valid operations. Correct existing resources in place using contextRef; never delete and recreate them. Every sourceQuote must be one contiguous verbatim substring of the current message. Use typed schedule fields and keep schedule at the primary time; advanceMinutes is separate. A same-turn WhatsApp advance notice for a new Google Calendar event belongs as advanceMinutes on that calendar_create; do not emit a second reminder_create and do not pre-subtract the minutes. A same-turn advance notice belongs on its reminder_create/calendar_create, while reminder_add_advance is only for an earlier existing reminder. If scheduling data is missing, use clarification_request with clarificationKind=reminder_schedule and missingFields; do not author the question or mix languages. An explicit bulk cleanup of reminders already in the past is reminder_cancel with scope=elapsed; the backend stages its confirmation. Each pending proposal gets exactly one transition; after the user confirms, emit execute_pending rather than repeating the original operation or asking again. revise_pending already executes the revision. The backend validates identity, permissions, time arithmetic, confirmation requirements, and final results.',
  parameters: {
    type: 'object',
    additionalProperties: false,
    properties: {
      operations: { type: 'array', minItems: 1, maxItems: 12, items: turnOperation },
      excludedClauses: {
        type: 'array',
        maxItems: 12,
        description: 'Current-message clauses intentionally not executed. Include an out-of-scope clause here only when the same message also contains at least one valid operation; wholly out-of-scope turns should receive a natural prose refusal without this tool.',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            sourceQuote: stringField('Exact words from the current user message.'),
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
    sourceTimeText: stringField('Copy the exact words from the current user message that express this item’s time, for example "en 10 minutos" or "a las 4 de la tarde". Never invent or rewrite this evidence.'),
    recurrence: stringField('Recurrence stated by the user, such as daily or weekly. Omit when not requested.'),
    requiresConfirmation: booleanField('Whether Hermes should keep nudging until the user acknowledges completion.'),
    nudgeIntervalMinutes: numberField('Minutes between confirmation nudges, only when explicitly requested.'),
    maxNudges: numberField('Maximum confirmation nudges, only when explicitly requested.'),
    advanceMinutes: {
      type: 'integer',
      minimum: 1,
      maximum: 10080,
      description: 'Lead time explicitly requested for an additional notice before a separate primary appointment/reminder time. Never use this for "recuérdame en N minutos". Keep targetTime as the primary time; never move targetTime backward. The backend will create both the advance notice at targetTime minus advanceMinutes and the main reminder at targetTime.',
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
    priority: {
      type: 'string',
      enum: ['low', 'medium', 'high', 'urgent'],
      description: 'Priority explicitly stated or strongly implied by the user. Omit otherwise.',
    },
    entityName: stringField('User-facing project or list name. Never use an internal ID.'),
    entityCategory: stringField('Category of the project/list when the user explicitly identifies it.'),
  },
  required: ['title'],
};

const definitions = {
  [TOOL_NAMES.GET_UNIFIED_AGENDA]: {
    description: 'Read the user’s cross-domain agenda (Google Calendar, reminders, and dated tasks) for a requested period. A generic question such as “what do I have pending?” uses this operation with scope=upcoming because it does not name one domain. This single read already covers all three sources; do not pair it with reminder_list or task_list just because the request names those sources. Use for general questions such as what is scheduled or pending on a date. Do not use when the user explicitly asks only about Google Calendar, only reminders, or only tasks.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        scope: {
          type: 'string',
          enum: ['today', 'remaining_today', 'tomorrow', 'day_after_tomorrow', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday', 'this_week', 'next_week', 'this_weekend', 'upcoming', 'month', 'full_year', 'explicit_date', 'explicit_range'],
          description: 'Time period requested by the user.',
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
    description: 'Create, update, cancel, acknowledge, or list WhatsApp reminders. A reminder is a notification at a specific time; it is not a project task or a Google Calendar event. Understand temporal language in any user language, but normalize targetTime into the canonical ISO contract: relative durations such as PT10M or absolute ISO date/times. Only when the user gives a separate primary time and asks for advance notice, send one create item with that primary targetTime plus advanceMinutes; the backend expands it into both reminders. For mutations, pass the user-facing target or Working Memory ordinal and let the backend resolve ownership and identity. Bulk cancellation uses scope=elapsed for all reminders whose scheduled time already passed, or scope=all for every active reminder; the backend always requests one separate confirmation before changing them.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: { type: 'string', enum: ['create', 'update', 'cancel', 'acknowledge', 'list'] },
        items: { type: 'array', minItems: 1, items: reminderItem, description: 'Reminders to create. Use only with action=create.' },
        ...targetFields,
        filter: { type: 'string', enum: ['upcoming', 'pending_today', 'remaining_today', 'created_today', 'completed_today'], description: 'List filter that matches the user’s explicit request. upcoming means all reminders that are still awaiting future delivery, not historical reminders.' },
        updates: {
          type: 'object',
          additionalProperties: false,
          properties: {
            content: stringField('Replacement reminder content explicitly requested.'),
            targetTime: canonicalDateTimeField('Replacement date/time explicitly requested.'),
            recurrence: stringField('Replacement recurrence explicitly requested.'),
          },
        },
        advanceMinutes: { type: 'integer', minimum: 1, maximum: 10080, description: 'Create an additional advance notice for the referenced existing reminder without replacing it.' },
      },
      required: ['action'],
    },
  },
  [TOOL_NAMES.MANAGE_TASK]: {
    description: 'Create, update, complete, delete, or list tasks, including tasks inside existing projects/lists. Tasks are actionable work items; they are not timed WhatsApp reminders or Google Calendar events. Use entityName for a user-facing project/list and target for one item or a Working Memory reference.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: { type: 'string', enum: ['create', 'update', 'complete', 'delete', 'list'] },
        items: { type: 'array', minItems: 1, items: taskItem, description: 'Tasks to create. Use only with action=create.' },
        ...targetFields,
        entityName: stringField('User-facing project/list name. Use with scope=all only when the user means the whole container.'),
        status: { type: 'string', enum: ['pending', 'in_progress', 'completed', 'cancelled', 'all'] },
        updates: {
          type: 'object',
          additionalProperties: false,
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
      type: 'object',
      additionalProperties: false,
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
    description: 'Save, search, list, or forget durable long-term personal context. Do not use for tasks, reminders, calendar events, temporary conversational state, or ordinary questions that can be answered from supplied context.',
    parameters: {
      type: 'object',
      additionalProperties: false,
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
    description: 'Manage user-visible projects, lists, contacts, companies, places, or other named containers. Do not call merely because a task mentions a project; manage_task can resolve or create its container. Every scope=all deletion requires category and preserveNames. The backend stages deletion and requires a separate conversational confirmation before mutating data.',
    parameters: {
      type: 'object',
      additionalProperties: false,
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
    description: 'Get the user’s subscription status or checkout link, or cancel the active subscription. Use only for Hermes subscription requests, never for a task whose text happens to mention a subscription.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: { type: 'string', enum: ['get_link', 'status', 'cancel'] },
      },
      required: ['action'],
    },
  },
  [TOOL_NAMES.ADMIN_METRICS]: {
    description: 'Read Hermes administrative metrics. Available only to verified administrators.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: { type: 'string', enum: ['get_overview', 'get_active_subscriptions', 'get_user_count'] },
      },
      required: ['action'],
    },
  },
};

export function getToolDefinitions({ isAdmin = false } = {}) {
  return Object.entries(definitions)
    .filter(([name]) => isAdmin || name !== TOOL_NAMES.ADMIN_METRICS)
    .map(([name, contract]) => {
      const parameters = structuredClone(contract.parameters);
      // Native provider calls must carry user-text evidence for temporal
      // provenance. The internal validator keeps it optional so legacy direct
      // callers can migrate without weakening the production provider schema.
      if (name === TOOL_NAMES.MANAGE_REMINDER) {
        const required = parameters.properties?.items?.items?.required || [];
        parameters.properties.items.items.required = [...new Set([...required, 'sourceTimeText'])];
      }
      return {
        type: 'function',
        function: { name, description: contract.description, parameters },
      };
    });
}

export function getAgentToolDefinitions({ isAdmin = false } = {}) {
  const parameters = structuredClone(executeTurnDefinition.parameters);
  if (!isAdmin) {
    parameters.properties.operations.items.properties.kind.enum = publicOperationKinds.slice();
  }
  return [{
    type: 'function',
    function: {
      name: TOOL_NAMES.EXECUTE_TURN,
      description: executeTurnDefinition.description,
      parameters,
    },
  }];
}

const forbiddenIdentityFields = new Set([
  'userId', 'user_id', 'phoneNumber', 'phone_number', 'isPro', 'isAdmin', 'is_admin', 'subscription',
]);

export function validateToolCall({ toolName, params, isAdmin = false }) {
  if (toolName === TOOL_NAMES.EXECUTE_TURN) {
    if (!params || typeof params !== 'object' || Array.isArray(params)) {
      return { valid: false, errorCode: 'INVALID_PARAMETERS', error: 'El manifiesto del turno debe ser un objeto.' };
    }
    const forbidden = findForbiddenField(params);
    if (forbidden) {
      return { valid: false, errorCode: 'INVALID_PARAMETERS', error: `El modelo no puede definir el campo interno '${forbidden}'.` };
    }
    // The native provider schema requires an explicit coverage decision. Keep
    // older trusted/internal callers compatible by normalizing omission to an
    // empty list at the application boundary.
    const normalizedParams = Object.prototype.hasOwnProperty.call(params, 'excludedClauses')
      ? params
      : { ...params, excludedClauses: [] };
    const schema = structuredClone(executeTurnDefinition.parameters);
    if (!isAdmin) schema.properties.operations.items.properties.kind.enum = publicOperationKinds.slice();
    const schemaError = validateAgainstSchema(normalizedParams, schema);
    if (schemaError) {
      return { valid: false, errorCode: 'INVALID_PARAMETERS', error: `Manifiesto inválido: ${schemaError}.` };
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
  } else if (schema.type === 'integer' && (!Number.isInteger(value))) {
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
