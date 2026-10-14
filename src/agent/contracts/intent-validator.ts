import { isCalendarLookupDate } from '../../shared/calendar-lookup-date.js';
import type { ValidatedTurnContext } from './turn-context-contract.js';
import type { LearningCandidate } from './learning-candidates-contract.js';
import { LEARNING_CANDIDATES_SCHEMA as learningCandidatesSchema,validLearningCandidates as validateLearningCandidates } from './learning-candidates-contract.js';
import { PERSONAL_READ_OPERATIONS } from '../orchestration/personal-knowledge-core.js';
import { TURN_CONTEXT_PROPERTIES, validateTurnContext } from './turn-context-contract.js';
import { TOOL_NAMES } from './tool-names-contract.js';
import { AGENDA_SCOPES } from '../../shared/agenda-scope-contract.js';
import { ENTITY_WRITE_CATEGORIES } from '../../shared/entity-categories-contract.js';
import { isStrictUUID } from '../../shared/entity-reference-contract.js';
export interface ValidatedAction extends Record<string,unknown> { domain: string; action: string }
export interface ValidatedIntent extends ValidatedTurnContext { actions: ValidatedAction[]; excluded: unknown[];
  learningCandidates?: LearningCandidate[]; learningCandidatesProvided?: true; responseCapability?: unknown; answerFromResults?: unknown; knowledgeRefs?: string[] }
export type IntentValidation = { valid: true; intent: ValidatedIntent } | { valid: false; errorCode: string; error: string };
function object(value: unknown): value is Record<string,unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function includesValue(values: readonly unknown[],value: unknown): boolean { return values.includes(value); }

const DOMAINS = Object.freeze([
  'conversation', 'agenda', 'reminder', 'task', 'project', 'entity', 'calendar', 'memory', 'subscription', 'clarification', 'admin',
]);
// Core named recurrence rules. The scheduler also accepts interval extensions:
//   "hourly:N"   — every N hours (e.g. "hourly:6" = every 6 hours)
//   "interval:Xm" — every X minutes (e.g. "interval:30m")
//   "interval:Xh" — every X hours (e.g. "interval:6h")
// These are validated separately via RECURRENCE_INTERVAL_RE below.
const RECURRENCES = Object.freeze(['daily', 'weekdays', 'weekly', 'monthly', 'yearly', 'hourly']);
const RECURRENCE_INTERVAL_RE = /^(hourly:\d+|interval:\d+[mh])$/;
const MISSING_FIELDS = Object.freeze([
  'content', 'target', 'selection', 'scope', 'schedule', 'date', 'time', 'main_time', 'advance_minutes',
]);

const DOMAIN_ACTIONS: Readonly<Record<string,ReadonlySet<string>>> = Object.freeze({
  conversation: new Set(['reply', 'recap']),
  agenda: new Set(['read']),
  reminder: new Set(['create', 'update', 'cancel', 'acknowledge', 'list', 'add_advance']),
  task: new Set(['create', 'update', 'complete', 'delete', 'list']),
  project: new Set(['create', 'upsert', 'rename', 'delete', 'list']),
  entity: new Set(['create', 'upsert', 'rename', 'merge', 'delete', 'deduplicate', 'list']),
  calendar: new Set(['create', 'update', 'delete', 'list', 'search', 'next', 'connect', 'disconnect']),
  memory: new Set(['save', 'search', 'list', 'forget']),
  subscription: new Set(['info', 'link', 'status', 'cancel']),
  clarification: new Set(['request']),
  admin: new Set(['metrics']),
});

const STRUCTURAL_ACTION_ALIASES: Readonly<Record<string,Readonly<Record<string,string>>>> = Object.freeze({
  reminder: Object.freeze({ delete: 'cancel' }),
});

function qualifyOperation(domain: string,action: string) { return `${domain}.${action}`; }

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
    allDay: { type: 'boolean', description: 'True for full-day calendar events, whole-day deadlines or dates without an explicit clock time (e.g. birthdays, holidays, all-day meetings).' },
    offsetMinutes: { type: 'integer', minimum: 0, maximum: 525600 },
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

