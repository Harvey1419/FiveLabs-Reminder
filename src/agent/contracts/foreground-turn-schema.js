import {
  TURN_INTENT_SCHEMA,
  getCanonicalOperations,
  parseCanonicalOperation,
} from './intent-contracts.js';

// Provider-only projection: the canonical schema and deterministic action
// prerequisites remain authoritative. Avoid polymorphic object unions, whose
// compilation/generation was rejected by the actual Groq endpoint.
export function strictProviderSchema(schema) {
  const node = structuredClone(schema);
  delete node.uniqueItems;
  if (node.items) node.items = strictProviderSchema(node.items);
  if (node.properties) {
    const required = new Set(node.required || []);
    node.properties = Object.fromEntries(Object.entries(node.properties).map(([key, value]) => {
      const converted = strictProviderSchema(value);
      if (!required.has(key)) {
        converted.type = [converted.type, 'null'];
        if (converted.enum) converted.enum = [...converted.enum, null];
      }
      return [key, converted];
    }));
    node.required = Object.keys(node.properties);
    node.additionalProperties = false;
  }
  return node;
}

export function getStructuredTurnSchema({ isAdmin = false, attachmentOnly = false } = {}) {
  const schema = structuredClone(TURN_INTENT_SCHEMA);
  schema.required = [...schema.required, 'responseLanguage', 'responseCapability', 'learningCandidates'];
  // Provider prose only: every field obligation remains local, except language
  // precedence/voice already stated in full in the initial system message.
  // See docs/agent/groq-contract-evaluation.md for the rule-to-surface map.
  schema.properties.responseLanguage.description = 'Language for the entire response, including cards/questions; follow the system language precedence and Spanish voice.';
  schema.properties.answerFromResults.description = 'True for interpretation/calculation/comparison needing live reads: emit those reads, then Hermes answers from results. For listings/simple returnFields/mutations leave false/null; a single task.list returnFields projection takes precedence over redundant true. For complex interpretation keep returnFields absent.';
  schema.properties.knowledgeRefs.description = 'Turn RESPONSE metadata, not tool actions: select supplied pk_ refs from memory hints for mixed tasks/personal recall. Add recorded personal quotations, never fresh operational state, to cards/fields/historical summaries. Inventories need no answerFromResults for recall. Only reads/conversation; no mutations or guessed refs. Personal chat may use content without refs.';
  // Whole-turn contrast: answering the task clause must not erase independent
  // durable metadata. These are field excerpts, not complete wire objects.
  schema.properties.learningCandidates.description = 'CURRENT user ONLY: all useful durable facts, 0–3 usual; [] NEVER null. No assistant/history/attachments. Exact contiguous quote≠sufficient: full-turn quotes/denial/correction/attribution. No tasks/appointments/transient actions/debts/balances/greetings/temporary states; keep mixed facts with memory.save. Atomic compact Spanish. Lasting language/style yes, utterance/one-turn no; denial≠opposite. Changed reuse topicKey; unchanged omit. New stable value-independent keys: self identity/residence/work profile/<aspect>; lasting preference preference/<aspect>; else <entity_type>/<slug>/<aspect>. Clean canonical hints optional; pet≠physical write. Node independently admits. English always + status: profileUpdate={sourceQuote:"English always",language:en}, learningCandidates=[{topicKey:preference/language,category:preference,content:"Prefiere inglés.",evidence:"English always"}], task.list(status=all). Quoted/one-turn: profileUpdate=null; learningCandidates=[]; read.';
  const action = schema.properties.actions.items;
  const domains = attachmentOnly
    ? ['conversation']
    : action.properties.domain.enum.filter((domain) => isAdmin || domain !== 'admin');

  // Groq rejects the polymorphic unions needed to condition action on domain.
  // A single qualified enum preserves that relationship without a union or a
  // Cartesian product. Node projects it back to canonical domain/action below.
  const { domain: _domain, action: _action, ...sharedProperties } = action.properties;
  if (attachmentOnly) {
    schema.properties.responseCapability.enum = ['general'];
    action.properties = {
      operation: {
        type: 'string',
        enum: ['conversation.reply'],
        description: 'Exact qualified canonical operation. Domain/action are inseparable. For attachment-only evidence, use conversation.reply.',
      },
      content: sharedProperties.content,
    };
    action.required = ['operation'];
    return strictProviderSchema(schema);
  }
  action.properties = {
    operation: {
      type: 'string',
      enum: getCanonicalOperations({ domains }),
      description: 'Exact qualified canonical operation. Domain/action are inseparable. A request for current operational content or status requires the matching live read (for example task.list), never conversation.reply.',
    },
    ...sharedProperties,
  };
  action.required = ['operation'];
  const descriptions = {
    contextRef: 'Select an existing reminder/task/calendar event displayed in Working Memory by position, time, recurrence or title. contextRef is the sole operative identity; omit target; redundant labels ignored by Node.',
    target: 'Human reference to an EXISTING item, never internal IDs. Required for existing-object mutations without contextRef, except reminder.acknowledge with one authoritative active follow-up bound by Node. With contextRef omit target; redundant labels ignored. entity.delete: project/list name; deleting a project deletes all its tasks in cascade; never scope="all" for one project.',
    entityName: 'entity.create/upsert: own name. task.list/create: implicit/explicit container name (e.g. "Demo project", "reminder", "trabajo"), even a system domain name. task.complete/update/delete: include the owning named container to prevent duplicate titles crossing containers.',
    category: 'entity.create/upsert: person/company/project/place/asset/other only; omitted=other; pet is not a physical write category. project=task container. Memory fact/preference/decision/episode/observation belongs in memory.save, not entity fields.',
    projectless: 'task.create: true only with no named grouping or shared purpose. Grouped implicit/explicit purpose requires entityName, even without the words list/project; never projectless=true.',
    evidenceRefs: 'conversation.reply or historical recap: select supplied operational refs when displaying past results. Content with refs is discarded, not verified prose; Node renders owned historical proof, not fresh state. Personal recall: TURN knowledgeRefs or natural content without operational refs. No additional actions.',
    returnFields: 'task.list only: select for simple actual status/date/notes questions on returned rows; Node renders fields (null=absent, missing=unknown). Keep query/entityName/status/date filters. Single task read: projection takes precedence over answerFromResults. No ordinal identity or calculations; complex interpretation: returnFields absent, answerFromResults.',
    query: 'Title/memory text filter. For task.list by title/ordinal (e.g. "Second task"), put target in query. reminder.list: literal case-insensitive content, 1–200 trimmed characters, no * or NUL; never dates/times. Dated agenda/reminder/task/calendar reads: schedule with calendar_date_time and allDay=true; query dates do not restrict the window.',
    recurrence: 'daily|weekdays|weekly|monthly|yearly|hourly. Sub-daily: hourly:N = every N hours (hourly:6 = every 6 hours); interval:Xm / interval:Xh = every X minutes/hours. Plain hourly means exactly every 1 hour only.',
    advanceMinutes: 'Advance offset in minutes. Calendar notification offset; reminders prefer deliveryPolicy: desired state, not a separate action.',
    deliveryPolicy: 'Reminder desired delivery state: only when explicitly requested/changed by the user or to preserve known state. Never invent advance notice.',
  };
  for (const [field, description] of Object.entries(descriptions)) action.properties[field].description = description;
  action.properties.schedule.description += ' A complete reminder.create needs a usable schedule. If part is missing, keep known components on the partial action, declare missingFields and put the clarification question on that action; at most one clarification.request may accompany the incomplete draft. Each action retains its own known date/time components.';
  action.properties.schedule.properties.dayOffset.description = 'Number of local calendar days from the current message date: 0=today, 1=tomorrow, 2=day after tomorrow. When a day is shared by multiple requests, repeat that dayOffset in every applicable schedule; never reset it to 0 merely because the day appears in a preceding clause.';
  action.properties.schedule.properties.offsetMinutes.description = 'Duration from now, only for relative_offset. For every other kind use null. Do not compute a duration instead of preserving the requested calendar day and clock time.';
  for (const field of ['schedule', 'endSchedule']) {
    // Explicit 12h and 24h clocks are semantically equivalent. Ask Hermes for
    // one canonical representation instead of letting the provider mix them.
    // Ambiguous clocks remain ambiguous; Node never guesses AM/PM here.
    action.properties[field].properties.clockMode = {
      type: 'string', enum: ['explicit_24h', 'ambiguous_12h'],
      description: 'For an explicit AM/PM or 24h time, output hour 0..23 and explicit_24h (3 PM = 15, noon = 12, midnight = 0). For a genuinely ambiguous 12h time keep hour 1..12 and ambiguous_12h. Do not invent AM/PM.',
    };
  }
  // Shared temporal instructions are stated once, on schedule. endSchedule
  // keeps every field/enum/bound and references exactly the same semantics.
  // structuredClone preserves schedule/endSchedule's shared canonical node;
  // detach before changing descriptions so schedule keeps the actual guidance.
  action.properties.endSchedule = structuredClone(action.properties.endSchedule);
  action.properties.endSchedule.description = 'End time; use the same temporal field semantics as schedule.';
  for (const field of ['kind', 'allDay', 'clockMode', 'dayOffset', 'offsetMinutes']) {
    action.properties.endSchedule.properties[field].description = `Same semantics as schedule.${field}.`;
  }
  return strictProviderSchema(schema);
}

