import { productivityDecisionSchema, type ProductivityDecision, type ProductivityPending, type ProductivityClarification,
  type ToolCall, type ToolSpecification, type JsonObject, type TurnContext } from '@templelabs/contracts';

export const decisionTool: ToolSpecification = {
  name: 'conversation_decide',
  description: 'MANDATORY decision declaration. Clear actions in ready; ambiguous in pending. Must accompany ready calls in SAME step (decide AND reminder_create together). If tool not in tools, call tools_select first; never declare pending for clear requests. When resolving lastPending: OMIT pending. Answering questions, dialogue or no actions: conversation_decide(ready:[], reply:"..."). Do NOT reply with plain text. Never call commentary or json. Never emit markdown blocks. Declarations never execute work.',
  inputSchema: { type: 'object', additionalProperties: false, properties: {
    ready: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['key', 'tool'], properties: {
      key: { type: 'string' }, tool: { type: 'string' } } } },
    pending: { type: 'object', additionalProperties: false, required: ['tool', 'missing'], properties: {
      tool: { type: 'string' }, missing: { type: 'string', enum: ['date', 'time', 'item', 'details', 'today_or_tomorrow'] },
      knownArguments: { type: 'object', description: 'Known facts for pending item (e.g. content and hour/minute). Omit pending when resolving lastPending.', properties: {
        content: { type: 'string' },
        relativeDayTime: { type: 'object', properties: {
          hour: { type: 'integer', minimum: 0, maximum: 23 },
          minute: { type: 'integer', minimum: 0, maximum: 59 },
        } },
      } } } },
    resolution: { type: 'object', additionalProperties: false, required: ['pendingId', 'key'], properties: {
      pendingId: { type: 'string', description: 'Exact id from lastPending. When resolving: OMIT pending.' }, key: { type: 'string' } } },
    reply: { type: ['string', 'null'], description: 'Dialogue ONLY when ready:[]. Pass null or omit when ready has items.' },
  } },
};

// Exhaustive classification: new missing-field labels require an explicit category.
const clarificationKinds: Record<ProductivityClarification['missing'], 'date' | 'time' | 'other'> = {
  date: 'date', today_or_tomorrow: 'date', time: 'time', item: 'other', details: 'other',
};
const isDateClarification = (missing: ProductivityClarification['missing']): boolean => clarificationKinds[missing] === 'date';

/** Every date-only reminder question retains its already-known content and clock. */
export function missingReminderDateFacts(pending: ProductivityDecision['pending']): boolean {
  if (pending?.tool !== 'reminder_create' || !isDateClarification(pending.missing)) return false;
  const facts = pending.knownArguments;
  const clock = facts.relativeDayTime;
  return typeof facts.content !== 'string' || !facts.content.trim()
    || !clock || typeof clock !== 'object' || Array.isArray(clock)
    || !Number.isInteger(clock.hour) || Number(clock.hour) < 0 || Number(clock.hour) > 23
    || !Number.isInteger(clock.minute) || Number(clock.minute) < 0 || Number(clock.minute) > 59;
}