export const actionSchema = {
  type: 'object', additionalProperties: false,
  properties: {
    domain: { type: 'string', enum: DOMAINS },
    action: { type: 'string' },
    contextRef: {
      type: 'object', additionalProperties: false,
      description: 'For an existing reminder, task or calendar event shown in Working Memory, use its contextRef when the user identifies it by position, time, recurrence or title. The model selects the displayed item; contextRef is the sole operative identity. Omit target when selected; Node ignores any redundant target label.',
      properties: { source: { type: 'string', enum: ['working_memory'] }, position: { type: 'integer', minimum: 1, maximum: 100 } },
      required: ['source', 'position'],
    },
    target: { type: 'string', description: 'Human reference to an EXISTING item, never an internal ID. Required by existing-object mutations without contextRef, except reminder.acknowledge when Node can bind one authoritative active follow-up. With contextRef, omit target; any redundant label is ignored. For entity.delete, the project or list name to delete (deleting a project automatically deletes all its tasks in cascade; never use scope="all" for one project).' },
    content: { type: 'string', description: 'Natural reply, create content, or requested update delta; never existing-object identity.' },
    title: { type: 'string', description: 'One actionable task/event title, not the name of its containing project.' }, description: { type: 'string' },
    descriptionMode: { type: 'string', enum: ['append', 'replace'], description: 'task.update ONLY: append preserves notes; replace overwrites; clearFields removes. task.create: null/omit, even with description.' },
    clearFields: { type: 'array', uniqueItems: true, maxItems: 3, items: { type: 'string', enum: ['description', 'dueDate', 'recurrence'] }, description: 'Explicit clear intent for supported update fields. Task supports description/dueDate; reminder supports recurrence; calendar supports description/recurrence.' },
    entityName: { type: 'string', description: 'Entity name. For entity.create/upsert, its own name. For task actions (task.list, task.create), the explicit or implicit container/project name (e.g. "reminder", "trabajo"), even if it shares a name with a system domain. For task.complete/update/delete, include the owning container whenever the target belongs to a named project, so duplicate titles cannot cross containers.' }, oldName: { type: 'string' }, newName: { type: 'string' }, sourceName: { type: 'string' },
    category: { type: 'string', enum: ['person', 'company', 'project', 'place', 'pet', 'asset', 'other', 'fact', 'preference', 'decision', 'episode', 'observation'], description: 'entity.create/upsert: person/company/project/place/asset/other only; omitted=other; pet is not a physical write category. project is a task container. Memory fact/preference/decision/episode/observation uses memory.save, not entity fields.' },
    topicKey: { type: 'string' }, priority: { type: 'string', enum: ['low', 'medium', 'high', 'urgent'] },
    status: { type: 'string', enum: ['pending', 'in_progress', 'completed', 'cancelled', 'all'], description: 'Required for task.list. Explicit model-selected status; all preserves both states for unfiltered reads. Dated all uses due dates, not completion dates.' },
    recapMode: { type: 'string', enum: ['historical', 'current'], description: 'historical: renders recorded evidence; evidenceRefs optionally narrows it. current: explicit reads, content=null.' },
    evidenceRefs: { type: 'array', minItems: 1, maxItems: 8, uniqueItems: true, items: { type: 'string', minLength: 36, maxLength: 36 }, description: 'conversation.reply or historical recap: select supplied operational evidence refs. Content with refs is discarded, never verified prose; Node renders owned historical proof, not fresh state. Personal recall uses TURN knowledgeRefs or natural content without operational refs. No additional actions.' },
    returnFields: { type: 'array', minItems: 1, maxItems: 5, uniqueItems: true, items: { type: 'string', enum: ['description', 'status', 'due_date', 'completed_at', 'priority'] }, description: 'task.list only: select for simple actual status/date/notes questions on returned rows; Node renders actual fields (null=absent, missing=unknown). Keep query, entityName, status and date filters. This explicit typed projection takes precedence over answerFromResults for a single task read. No ordinal identity or calculations; for complex interpretation leave returnFields absent and use answerFromResults.' },
    scope: { type: 'string', description: `For entity.delete / project.delete: "all" deletes EVERY project/entity across the user account; "no_tasks" deletes only projects that have zero tasks. For single projects, leave scope null/omitted. subscription.info: plan ONLY for Pro benefits or how to subscribe (not payment failures, refunds, prices/methods or explicit checkout prohibition); otherwise omit. Agenda, task, and reminder scopes include: ${AGENDA_SCOPES.join(', ')}. Calendar.update: scope=YYYY-MM-DD selects the original event by local lookup date; schedule changes its start. Never combine dated lookup with contextRef.` },
    filter: { type: 'string', enum: ['upcoming', 'pending_today', 'remaining_today', 'created_today', 'completed_today', 'tomorrow', 'day_after_tomorrow', 'this_week', 'next_week'] },
    query: { type: 'string', description: 'Text filter for titles or memory content; reminder.list searches literal case-insensitive content (1–200 trimmed characters, no * or NUL), never dates or times. For any dated read (agenda, reminders, tasks, calendar), put the date in schedule using calendar_date_time and allDay=true; a date string in query does not restrict the date window.' }, projectless: { type: 'boolean', description: 'For task.create, true only when there is no named grouping or shared purpose. Never true for actionable items grouped under an implicit or explicit purpose/container, even if the user never says list or project; provide entityName instead.' },
    preserveNames: { type: 'array', maxItems: 20, items: { type: 'string' } },
    schedule: typedSchedule, endSchedule: typedSchedule,
    advanceMinutes: { type: 'integer', minimum: 1, maximum: 10080, description: 'Advance offset in minutes. For calendar actions this is the event notification offset. For reminders prefer deliveryPolicy so delivery behavior is represented as desired state, not a separate action.' },
    deliveryPolicy: {
      type: 'object',
      additionalProperties: false,
      description: 'Desired delivery state for a reminder. Use only when the user explicitly changes or requests delivery behavior, or when preserving an already-known state. Never invent an advance notice.',
      properties: {
        advanceNotice: { type: 'string', enum: ['none', 'offset'], description: 'none = no advance notice; offset = one advance notice before the primary reminder.' },
        advanceMinutes: { type: 'integer', minimum: 1, maximum: 10080, description: 'Required only when advanceNotice=offset.' },
      },
      required: ['advanceNotice'],
    },
    recurrence: { type: 'string', description: 'Named rule: daily|weekdays|weekly|monthly|yearly|hourly. For sub-daily intervals use "hourly:N" (every N hours, e.g. "hourly:6") or "interval:Xm" / "interval:Xh" (every X minutes/hours). Never use plain "hourly" for anything other than exactly every 1 hour.' },
    requiresConfirmation: { type: 'boolean' },
    nudgeIntervalMinutes: { type: 'integer', minimum: 1, maximum: 10080 }, maxNudges: { type: 'integer', minimum: 1, maximum: 100 },
    durationMinutes: { type: 'integer', minimum: 1, maximum: 10080 }, addGoogleMeet: { type: 'boolean' }, limit: { type: 'integer', minimum: 1, maximum: 50 },
    missingFields: { type: 'array', uniqueItems: true, maxItems: 8, items: { type: 'string', enum: MISSING_FIELDS } },
    question: { type: 'string' },
  },
  required: ['domain', 'action'],
};