export function stripStructuredNulls(value) {
  if (Array.isArray(value)) return value.map(stripStructuredNulls);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value)
    .filter(([key, child]) => child !== null || key === 'learningCandidates')
    .map(([key, child]) => [key, stripStructuredNulls(child)]));
}

/** Convert the provider-only qualified operation into canonical TurnIntent. */
export function projectStructuredTurnIntent(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !Array.isArray(value.actions)) return value;
  const guardedValue = {
    ...value,
  };
  if (guardedValue.profileUpdate && typeof guardedValue.profileUpdate === 'object') {
    if (!guardedValue.profileUpdate.sourceQuote && !guardedValue.profileUpdate.language) {
      delete guardedValue.profileUpdate;
    }
  }
  let actions = guardedValue.actions;
  if (actions.length > 1) {
    const hasOperational = actions.some(item => {
      const op = String(item?.operation || '').toLowerCase();
      return op && op !== 'conversation.reply' && op !== 'conversation.recap';
    });
    if (hasOperational) {
      actions = actions.filter(item => {
        const op = String(item?.operation || '').toLowerCase();
        if (op === 'conversation.reply') {
          const hasContent = typeof item.content === 'string' && item.content.trim().length > 0;
          const hasEvidence = Array.isArray(item.evidenceRefs) && item.evidenceRefs.length > 0;
          return hasContent || hasEvidence;
        }
        return true;
      });
    }
  }
  return {
    ...guardedValue,
    actions: actions.map((item) => {
      if (!item || typeof item !== 'object' || Array.isArray(item) || item.operation === undefined) return item;
      const operation = String(item.operation || '').trim().toLowerCase();
      const parts = operation.split('.');
      // Known operations use the registry. Unknown but structurally qualified
      // values are still split so canonical validation can reject the exact
      // domain/action pair; no natural-language interpretation occurs here.
      const parsed = parseCanonicalOperation(operation)
        || (parts.length === 2 && parts.every(Boolean) ? { domain: parts[0], action: parts[1] } : null);
      if (!parsed) return { ...item };
      const { operation: _operation, ...fields } = item;
      if (parsed?.domain !== 'task' || parsed?.action !== 'list') {
        delete fields.returnFields;
      } else if (!fields.status && (fields.filter === 'pending_today' || fields.filter === 'pending')) {
        fields.status = 'pending';
      }
      if (parsed?.domain !== 'conversation' || parsed?.action !== 'recap') {
        delete fields.recapMode;
      }
      if (parsed?.domain === 'task' && (parsed?.action === 'update' || parsed?.action === 'rename')) {
        if (!fields.target && fields.oldName) fields.target = fields.oldName;
        if (fields.title && !fields.newName) fields.newName = fields.title;
        if (fields.newName && !fields.title) fields.title = fields.newName;
      }
      if (parsed?.domain !== 'conversation' || (parsed?.action !== 'reply' && parsed?.action !== 'recap')) {
        delete fields.evidenceRefs;
      } else if (Array.isArray(fields.evidenceRefs) && fields.evidenceRefs.length === 0) {
        delete fields.evidenceRefs;
      }

      if (fields.schedule && typeof fields.schedule === 'object') {
        const hasAnyScheduleVal = Object.entries(fields.schedule).some(([k, v]) => k !== 'kind' && v != null);
        if (!hasAnyScheduleVal) {
          delete fields.schedule;
        }
      }
      if (fields.endSchedule && typeof fields.endSchedule === 'object') {
        const hasAnyScheduleVal = Object.entries(fields.endSchedule).some(([k, v]) => k !== 'kind' && v != null);
        if (!hasAnyScheduleVal) {
          delete fields.endSchedule;
        }
      }
      if (parsed?.domain === 'reminder' && parsed?.action === 'create' && fields.schedule && fields.schedule.allDay === true && fields.schedule.hour == null) {
        delete fields.schedule.allDay;
        const missing = new Set(Array.isArray(fields.missingFields) ? fields.missingFields : []);
        missing.add('time');
        fields.missingFields = [...missing];
      }
      if (parsed?.domain === 'reminder' && parsed?.action === 'create' && fields.schedule?.clockMode === 'ambiguous_12h') {
        const missing = new Set(Array.isArray(fields.missingFields) ? fields.missingFields : []);
        missing.add('time');
        fields.missingFields = [...missing];
      }
      if (parsed?.domain === 'memory' && parsed?.action === 'save' && !fields.category) {
        fields.category = 'fact';
      }
      return { ...fields, ...parsed };
    }),
  };
}