/** A partial fact is a constraint on a fresh proposal, never a command template. */
function containsKnown(proposal: unknown, known: unknown): boolean {
  if (known === null || typeof known !== 'object') return proposal === known;
  if (Array.isArray(known)) return Array.isArray(proposal) && proposal.length === known.length
    && known.every((value, index) => containsKnown(proposal[index], value));
  return proposal !== null && typeof proposal === 'object' && !Array.isArray(proposal)
    && Object.entries(known).every(([key, value]) => Object.hasOwn(proposal, key)
      && containsKnown((proposal as Record<string, unknown>)[key], value));
}
/** A date-only answer cannot silently add recurrence, delivery flags or other fields. */
function fillsOnlyDate(proposal: Record<string, unknown>, known: Record<string, unknown>, path = ''): boolean {
  return Object.entries(proposal).every(([key, value]) => {
    if (!path && ['decisionItem', 'turnDisposition'].includes(key)) return true;
    const field = path ? `${path}.${key}` : key;
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const previous = known[key];
      return fillsOnlyDate(value as Record<string, unknown>, previous && typeof previous === 'object' && !Array.isArray(previous)
        ? previous as Record<string, unknown> : {}, field);
    }
    return Object.hasOwn(known, key) || field === 'relativeDayTime.day';
  });
}
function sameRelativeAnchor(prior: ProductivityPending, current: TurnContext): boolean {
  const known = prior.knownArguments;
  const relative = known.relativeDayTime;
  if (!relative && known.delayMinutes === undefined && known.unqualifiedLocalTime === undefined) return true;
  const source = prior.sourceContext;
  if (!source || source.timezone !== current.timezone) return false;
  if (known.delayMinutes !== undefined) return source.referenceTimeIso === current.referenceTimeIso;
  if (!relative || typeof relative !== 'object' || Array.isArray(relative)) return source.referenceTimeIso === current.referenceTimeIso;
  const localDate = (iso: string) => new Intl.DateTimeFormat('en-CA', { timeZone: source.timezone,
    year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(iso));
  return localDate(source.referenceTimeIso) === localDate(current.referenceTimeIso);
}
export function pendingQuestion(pending: ProductivityDecision['pending']): ProductivityClarification | undefined {
  if (!pending) return undefined;
  const prefix = pending.tool.split('_')[0];
  const domain = prefix === 'reminder' ? 'reminders' : prefix === 'task' ? 'tasks' : prefix === 'calendar' ? 'calendar'
    : prefix === 'memory' ? 'memories' : 'general';
  return { domain, missing: pending.missing };
}

/** Turn-local enforcement only. The runner owns durable identity and verified state. */
export class DecisionSession {
  private decision: ProductivityDecision | undefined;
  private readonly verified = new Set<string>();
  private explicitRequired: boolean;
  private legacyActivity = false;
  constructor(private readonly allowed: ReadonlySet<string>, private readonly prior: ProductivityPending | undefined, private readonly context: TurnContext) {
    this.explicitRequired = Boolean(prior);
  }
  get hasLegacyActivity(): boolean { return this.legacyActivity; }
  requireDecision(): void { this.explicitRequired = true; }
  get declared(): boolean { return this.decision !== undefined; }
  get remainingReady(): ProductivityDecision['ready'] { return this.decision?.ready.filter(item => !this.verified.has(item.key)) ?? []; }
  get canDeclare(): boolean { return !this.decision || this.complete && !this.decision.pending && !this.decision.resolution; }
  get complete(): boolean { return !!this.decision && this.decision.ready.every(item => this.verified.has(item.key)); }
  get noReady(): boolean { return this.decision?.ready.length === 0; }
  get pending(): ProductivityDecision['pending'] { return this.complete ? this.decision?.pending : undefined; }
  get resolutionId(): string | undefined { return this.complete ? this.decision?.resolution?.pendingId : undefined; }
  get reply(): string | undefined { return this.decision?.reply; }

  needsKnownFacts(calls: readonly ToolCall[]): boolean {
    if (this.declared || this.legacyActivity || calls.length !== 1 || calls[0]?.name !== decisionTool.name) return false;
    const args = calls[0].arguments;
    const pending = args.pending;
    const missingFacts = pending !== null && typeof pending === 'object' && !Array.isArray(pending)
      && !Object.hasOwn(pending, 'knownArguments');
    // Validation-only probe to recognize an omission. admit() still parses the
    // ORIGINAL arguments; this probe is never admitted, persisted or executed.
    const parsed = productivityDecisionSchema.safeParse(missingFacts
      ? { ...args, pending: { ...pending, knownArguments: {} } } : args);
    return parsed.success && (missingFacts || missingReminderDateFacts(parsed.data.pending));
  }

  needsDeclaration(calls: readonly ToolCall[]): boolean {
    if (this.declared || this.legacyActivity) return false;
    const decideCall = calls.find(call => call.name === decisionTool.name);
    if (decideCall) {
      if (this.explicitRequired) {
        const args = decideCall.arguments;
        if (args && typeof args === 'object' && !Array.isArray(args)) {
          const res = args.resolution;
          const resKey = res && typeof res === 'object' && !Array.isArray(res) && 'key' in res && typeof res.key === 'string' ? res.key : undefined;
          if (this.prior && resKey && (!Array.isArray(args.ready) || !args.ready.some(r => r && typeof r === 'object' && !Array.isArray(r) && 'key' in r && r.key === resKey))) return true;
          if (Array.isArray(args.ready) && args.ready.length === 0 && !args.reply && !args.pending) return true;
        }
      }
      return false;
    }
    return this.explicitRequired
      ? calls.some(call => !['tools_select', 'conversation_clarify', decisionTool.name].includes(call.name))
      : calls.some(call => Object.hasOwn(call.arguments, 'decisionItem'));
  }

  /** All siblings are checked before any journal or domain dispatch. */
  admit(calls: readonly ToolCall[], available: ReadonlySet<string>): boolean {
    const controls = calls.filter(call => call.name === decisionTool.name);
    if (controls.length > 1 || controls.length && !this.canDeclare) return false;
    const controlArgs = controls[0]?.arguments;
    const hasReady = controlArgs && typeof controlArgs === 'object' && Array.isArray(controlArgs.ready) && controlArgs.ready.length > 0;
    const rawReply = controlArgs && typeof controlArgs === 'object' && typeof controlArgs.reply === 'string' && controlArgs.reply.trim() ? controlArgs.reply : undefined;
    const normalizedArgs = controlArgs && typeof controlArgs === 'object'
      ? {
          ...controlArgs,
          reply: hasReady
            ? undefined
            : (rawReply ?? (Array.isArray(controlArgs.ready) && controlArgs.ready.length === 0 && !controlArgs.pending && !controlArgs.resolution
                ? (this.context.language === 'en' ? 'Done, no changes made.' : 'Listo, no realicé ningún cambio.')
                : undefined)),
        }
      : controlArgs;
    const parsed = normalizedArgs ? productivityDecisionSchema.safeParse(normalizedArgs) : undefined;
    if (parsed && !parsed.success) return false;
    const candidate = parsed?.success ? parsed.data : this.decision;
    const actions = calls.filter(call => !['tools_select', 'conversation_clarify', decisionTool.name].includes(call.name));
    if (!candidate) {
      if (!calls.length) return this.legacyActivity && !this.explicitRequired;
      if (calls.every(call => call.name === 'tools_select')) return true;
      // Existing complete, current proposals retain their original validation and
      // authorization path. Never synthesize a plan or reconstruct history here.
      if (this.explicitRequired || calls.some(call => Object.hasOwn(call.arguments, 'decisionItem'))) return false;
      this.legacyActivity = true;
      return true;
    }
    if (!calls.length && !this.complete) return false;
    if (controls.length && missingReminderDateFacts(candidate.pending)) return false;
    if (candidate.ready.some(item => !this.allowed.has(item.tool)) || candidate.pending && !this.allowed.has(candidate.pending.tool)) return false;
    if (candidate.resolution && (!this.prior || candidate.resolution.pendingId !== this.prior.id
      || candidate.ready[0]?.tool !== this.prior.tool)) return false;
    for (const call of actions) {
      if (candidate.resolution && call.arguments.decisionItem === candidate.resolution.pendingId) {
        call.arguments.decisionItem = candidate.resolution.key;
      }
    }
    if (actions.length === 1 && candidate.ready.length === 1 && candidate.ready[0]?.tool === actions[0]!.name) {
      actions[0]!.arguments.decisionItem = candidate.ready[0]!.key;
    }
    const keys = actions.map(call => call.arguments.decisionItem);
    if (new Set(keys).size !== keys.length) return false;
    for (const call of actions) {
      const item = candidate.ready.find(item => item.key === call.arguments.decisionItem && item.tool === call.name);
      if (!item || !controls.length && this.verified.has(item.key) || !available.has(call.name)) return false;
      if (candidate.resolution && (!containsKnown(call.arguments, this.prior!.knownArguments)
        || !sameRelativeAnchor(this.prior!, this.context)
        || (this.prior!.missing === 'today_or_tomorrow'
          || this.prior!.tool === 'reminder_create' && isDateClarification(this.prior!.missing))
          && !fillsOnlyDate(call.arguments, this.prior!.knownArguments))) return false;
    }
    if (calls.some(call => call.name === 'conversation_clarify') && !this.complete) return false;
    if (controls.length) this.verified.clear();
    this.decision = candidate;
    return true;
  }
  record(key: unknown, complete: boolean): void { if (typeof key === 'string' && complete) this.verified.add(key); }
}

export function withDecisionItem(schema: JsonObject): JsonObject {
  for (const key of ['anyOf', 'oneOf']) if (Array.isArray(schema[key])) return { ...schema,
    [key]: schema[key].map(branch => {
      if (!branch || typeof branch !== 'object' || Array.isArray(branch)) throw new Error('Invalid decision envelope');
      return withDecisionItem(branch);
    }) };
  const properties = schema.properties;
  if (schema.type !== 'object' || !properties || typeof properties !== 'object' || Array.isArray(properties)
    || Object.hasOwn(properties, 'decisionItem')) throw new Error('Invalid decision envelope');
  return { ...schema, properties: { ...properties, decisionItem: { type: 'string', description: 'Ready item key from conversation_decide.' } } };
}