Object.defineProperty(actionSchema.properties, 'evidence', {
  value: { type: 'string', description: 'Grounded literal evidence substring from user text, e.g. for memory.save.' },
  enumerable: false,
  configurable: true,
  writable: true,
});

// Proposal bounds mirror the existing extraction/admission contract. This is
// source metadata, never effect authority or a model-selected owner.
export const LEARNING_CANDIDATES_SCHEMA = learningCandidatesSchema;
export const validLearningCandidates = validateLearningCandidates;

export const TURN_INTENT_SCHEMA = Object.freeze({
  type: 'object', additionalProperties: false,
  properties: {
    ...TURN_CONTEXT_PROPERTIES,
    responseCapability: { type: 'string', enum: ['general', 'billing_info'], description: 'Required foreground presentation authority: billing_info for payment information/failure/retry (Free or Pro), even with conversation.reply; general otherwise. billing_info preserves declared reads/recap alongside its safe card; never checkout or mutations.' },
    answerFromResults: { type: 'boolean', description: 'True when the user asks for an interpretation, calculation or comparison that needs live reads. Emit the required read actions; after observing their results Hermes will answer. For complex interpretation leave returnFields absent. For ordinary listings, simple task.list returnFields questions or mutations leave false/null; a single task.list returnFields projection takes precedence over a redundant true flag.' },
    knowledgeRefs: { type: 'array', minItems: 0, maxItems: 8, uniqueItems: true, items: { type: 'string', maxLength: 32 }, description: 'Turn RESPONSE metadata: for mixed tasks + personal recall select supplied pk_ refs from memory hints here, not in tool actions. Supplements canonical cards/fields and historical summaries with recorded personal quotations, never fresh operational state. Ordinary inventories need no answerFromResults just for personal recall. Only reads/conversation allowed; never mutations or guessed refs. Ordinary personal chat may use content without refs.' },
    learningCandidates: LEARNING_CANDIDATES_SCHEMA,
    actions: { type: 'array', minItems: 1, maxItems: 12, items: actionSchema },
    excluded: { type: 'array', maxItems: 12, items: { type: 'object', additionalProperties: false, properties: { quote: { type: 'string' }, reason: { type: 'string', enum: ['prohibited', 'context_only', 'superseded', 'hypothetical'] } }, required: ['quote', 'reason'] } },
  },
  required: ['actions'],
});

// Phase-specific renderings share safety clauses without expanding the compact
// foreground contract into the conversation tool's explanatory prose.
const CHECKOUT_AUTHORITY = 'subscription.link only for explicit link/open-checkout requests';
const CHECKOUT_PROHIBITION = 'Explicit checkout prohibition means NO subscription.link or mutation; use subscription.info';
const UNKNOWN_PAYMENT = 'Unknown payment outcome never authorizes retry';
const PAYMENT_METHOD_EVIDENCE = 'Never invent PayPal, bank transfer, Apple Pay';
const RECAP_READ_GUIDANCE = 'conversation.recap historical renders recorded facts; evidenceRefs narrows history. Current: explicit reads, not history.';
const READ_AND_PAYMENT_GUIDANCE = Object.freeze({
  compact: `task.list: status requerido; ambos="all"; fechas: completed+pending (all usa due_date).
PAGOS: Pro/how-to: subscription.info(scope="plan")+conversation.reply fundamentado; Botón Stripe existente solo Free; sin URLs. Precios/descuentos/métodos/fallos/reembolsos/no-checkout: subscription.info sin scope/promoción. ${CHECKOUT_AUTHORITY}; tras info: general+link; actions no vacío. ${PAYMENT_METHOD_EVIDENCE}. PayPal/transferencia/Apple Pay/secciones: solo capacidad verificada. ${CHECKOUT_PROHIBITION}. ${UNKNOWN_PAYMENT}; no checkout descubre capacidades.
RECAP: ${RECAP_READ_GUIDANCE} RECAP: historical=hechos registrados; evidenceRefs acota; current=lecturas, no historia; social=reply. Solo refs: historia parcial.`,
  conversation: `LECTURAS: task.list requires status: unfiltered both states="all"; dated comparisons need completed+pending reads (all uses due_date).
PAGOS: Pro benefits/how-to: subscription.info(scope="plan") plus natural concise grounded prose in conversation.reply from this same decision; Node supplies verified entitlement, benefits and a Free-only existing Stripe subscribe button. No model-authored URL. Prices, discounts, methods, failures/refunds and no-checkout: unscoped subscription.info, never promotional plan scope; Node supplies uncertainty/safety. conversation.reply alone is not billing authority. ${CHECKOUT_AUTHORITY}. Contextual explicit link requests after info still require general + subscription.link; actions must never be empty. How-to alone stays side-effect-free info. ${PAYMENT_METHOD_EVIDENCE} or app sections without tool-backed provider capability. ${CHECKOUT_PROHIBITION}. ${UNKNOWN_PAYMENT}; no checkout to discover capabilities.
RECAP: ${RECAP_READ_GUIDANCE} Social: reply. Solo recap refs normalize to partial history.`,
});

export const EXECUTE_TURN_DESCRIPTION = `Hermes decide significado. Node es la autoridad final sobre identidad, propiedad, estado y timezone. TurnIntent mandatory for every turn; orden manda.
AUTORIDAD DE ESTADO: Si la verdad puede cambiar al cambiar DB/Calendar, exige lectura (agenda.read, calendar.list, reminder.list, task.list), incluso monto/fecha/estado. NUNCA simules mutaciones (pagar, completar, borrar) solo con texto. Historial/memoria: referencias, no operandos vivos (Never reconstruct live state from chat history).
CREATE VS UPDATE IS A HARD SEMANTIC BOUNDARY: crear sin target; mutar:contextRef/target; cambio≠ID. reminder.update/cancel: cambia/borra; reminder.acknowledge: seguimiento (Completion is not an update). reminder.create diferido; preguntas≠mutaciones.
Estado/deuda/saldo: task.list(entityName). Completar o pagar es task.complete(target) (admite entityName o contextRef).
CALENDARIO: agenda.read (hoy/today: scope="today" o schedule); calendar.list/search eventos; calendar.create citas. no niegues acceso en conversation.reply.
Temporal meaning must remain typed según schema. Sin AM/PM (ej. "a las 3"): hora literal (hour: 3) con clockMode="ambiguous_12h". Eventos futuros (ej. 'para mañana a las 8 AM X'): reminder.create; faltantes genuinos; compuestas emiten acciones independientes; recurrencia (ej. cada 2h) crea reminder.create(content, recurrence) sin pedir hora.
todas las acciones en actions; resto:excluded. conversation.reply requiere content con texto útil, nunca null ni vacío. Confirma solo resultados observados, no planes; no repitas cards.
${READ_AND_PAYMENT_GUIDANCE.compact}`;

export function getIntentToolDefinitions({ isAdmin = false }: { isAdmin?: boolean } = {}) {
  const parameters = structuredClone(TURN_INTENT_SCHEMA);
  if (!isAdmin) parameters.properties.actions.items.properties.domain.enum = parameters.properties.actions.items.properties.domain.enum.filter((domain) => domain !== 'admin');
  return [{ type: 'function', function: { name: TOOL_NAMES.EXECUTE_TURN, description: EXECUTE_TURN_DESCRIPTION, parameters } }];
}

export function getConversationToolDefinition() {
  return {
    type: 'function',
    function: {
      name: TOOL_NAMES.REPLY_TO_USER,
      description: `Reply naturally only when the answer does not depend on current operational state. If the truth could change because DB/Calendar changed without a new user message, conversation.reply is forbidden: emit the matching live read instead. Facts in <user_memories> must be answered directly in conversation.reply. Never claim or derive unverified task, project, reminder, calendar, subscription, pending proposal, entity, or agenda state here.
${READ_AND_PAYMENT_GUIDANCE.conversation}`,
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: { content: { type: 'string', minLength: 1 } },
        required: ['content'],
      },
    },
  };
}

export function getForegroundToolDefinitions({ isAdmin = false }: { isAdmin?: boolean } = {}) {
  return [...getIntentToolDefinitions({ isAdmin }), getConversationToolDefinition()];
}

export function getIntentActionsForDomain(domain: string) { return [...(DOMAIN_ACTIONS[domain] || [])]; }

export function getCanonicalOperations({ domains = DOMAINS }: { domains?: readonly string[] } = {}) {
  const allowedDomains = new Set(domains);
  return CANONICAL_OPERATIONS.filter((operation) => allowedDomains.has(CANONICAL_OPERATION_PARTS.get(operation)!.domain));
}

export function parseCanonicalOperation(operation: unknown) {
  const parsed = CANONICAL_OPERATION_PARTS.get(String(operation || '').trim().toLowerCase());
  return parsed ? { ...parsed } : null;
}

export function normalizeIntentAction(domain: string,action: unknown) {
  const normalized = String(action || '').trim().toLowerCase().replace(/[\s-]+/g, '_');
  // Structural wire aliases are accepted only when their canonical meaning is
  // exact. This never interprets the user's natural language.
  return STRUCTURAL_ACTION_ALIASES[domain]?.[normalized] || normalized;
}
function hasTarget(raw: Record<string,unknown>) { return (typeof raw?.target === 'string' && raw.target.trim().length > 0) || Boolean(raw?.contextRef); }
function hasEntityIdentity(raw: Record<string,unknown>) {
  return [raw?.target, raw?.entityName, raw?.title, raw?.content]
    .some((value) => typeof value === 'string' && value.trim().length > 0);
}

/**
 * Complete a single project-container action from the one exact structured
 * entityName already repeated by all of its task.create members. This links
 * fields that Hermes already interpreted; it never inspects user prose.
 */
function linkOperationalCollectionContainer(actions: readonly unknown[]): unknown[] {
  const copies = actions.map(action => object(action) ? { ...action } : action);
  const containers = copies.flatMap((action,index) => object(action) && String(action.domain || '').trim().toLowerCase() === 'entity'
    && includesValue(['create','upsert'],normalizeIntentAction('entity',action.action)) && action.category === 'project' && !hasEntityIdentity(action) ? [{index}] : []);
  if (containers.length !== 1) return copies;
  const names = [...new Set(copies.flatMap(action => object(action) && String(action.domain || '').trim().toLowerCase() === 'task'
    && normalizeIntentAction('task',action.action) === 'create' && action.projectless !== true && (!action.category || action.category === 'project')
    && typeof action.entityName === 'string' && action.entityName.trim() ? [action.entityName.trim()] : []))];
  if (names.length !== 1) return copies;
  const index = containers[0]!.index,container = copies[index];
  if (object(container)) copies[index] = { ...container,entityName:names[0] };
  return copies;
}
function getEffectiveScheduleKind(schedule: unknown) {
  if (!object(schedule)) return undefined;
  if (schedule?.kind === 'calendar_date_time' && Number.isInteger(schedule.dayOffset) && (!Number.isInteger(schedule.month) || !Number.isInteger(schedule.day))) {
    return 'relative_day_time';
  }
  return schedule?.kind;
}
function hasCompleteReminderSchedule(schedule: unknown) {
  if (!object(schedule)) return false;
  const kind = getEffectiveScheduleKind(schedule);
  if (kind === 'relative_offset') return Number.isInteger(schedule.offsetMinutes);
  if (kind === 'relative_day_time') return Number.isInteger(schedule.dayOffset) && Number.isInteger(schedule.hour);
  if (kind === 'calendar_date_time') return Number.isInteger(schedule.month) && Number.isInteger(schedule.day) && Number.isInteger(schedule.hour);
  if (kind === 'weekday_time') return typeof schedule.weekday === 'string' && Number.isInteger(schedule.hour);
  if (kind === 'local_time') return Number.isInteger(schedule.hour);
  return false;
}

function hasCompleteDateSchedule(schedule: unknown) {
  if (!object(schedule)) return false;
  const kind = getEffectiveScheduleKind(schedule);
  if (kind === 'calendar_date_time') return Number.isInteger(schedule.month) && Number.isInteger(schedule.day);
  if (kind === 'relative_day_time') return Number.isInteger(schedule.dayOffset);
  if (kind === 'weekday_time') return typeof schedule.weekday === 'string';
  return false;
}

function hasCompleteTemporalSchedule(domain: string,schedule: unknown,action: string | null = null) {
  if (!object(schedule)) return false;
  if ((domain === 'calendar' || domain === 'task') && schedule.allDay === true) {
    return hasCompleteDateSchedule(schedule);
  }
  return hasCompleteReminderSchedule(schedule);
}
function inferPartialReminderScheduleFields(schedule: unknown) {
  if (!object(schedule)) return [];
  const kind = getEffectiveScheduleKind(schedule);
  const hasClock = Number.isInteger(schedule.hour);
  let hasDate = false;
  if (kind === 'relative_day_time') hasDate = Number.isInteger(schedule.dayOffset);
  if (kind === 'calendar_date_time') hasDate = Number.isInteger(schedule.month) && Number.isInteger(schedule.day);
  if (kind === 'weekday_time') hasDate = typeof schedule.weekday === 'string';
  if (kind === 'local_time') {
    return hasClock ? ['date'] : [];
  }
  if (!includesValue(['relative_day_time', 'calendar_date_time', 'weekday_time'],kind)) return [];
  if (!hasDate && !hasClock) return [];
  return [
    ...(!hasDate ? ['date'] : []),
    ...(!hasClock ? ['time'] : []),
  ];
}
function mutationRequiresTarget(domain: string,action: string,raw: Record<string,unknown>) {
  if (domain === 'reminder') { if (action === 'cancel' && includesValue(['all', 'elapsed'],raw.scope)) return false; return includesValue(['update', 'cancel', 'add_advance'],action); }
  if (domain === 'task') return includesValue(['update', 'complete', 'delete'],action);
  if (domain === 'calendar') return includesValue(['update', 'delete'],action);
  return false;
}

function scheduleBearingMutation(domain: string,action: string,field = 'schedule') {
  if (field === 'endSchedule') return domain === 'calendar' && includesValue(['create', 'update'],action);
  return (
    (domain === 'reminder' && includesValue(['create', 'update'],action))
    || (domain === 'task' && includesValue(['create', 'update'],action))
    || (domain === 'calendar' && includesValue(['create', 'update'],action))
  );
}

export function validateTurnIntent(intent: unknown,{ isAdmin = false,requireResponseCapability = false }: { isAdmin?: boolean; requireResponseCapability?: boolean } = {}): IntentValidation {
  if (!object(intent)) return { valid: false, errorCode: 'INVALID_PARAMETERS', error: 'El intent del turno debe ser un objeto.' };
  // Direct internal intents may omit presentation authority; foreground decisions
  // must declare it. Never manufacture a default for missing planner output.
  if ((requireResponseCapability || intent.responseCapability !== undefined)
    && !includesValue(TURN_INTENT_SCHEMA.properties.responseCapability.enum,intent.responseCapability)) {
    return { valid: false, errorCode: 'INVALID_RESPONSE_CAPABILITY', error: 'An explicit supported response capability is required.' };
  }
  const learningCandidatesProvided = Object.hasOwn(intent, 'learningCandidates');
  const acceptedCandidates = learningCandidatesProvided && validLearningCandidates(intent.learningCandidates) ? intent.learningCandidates : undefined;
  if (learningCandidatesProvided && !acceptedCandidates) {
    return { valid: false, errorCode: 'INVALID_LEARNING_CANDIDATES', error: 'Learning proposals require a bounded typed array; use [] when none qualify.' };
  }
  const turnContext = validateTurnContext(intent);
  if (!turnContext.valid) return turnContext;
  if (intent.answerFromResults !== undefined && typeof intent.answerFromResults !== 'boolean') return { valid: false, errorCode: 'INVALID_PARAMETERS', error: 'answerFromResults must be boolean.' };
  if (intent.pendingIntentEffect !== undefined) {
    return { valid: false, errorCode: 'INVALID_PARAMETERS', error: 'pendingIntentEffect ha sido deprecado y no es soportado.' };
  }
  if (!Array.isArray(intent.actions) || intent.actions.length === 0) return { valid: false, errorCode: 'INVALID_PARAMETERS', error: 'El turno requiere al menos una acción.' };
  if (intent.actions.length > 12) return { valid: false, errorCode: 'TURN_ACTION_LIMIT', error: 'El turno supera el límite de 12 acciones.' };
  const normalizedActions: ValidatedAction[] = [];
  const structurallyLinkedActions = linkOperationalCollectionContainer(intent.actions);
  for (const item of structurallyLinkedActions) {
    if (!object(item)) return { valid: false, errorCode: 'INVALID_PARAMETERS', error: 'Cada acción debe ser un objeto.' };
    let raw: Record<string,unknown> = item;
    const domain = String(raw.domain || '').trim().toLowerCase();
    if (!includesValue(DOMAINS,domain) || (!isAdmin && domain === 'admin')) return { valid: false, errorCode: 'UNSUPPORTED_DOMAIN', error: `Dominio no disponible: ${raw.domain || '(vacío)'}.` };
    const action = normalizeIntentAction(domain, raw.action);
    if (!DOMAIN_ACTIONS[domain]?.has(action)) return { valid: false, errorCode: 'UNSUPPORTED_ACTION', error: `Capacidad no soportada: ${domain}.${raw.action}.` };
    if (domain === 'entity' && includesValue(['create', 'upsert'],action)
      && raw.category !== undefined && !includesValue(ENTITY_WRITE_CATEGORIES,raw.category)) {
      return { valid: false, errorCode: 'INVALID_ENTITY_CATEGORY', error: `entity.${action} category must be ${ENTITY_WRITE_CATEGORIES.join('/')} (omitted=other); memory categories belong to memory.save, not entity fields.` };
    }
    if (domain === 'calendar' && action === 'update' && raw.scope !== undefined
      && (!isCalendarLookupDate(raw.scope) || raw.contextRef !== undefined)) {
      return { valid: false, errorCode: 'INVALID_CALENDAR_LOOKUP_DATE', error: 'Calendar update lookup requires scope=YYYY-MM-DD without contextRef.' };
    }
    if (domain === 'subscription' && action === 'info'
      && raw.scope !== undefined && raw.scope !== 'plan') {
      return { valid: false, errorCode: 'INVALID_SUBSCRIPTION_SCOPE', error: 'subscription.info scope must be plan or omitted.' };
    }
    // Pure typed selection is historical authority, regardless of the mode label.
    // Other actions, billing and interpretation remain incompatible below.
    if (domain === 'conversation' && action === 'recap' && raw.recapMode === 'current'
      && raw.evidenceRefs !== undefined && structurallyLinkedActions.length === 1
      && intent.answerFromResults !== true && intent.responseCapability !== 'billing_info') {
      raw = { ...raw, recapMode: 'historical' };
    }
    if (domain === 'task' && action === 'list' && !includesValue(actionSchema.properties.status.enum,raw.status)) {
      return { valid: false, errorCode: 'INVALID_TASK_STATUS', error: 'task.list requires an explicit supported status.' };
    }
    // Legacy action-scoped refs are rejected, never silently ignored or promoted.
    if (raw.knowledgeRefs !== undefined) {
      return { valid: false, errorCode: 'INVALID_KNOWLEDGE_REFS', error: 'Personal sources require bounded read-only references.' };
    }
    if (raw.returnFields !== undefined && (domain !== 'task' || action !== 'list'
      || !Array.isArray(raw.returnFields) || !raw.returnFields.length || raw.returnFields.length > 5
      || raw.returnFields.some(field => !includesValue(actionSchema.properties.returnFields.items.enum,field))
      || new Set(raw.returnFields).size !== raw.returnFields.length)) {
      return { valid: false, errorCode: 'INVALID_RETURN_FIELDS', error: 'returnFields requires task.list and unique supported task fields.' };
    }
    if (raw.recapMode !== undefined && !(domain === 'conversation' && action === 'recap')) {
      return { valid: false, errorCode: 'INVALID_RECAP', error: 'recapMode applies only to conversation.recap.' };
    }
    if (raw.evidenceRefs !== undefined && (domain !== 'conversation'
      || !(action === 'reply' || action === 'recap' && raw.recapMode === 'historical')
      || !Array.isArray(raw.evidenceRefs) || !raw.evidenceRefs.length || raw.evidenceRefs.length > 8
      || raw.evidenceRefs.some(ref => typeof ref !== 'string' || !/^[0-9a-f-]{36}$/.test(ref))
      || new Set(raw.evidenceRefs).size !== raw.evidenceRefs.length)) {
      return { valid: false, errorCode: 'INVALID_EVIDENCE_REFS', error: 'Invalid operational evidence selection.' };
    }
    if (domain === 'conversation' && action === 'recap'
      && (!includesValue(['historical', 'current'],raw.recapMode)
        || raw.content !== undefined && (raw.evidenceRefs === undefined || typeof raw.content !== 'string' || raw.content.length > 1600))) {
      return { valid: false, errorCode: 'INVALID_RECAP', error: 'Recap prose is not evidence; select historical refs or declare current reads.' };
    }
    if (domain === 'conversation' && action === 'reply' && raw.evidenceRefs === undefined && !(typeof raw.content === 'string' && raw.content.trim())) return { valid: false, errorCode: 'MISSING_CONTENT', error: 'conversation.reply requiere contenido de respuesta.' };
    const structurallyMissingScheduleFields = domain === 'reminder'
      && action === 'create'
      && !raw.recurrence
      ? inferPartialReminderScheduleFields(raw.schedule)
      : [];
    const declaredMissingFields = Array.isArray(raw.missingFields) ? raw.missingFields : [];
    if (structurallyMissingScheduleFields.length > 0
      && declaredMissingFields.length > 0
      && !structurallyMissingScheduleFields.every((field) => includesValue(declaredMissingFields,field))) {
      return { valid: false, errorCode: 'MISSING_SCHEDULE', error: 'missingFields no representa los componentes temporales ausentes.' };
    }
    const normalizedRaw = structurallyMissingScheduleFields.length > 0 && declaredMissingFields.length === 0
      ? { ...raw, missingFields: structurallyMissingScheduleFields }
      : raw;
    if (raw.contextRef && (!object(raw.contextRef) || !includesValue(['reminder', 'task', 'calendar'],domain) || raw.contextRef.source !== 'working_memory' || typeof raw.contextRef.position !== 'number' || !Number.isInteger(raw.contextRef.position)
      || raw.contextRef.position < 1 || raw.contextRef.position > 100
      || !includesValue(['update', 'cancel', 'acknowledge', 'complete', 'delete', 'rename'],action))) {
      return { valid: false, errorCode: 'INVALID_CONTEXT_REFERENCE', error: 'The action requires a valid existing-item reference.' };
    }
    const declaredPendingFields = Array.isArray(normalizedRaw.missingFields) && normalizedRaw.missingFields.length > 0;
    const mayRemainPending = declaredPendingFields;

    // Every schedule-bearing mutation crosses the same canonical boundary.
    // A partial schedule is valid only when Hermes explicitly represents the
    // missing component as a pending clarification; otherwise it must be
    // rejected before any executor can perform temporal arithmetic.
    for (const scheduleField of ['schedule', 'endSchedule']) {
      const schedule = normalizedRaw[scheduleField];
      if (!schedule || !scheduleBearingMutation(domain, action, scheduleField)) continue;
      const knownKind = object(schedule)
        && includesValue(typedSchedule.properties.kind.enum,schedule.kind)
        && schedule.kind !== 'inherit_context';
      if (!knownKind) return { valid: false, errorCode: 'MISSING_SCHEDULE', error: 'La estructura temporal no es utilizable.' };
      if (!hasCompleteTemporalSchedule(domain, schedule, action) && !mayRemainPending) {
        return { valid: false, errorCode: 'MISSING_SCHEDULE', error: 'La estructura temporal está incompleta.' };
      }
    }
    if (mutationRequiresTarget(domain, action, normalizedRaw) && !hasTarget(normalizedRaw) && !mayRemainPending) return { valid: false, errorCode: 'MISSING_TARGET', error: `${domain}.${action} requiere una referencia explícita al objeto existente.` };
    if (domain === 'entity'
      && includesValue(['create', 'upsert'],action)
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
        && !hasCompleteTemporalSchedule('task', normalizedRaw.schedule, 'create')
        && !mayRemainPending) {
        return { valid: false, errorCode: 'MISSING_SCHEDULE', error: 'task.create incluyó una estructura temporal incompleta.' };
      }
    }
    if (normalizedRaw.recurrence !== undefined && !includesValue(RECURRENCES,normalizedRaw.recurrence) && !RECURRENCE_INTERVAL_RE.test(String(normalizedRaw.recurrence))) return { valid: false, errorCode: 'INVALID_RECURRENCE', error: `Recurrencia no soportada: ${normalizedRaw.recurrence}.` };
    if (normalizedRaw.deliveryPolicy !== undefined) {
      const policy = normalizedRaw.deliveryPolicy;
      if (domain !== 'reminder' || !includesValue(['create', 'update'],action)) {
        return { valid: false, errorCode: 'INVALID_PARAMETERS', error: 'deliveryPolicy solo aplica a reminder.create/update.' };
      }
      if (!object(policy) || !includesValue(['none', 'offset'],policy.advanceNotice)) {
        return { valid: false, errorCode: 'INVALID_PARAMETERS', error: 'deliveryPolicy no es válido.' };
      }
      if (policy.advanceNotice === 'offset' && !Number.isInteger(policy.advanceMinutes)) {
        return { valid: false, errorCode: 'INVALID_PARAMETERS', error: 'deliveryPolicy requiere advanceMinutes cuando advanceNotice=offset.' };
      }
      if (policy.advanceNotice === 'none' && policy.advanceMinutes !== undefined && policy.advanceMinutes !== null) {
        return { valid: false, errorCode: 'INVALID_PARAMETERS', error: 'deliveryPolicy no admite advanceMinutes cuando advanceNotice=none.' };
      }
    }
    if (normalizedRaw.clearFields !== undefined) {
      const allowedClearFields = domain === 'task' && action === 'update'
        ? new Set(['description', 'dueDate'])
        : (includesValue(['reminder', 'calendar'],domain) && action === 'update'
          ? new Set(domain === 'calendar' ? ['description', 'recurrence'] : ['recurrence'])
          : new Set());
      if (!Array.isArray(normalizedRaw.clearFields)
        || normalizedRaw.clearFields.length === 0
        || normalizedRaw.clearFields.some((field) => !(typeof field === 'string' && allowedClearFields.has(field)))
        || new Set(normalizedRaw.clearFields).size !== normalizedRaw.clearFields.length) {
        return { valid: false, errorCode: 'INVALID_PARAMETERS', error: `clearFields no es compatible con ${domain}.${action}.` };
      }
    }
    if (normalizedRaw.descriptionMode !== undefined
      && (domain !== 'task' || action !== 'update' || !includesValue(['append', 'replace'],normalizedRaw.descriptionMode))) {
      return { valid: false, errorCode: 'INVALID_PARAMETERS', error: 'descriptionMode solo admite append o replace para task.update.' };
    }
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
        && object(normalizedRaw.schedule)
        && includesValue(typedSchedule.properties.kind.enum,normalizedRaw.schedule.kind)
        && normalizedRaw.schedule.kind !== 'inherit_context';
      if (normalizedRaw.schedule && !knownScheduleKind) {
        return { valid: false, errorCode: 'MISSING_SCHEDULE', error: 'La decisión de creación no incluyó una estructura temporal utilizable.' };
      }
      if (!hasCompleteReminderSchedule(normalizedRaw.schedule) && !normalizedRaw.recurrence && !mayRemainPending) {
        return { valid: false, errorCode: 'MISSING_SCHEDULE', error: 'La decisión de creación no incluyó una estructura temporal utilizable.' };
      }
    }
    const normalizedAction: ValidatedAction = { ...normalizedRaw,domain,action };
    // Explicit sources own the response; generated framing is never evidence.
    if (domain === 'conversation' && includesValue(['reply', 'recap'],action) && raw.evidenceRefs !== undefined) delete normalizedAction.content;
    normalizedActions.push(normalizedAction);
  }
  if (Array.isArray(intent.knowledgeRefs)) {
    const validPersonalRefs = intent.knowledgeRefs.filter(ref => typeof ref === 'string' && /^pk_[a-f0-9]{8,16}_[1-9][0-9]?$/.test(ref));
    const shouldSanitize = (validPersonalRefs.length > 0 && validPersonalRefs.length < intent.knowledgeRefs.length)
      || (validPersonalRefs.length === 0 && intent.knowledgeRefs.length > 0 && intent.knowledgeRefs.every(isStrictUUID));
    if (shouldSanitize) {
      intent.knowledgeRefs = validPersonalRefs;
    }
  }
  const hasKnowledgeRefs = intent.knowledgeRefs != null
    && !(Array.isArray(intent.knowledgeRefs) && intent.knowledgeRefs.length === 0);
  if (hasKnowledgeRefs && (!Array.isArray(intent.knowledgeRefs)
    || intent.knowledgeRefs.length > 8
    || intent.knowledgeRefs.some(ref => typeof ref !== 'string' || !/^pk_[a-f0-9]{8,16}_[1-9][0-9]?$/.test(ref))
    || new Set(intent.knowledgeRefs).size !== intent.knowledgeRefs.length
    || normalizedActions.some(item => !PERSONAL_READ_OPERATIONS.has(`${item.domain}.${item.action}`)
      && !(item.domain === 'conversation' && includesValue(['reply', 'recap'],item.action))))) {
    return { valid: false, errorCode: 'INVALID_KNOWLEDGE_REFS', error: 'Personal response sources require bounded references and read/conversation-only authority.' };
  }
  const billingReadOperations = new Set(['conversation.reply', 'conversation.recap', 'subscription.info',
    'task.list', 'reminder.list', 'agenda.read', 'calendar.list', 'calendar.search', 'calendar.next']);
  if (intent.responseCapability === 'billing_info'
    && normalizedActions.some(item => !billingReadOperations.has(qualifyOperation(item.domain, item.action)))) {
    return { valid: false, errorCode: 'INVALID_RESPONSE_CAPABILITY', error: 'Billing information cannot authorize checkout or mutations.' };
  }
  if (normalizedActions.some(item => item.evidenceRefs !== undefined)
    && (normalizedActions.length !== 1 || intent.answerFromResults === true || intent.responseCapability === 'billing_info')) {
    return { valid: false, errorCode: 'INVALID_EVIDENCE_REFS', error: 'Historical selections cannot imply current reads, billing queries or actions.' };
  }
  const recaps = normalizedActions.filter(item => item.domain === 'conversation' && item.action === 'recap');
  if (recaps.length) {
    const reads = normalizedActions.filter(item => item !== recaps[0]
      && !(intent.responseCapability === 'billing_info' && item.domain === 'subscription' && item.action === 'info'));
    const allowedReads = new Set(['agenda.read', 'task.list', 'reminder.list', 'calendar.list', 'calendar.search', 'calendar.next']);
    if (recaps.length !== 1 || (recaps[0]!.recapMode === 'historical'
      ? reads.length !== 0 || intent.answerFromResults === true
      : reads.length === 0 || reads.some(item => !allowedReads.has(qualifyOperation(item.domain, item.action))))) {
      return { valid: false, errorCode: 'INVALID_RECAP', error: 'Historical recap permits no reads; current recap requires only explicit operational reads.' };
    }
  }
  const excluded = Array.isArray(intent.excluded) ? intent.excluded.filter((item: unknown) => object(item) && typeof item.quote === 'string' && item.quote.trim()) : [];
  return {
    valid: true,
    intent: {
      ...turnContext.context,
      ...(learningCandidatesProvided && acceptedCandidates ? { learningCandidates:acceptedCandidates,learningCandidatesProvided:true } : {}),
      ...(intent.responseCapability !== undefined ? { responseCapability: intent.responseCapability } : {}),
      ...(intent.answerFromResults !== undefined ? { answerFromResults: intent.answerFromResults } : {}),
      // Reference shape/bounds were checked above; quotation ownership remains a separate lookup.
      ...(hasKnowledgeRefs ? { knowledgeRefs: intent.knowledgeRefs as string[] } : {}),
      actions: normalizedActions,
      excluded,
    },
  };
}

export function parseIntentArguments(rawArguments: unknown): unknown {
  if (rawArguments && typeof rawArguments === 'object') return rawArguments;
  if (typeof rawArguments !== 'string' || !rawArguments.trim()) return {};
  try { const parsed: unknown = JSON.parse(rawArguments); return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null; } catch { return null; }
}
