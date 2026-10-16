import { aiResponseSchema, aiTranscriptSchema, turnDispositionSchema, productivityClarificationSchema, type ProductivityClarification, type AIMessage, type JsonObject,
  type ToolCall, type ToolSpecification, type TurnContext } from '@templelabs/contracts';
import { AIProviderError, ToolSelectionError } from '@templelabs/ai';
import type { AIProvider } from '@templelabs/ai';
import type { ToolRegistry, ToolOutcome } from '@templelabs/tools';
import { estimateContextTokens, canonicalArguments } from './context-manager.js';
import { ContextLimitError } from './operational-context.js';
import { clarificationTool } from './clarification-tool.js';
import { DecisionSession, decisionTool, pendingQuestion, withDecisionItem } from './decision-control.js';
import type { ProductivityDecision, ProductivityPending } from '@templelabs/contracts';

export type LoopLimitReason = 'input_context' | 'model_steps' | 'total_tokens' | 'tool_calls' | 'time' | 'cost' | 'history_messages';

export interface ToolSelectionDiagnostic {
  readonly rejectedToolName: string | null;
  readonly advertisedToolNames: readonly string[];
  readonly advertisedToolsTruncated: boolean;
  readonly decision: 'reload_schema' | 'stop';
  readonly reason: 'authorized_schema' | 'discovery_disabled' | 'recovery_exhausted' | 'reserved_control' | 'unknown_tool' | 'already_advertised' | 'turn_inactive';
  readonly accountingComplete: boolean;
}

export interface AgentLoopOptions {
  /** Detached, bounded identifiers only. Observer exceptions never affect execution. */
  readonly onToolSelection?: (diagnostic: ToolSelectionDiagnostic) => void;
  /** Best-effort categorical telemetry only; exceptions cannot affect execution. */
  readonly onLimit?: (diagnostic: { readonly reason: LoopLimitReason }) => void;
  /** Explicit opt-in until real provider/canary gates pass. */
  readonly continuation?: 'single_decision' | 'observation_driven';
  /** Discover one authorized atomic schema at a time; never execute catalogue selections. */
  readonly discoverTools?: boolean;
  readonly initialTools?: readonly string[];
  readonly readFollowups?: Readonly<Record<string, readonly string[]>>;
  readonly finishWithVerifiedResults?: boolean;
  /** Explicit typed readiness/closure protocol; legacy adapters remain compatible. */
  readonly structuredDecisions?: boolean;
  readonly continuationReserveTokens?: number;
  readonly maxModelSteps?: number;
  readonly maxTotalTokens?: number;
  readonly maxInputTokens?: number;
  readonly estimateInputTokens?: (request: unknown) => number;
  readonly maxCostUsd?: number;
  readonly pricing?: { readonly inputUsdPerMillion: number; readonly outputUsdPerMillion: number };
  readonly maxToolCalls?: number;
  /** Host-scoped cap on successful/partial writes; validation failures may still self-correct. */
  readonly maxWriteOperations?: number;
  readonly maxHistoryMessages?: number;
  readonly maxOutputTokens?: number;
  readonly timeoutMs?: number;
  readonly now?: () => number;
  readonly executionMode?: 'execute' | 'shadow';
  /** Host policy checks user intent/approval; role capabilities alone are insufficient. */
  readonly authorizeWrite?: (call: ToolCall, context: TurnContext) => Promise<boolean>;
}
export type LoopNotice = 'provider_unavailable' | 'invalid_response' | 'unavailable_tool' | 'limit_reached';
export interface AgentLoopUsage {
  readonly modelSteps: number; readonly inputTokens: number; readonly outputTokens: number;
  readonly estimatedCostUsd: number | null;
  readonly accountingComplete: boolean;
}
/** Domain state stays in a host-owned policy. Journal exceptions must escape dispatch. */
export interface AgentLoopPolicy {
  readonly pending?: ProductivityPending;
  acceptsTool(name: string): boolean;
  requestSatisfied?(): boolean;
  /** Only host-verified eligible domain results can open the non-execution channel. */
  canClarify?(): boolean;
  /** Composite use cases reserve their underlying journal/UI operation count. */
  callCost?(call: ToolCall): number;
  referenceMissing(call: ToolCall): boolean;
  readonly writeJournalAvailable: boolean;
  prepareContext(history: readonly AIMessage[], maxMessages: number,
    fitsBudget: (messages: readonly AIMessage[]) => boolean, tools?: readonly ToolSpecification[]): AIMessage[];
  requiresReconciliation(call: ToolCall, outcome: ToolOutcome<unknown>): boolean;
  normalizeOutcome(call: ToolCall, outcome: ToolOutcome<unknown>): ToolOutcome<unknown>;
  beforeDispatch(call: ToolCall, context: TurnContext): Promise<void>;
  afterOutcome(call: ToolCall, outcome: ToolOutcome<unknown>): Promise<void>;
}
export interface AgentLoopResult {
  readonly pendingDecision?: ProductivityDecision['pending'];
  readonly resolvedPendingId?: string;
  readonly clarification?: ProductivityClarification;
  readonly requiresReconciliation: boolean;
  readonly conversationReply: string | null;
  readonly history: AIMessage[]; readonly notices: LoopNotice[]; readonly usage: AgentLoopUsage;
}

type JsonValue = JsonObject[string];

/** Date formats are model hints; generated leap-year regexes duplicate hundreds of tokens.
 * The registry still validates the original Zod input, including patterns and refinements. */
function compactSchemaHints(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map(compactSchemaHints);
  if (value !== null && typeof value === 'object') return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !(key === 'pattern' && ['date', 'date-time'].includes(String(value.format))))
    .map(([key, item]) => [key, compactSchemaHints(item)]));
  return value;
}

/** Execution metadata belongs to the model wire envelope, never domain inputs. */
function withTurnDisposition(schema: JsonObject, required: boolean): JsonObject {
  for (const key of ['anyOf', 'oneOf']) if (Array.isArray(schema[key])) return { ...schema,
    [key]: schema[key].map(branch => {
      if (!branch || typeof branch !== 'object' || Array.isArray(branch)) throw new Error('Invalid tool schema branch');
      return withTurnDisposition(branch, required);
    }) };
  const properties = schema.properties;
  if (schema.type !== 'object' || !properties || typeof properties !== 'object' || Array.isArray(properties)
    || Object.hasOwn(properties, 'turnDisposition')) throw new Error('Invalid domain tool envelope');
  return { ...schema, properties: { ...properties,
    turnDisposition: { type: 'string', enum: turnDispositionSchema.options, description: 'finish: present verified results after this batch; continue: inspect results for more actions or analysis.' } },
    required: [...(Array.isArray(schema.required) ? schema.required : []), ...(required ? ['turnDisposition'] : [])] };
}

export class AgentLoop {
  private readonly onLimit: AgentLoopOptions['onLimit'];
  private readonly onToolSelection: AgentLoopOptions['onToolSelection'];
  private readonly discoverTools: boolean;
  private readonly finishWithVerifiedResults: boolean;
  private readonly structuredDecisions: boolean;
  private readonly initialTools: readonly string[];
  private readonly readFollowups: Readonly<Record<string, readonly string[]>>;
  private readonly continuationReserveTokens: number;
  private readonly maxModelSteps: number;
  private readonly maxTotalTokens: number;
  private readonly maxInputTokens: number;
  private readonly estimateInputTokens: (request: unknown) => number;
  private readonly maxCostUsd: number | undefined;
  private readonly pricing: AgentLoopOptions['pricing'];
  private readonly now: () => number;
  private readonly maxToolCalls: number;
  private readonly maxWriteOperations: number;
  private readonly maxHistoryMessages: number;
  private readonly maxOutputTokens: number;
  private readonly timeoutMs: number;
  private readonly executionMode: 'execute' | 'shadow';
  private readonly authorizeWrite: (call: ToolCall, context: TurnContext) => Promise<boolean>;

  constructor(private readonly provider: AIProvider, private readonly registry: ToolRegistry,
    options: AgentLoopOptions = {}) {
    if (options.continuation && !['single_decision', 'observation_driven'].includes(options.continuation)) throw new Error('Invalid continuation');
    this.onLimit = options.onLimit;
    this.onToolSelection = options.onToolSelection;
    this.discoverTools = options.discoverTools === true;
    this.finishWithVerifiedResults = options.finishWithVerifiedResults === true;
    this.structuredDecisions = options.structuredDecisions === true;
    this.initialTools = [...new Set(options.initialTools ?? [])];
    if (this.initialTools.length > 2 || this.initialTools.some(name => !name || name === 'tools_select')) throw new Error('Invalid initial tool scope');
    this.readFollowups = structuredClone(options.readFollowups ?? {});
    this.continuationReserveTokens = options.continuationReserveTokens ?? 0;
    if (!Number.isSafeInteger(this.continuationReserveTokens) || this.continuationReserveTokens < 0) throw new Error('Invalid continuation reserve');
    this.maxModelSteps = options.continuation === 'observation_driven' ? options.maxModelSteps ?? 4 : 1;
    this.maxTotalTokens = options.maxTotalTokens ?? 32000;
    this.maxInputTokens = options.maxInputTokens ?? this.maxTotalTokens;
    this.estimateInputTokens = options.estimateInputTokens ?? estimateContextTokens;
    this.maxCostUsd = options.maxCostUsd;
    this.pricing = options.pricing;
    if (this.maxCostUsd !== undefined && (!Number.isFinite(this.maxCostUsd) || this.maxCostUsd <= 0 || !this.pricing)) {
      throw new Error('Cost budget requires positive budget and explicit provider pricing');
    }
    if (this.pricing && Object.values(this.pricing).some(rate => !Number.isFinite(rate) || rate < 0)) throw new Error('Invalid provider pricing');
    this.now = options.now ?? Date.now;
    this.maxToolCalls = options.maxToolCalls ?? 4;
    this.maxWriteOperations = options.maxWriteOperations ?? this.maxToolCalls;
    this.maxHistoryMessages = options.maxHistoryMessages ?? 64;
    this.maxOutputTokens = options.maxOutputTokens ?? 1024;
    this.timeoutMs = options.timeoutMs ?? 15000;
    this.executionMode = options.executionMode ?? 'execute';
    if (!['execute', 'shadow'].includes(this.executionMode)) throw new Error('Invalid execution mode');
    this.authorizeWrite = options.authorizeWrite ?? (async () => false);
    for (const [name, value] of Object.entries({ maxModelSteps: this.maxModelSteps, maxInputTokens: this.maxInputTokens, maxTotalTokens: this.maxTotalTokens, maxToolCalls: this.maxToolCalls, maxWriteOperations: this.maxWriteOperations, maxHistoryMessages: this.maxHistoryMessages,
      maxOutputTokens: this.maxOutputTokens, timeoutMs: this.timeoutMs })) {
      if (!Number.isSafeInteger(value) || value < 1) throw new Error(`Invalid ${name}`);
    }
    if (this.maxToolCalls > 10) throw new Error('maxToolCalls exceeds UI contract');
  }

  async run(text: string, context: TurnContext, previous: readonly AIMessage[],
    policy: AgentLoopPolicy): Promise<AgentLoopResult> {
    if (!text.trim() || text.length > 8000) throw new Error('Invalid normalized input');
    context.signal.throwIfAborted();
    if (previous.length) aiTranscriptSchema.parse(previous);
    if (previous.some(message => message.role === 'system')) throw new Error('Conversation history cannot include system messages');
    const history: AIMessage[] = [...structuredClone(previous), { role: 'user', content: text }];
    const notices: LoopNotice[] = [];
    const deadlineMs = this.now() + this.timeoutMs;
    const usage = { accountingComplete: true, modelSteps: 0, inputTokens: 0, outputTokens: 0, estimatedCostUsd: this.pricing ? 0 : null };
    let reconciliationRequired = false;
    let conversationReply: string | null = null;
    let clarification: ProductivityClarification | undefined;
    let pendingDecision: ProductivityDecision['pending'];
    let resolvedPendingId: string | undefined;
    const finish = (): AgentLoopResult => ({ ...(clarification ? { clarification } : {}),
      ...(pendingDecision ? { pendingDecision } : {}), ...(resolvedPendingId ? { resolvedPendingId } : {}),
      history, conversationReply, notices: [...new Set(notices)], usage: { ...usage }, requiresReconciliation: reconciliationRequired });
    const recordLimit = (reason: LoopLimitReason): void => {
      notices.push('limit_reached');
      try { this.onLimit?.({ reason }); } catch { /* Diagnostics are never execution authority. */ }
    };
    const useDecisions = this.structuredDecisions || Boolean(policy.pending);
    const catalogue = this.registry.available(context).filter(tool => policy.acceptsTool(tool.name)).map(tool => {
      let inputSchema = this.discoverTools ? compactSchemaHints(tool.inputSchema) as JsonObject : tool.inputSchema;
      if (this.finishWithVerifiedResults) inputSchema = withTurnDisposition(inputSchema, this.registry.effect(tool.name) === 'read');
      return { ...tool, inputSchema };
    });
    if (catalogue.some(tool => ['tools_select', clarificationTool.name, decisionTool.name].includes(tool.name))) throw new Error('Reserved tool name');
    const decisions = useDecisions ? new DecisionSession(new Set(catalogue.map(tool => tool.name)), policy.pending, context) : undefined;
    let decisionCorrectionUsed = false;
    let executionCorrectionUsed = false;
    const discovery = { name: 'tools_select', description: 'Select an unadvertised operation to load its input schema. Do NOT select tools already present in tools. Use the returned schema on the next step.',
      inputSchema: { type: 'object', properties: { name: { type: 'string', enum: catalogue.map(tool => tool.name) } }, required: ['name'], additionalProperties: false } };
    let selected: readonly string[] = this.initialTools.filter(name => catalogue.some(tool => tool.name === name));
    let explicitSelections: readonly string[] = [];
    let followups: readonly string[] = [];
    const completedWrites = new Map<string, { callId: string; outcome: ToolOutcome<unknown> }>();
    let totalTokens = 0;
    let costUsd = 0;
    let totalCalls = 0;
    let schemaRecoveryUsed = false;
    const provider = this.provider.forTurn?.() ?? this.provider;
    for (let step = 0; step < this.maxModelSteps; step++) {
      // Warm schemas bootstrap the first decision. An explicit selection replaces
      // that scope; keeping unrelated create schemas can starve a simple read.
      const readyTools = decisions?.declared ? decisions.remainingReady.map(item => item.tool) : [];
      const loaded = catalogue.filter(tool => selected.includes(tool.name) || followups.includes(tool.name) || readyTools.includes(tool.name));
      const unloaded = catalogue.filter(tool => !loaded.some(current => current.name === tool.name));
      // Discovery is idempotent. Rejecting a repeated selection in the provider
      // prevents the loop from observing/correcting it at all.
      const scopedDiscovery = discovery;
      const offerDecision = decisions?.canDeclare && (step === 0 || decisionCorrectionUsed || Boolean(policy.pending) || decisions.declared);
      const scopedTools = this.discoverTools ? [...(unloaded.length ? [scopedDiscovery] : []), ...loaded] : catalogue;
      const domainTools = decisions && (offerDecision || decisions.declared) ? scopedTools.map(tool => tool.name === 'tools_select'
        ? tool : { ...tool, inputSchema: withDecisionItem(tool.inputSchema),
          ...(decisions.remainingReady.some(item => item.tool === tool.name)
            ? { description: tool.description + (executionCorrectionUsed
                ? ' MANDATORY EXECUTION: Previous text reply was rejected. Emit fresh tool calls with decisionItem for remaining keys: '
                  + decisions.remainingReady.filter(item => item.tool === tool.name).map(item => item.key).join(',') + '. Do not reply with text.'
                : ' Emit fresh tool calls with decisionItem for remaining keys: '
                  + decisions.remainingReady.filter(item => item.tool === tool.name).map(item => item.key).join(',') + '. Prose executes nothing.') } : {}) }) : scopedTools;
      const clarifiedTools = !reconciliationRequired && policy.canClarify?.() ? [...domainTools, clarificationTool] : domainTools;
      const tools = offerDecision ? [...clarifiedTools, decisionCorrectionUsed
        ? { ...decisionTool, description: decisionTool.description + (policy.pending
            ? ' Previous call lacked decision declaration. You MUST call conversation_decide(resolution:{pendingId:lastPending.id,key:"..."},ready:[{key:"...",tool:"reminder_create"}]) first. No rejected arguments execute.'
            : ' Previous response was not accepted. Do NOT use plain text. For dialogue, answers or no actions, emit conversation_decide(ready:[],reply:"..."). Never call commentary or json. No rejected arguments execute.') }
        : decisionTool] : clarifiedTools;
      const availableNames = new Set(tools.map(tool => tool.name));
      const inputCeiling = this.maxInputTokens - (tools.some(tool => this.registry.effect(tool.name) === 'read') ? this.continuationReserveTokens : 0);
      const estimateRequest = (messages: readonly AIMessage[]): number => {
        const tokens = this.estimateInputTokens({ messages, tools });
        if (!Number.isSafeInteger(tokens) || tokens < 0) throw new Error('Invalid input token estimate');
        return tokens;
      };
      let prepared;
      let contextBound: LoopLimitReason = 'history_messages';
      try {
        // Leave room for the next assistant response without dropping any of its tool pairs.
        prepared = { messages: policy.prepareContext(history, Math.max(1, this.maxHistoryMessages - 1),
          messages => {
            const estimate = estimateRequest(messages);
            if (estimate > inputCeiling) { contextBound = 'input_context'; return false; }
            if (estimate >= this.maxTotalTokens - totalTokens) { contextBound = 'total_tokens'; return false; }
            return true;
          }, tools) };
      } catch (error) {
        if (error instanceof ContextLimitError) {
          // Warm schemas are optional performance hints, never mandatory context.
          // Retry preparation with narrower scope before falling back to discovery alone.
          if (step === 0 && this.discoverTools && selected.length) { selected = selected.length > 1 ? selected.slice(-1) : []; step--; continue; }
          recordLimit(contextBound); return finish();
        }
        throw error;
      }
      const messages = aiTranscriptSchema.parse(prepared.messages);
      const estimate = estimateRequest(messages);
      const availableOutput = Math.min(this.maxOutputTokens, this.maxTotalTokens - totalTokens - estimate);
      const reservedCost = this.pricing ? (estimate * this.pricing.inputUsdPerMillion
        + Math.max(0, availableOutput) * this.pricing.outputUsdPerMillion) / 1e6 : 0;
      if (estimate > inputCeiling || availableOutput < 1 || (this.maxCostUsd !== undefined && costUsd + reservedCost > this.maxCostUsd)
        || this.now() >= deadlineMs || context.signal.aborted) {
        recordLimit(estimate > inputCeiling ? 'input_context' : availableOutput < 1 ? 'total_tokens'
          : this.maxCostUsd !== undefined && costUsd + reservedCost > this.maxCostUsd ? 'cost' : 'time');
        return finish();
      }
      let response;
      try {
        usage.modelSteps++;
        response = aiResponseSchema.parse(await provider.complete({
          messages, tools,
          maxOutputTokens: availableOutput, maxInputTokens: this.maxInputTokens,
          maxTotalTokens: this.maxTotalTokens - totalTokens, deadlineMs, signal: context.signal,
          ...(this.maxCostUsd !== undefined && this.pricing ? {
            spendLimit: { maxUsd: Math.max(0, this.maxCostUsd - costUsd), ...this.pricing },
          } : {}),
        }));
      } catch (error) {
        if (error instanceof AIProviderError) {
          usage.inputTokens += error.usage.inputTokens; usage.outputTokens += error.usage.outputTokens;
          usage.accountingComplete = usage.accountingComplete && error.accountingComplete;
          if (this.pricing) costUsd += (error.usage.inputTokens * this.pricing.inputUsdPerMillion
            + error.usage.outputTokens * this.pricing.outputUsdPerMillion) / 1e6;
          usage.estimatedCostUsd = this.pricing && usage.accountingComplete ? costUsd : null;
        } else { usage.accountingComplete = false; usage.estimatedCostUsd = null; }
        // Preserve the recovery predicate's order and short-circuiting, including
        // its single clock observation. Diagnostics cannot grant retry authority.
        let selectionReason: ToolSelectionDiagnostic['reason'] | undefined;
        if (error instanceof ToolSelectionError) {
          selectionReason = !this.discoverTools ? 'discovery_disabled'
            : schemaRecoveryUsed ? 'recovery_exhausted'
            : !catalogue.some(tool => tool.name === error.toolName)
              ? (['tools_select', clarificationTool.name, decisionTool.name].includes(error.toolName) ? 'reserved_control' : 'unknown_tool')
            : availableNames.has(error.toolName) ? 'already_advertised'
            : context.signal.aborted || !(this.now() < deadlineMs) ? 'turn_inactive'
            : 'authorized_schema';
          const safeName = (name: string): boolean => typeof name === 'string' && /^[a-zA-Z0-9_-]{1,64}$/.test(name);
          const advertisedToolNames = [...availableNames].filter(safeName).slice(0, 64);
          try {
            this.onToolSelection?.({
              rejectedToolName: safeName(error.toolName) ? error.toolName : null,
              advertisedToolNames,
              advertisedToolsTruncated: advertisedToolNames.length !== availableNames.size,
              decision: selectionReason === 'authorized_schema' ? 'reload_schema' : 'stop',
              reason: selectionReason, accountingComplete: usage.accountingComplete,
            });
          } catch { /* Diagnostics are never execution authority. */ }
        }
        if (error instanceof ToolSelectionError && selectionReason === 'authorized_schema') {
          // No call from the rejected decision reached dispatch. Load only the
          // authorized schema and ask for a fresh decision, at most once per turn.
          // Unknown spend stays unknown; its entire reservation consumes the cap.
          totalTokens += error.accountingComplete ? error.usage.inputTokens + error.usage.outputTokens : estimate + availableOutput;
          if (this.pricing) costUsd += error.accountingComplete ? 0 : reservedCost;
          schemaRecoveryUsed = true;
          selected = [error.toolName]; explicitSelections = [error.toolName]; followups = [];
          if (step + 1 === this.maxModelSteps) { recordLimit('model_steps'); return finish(); }
          continue;
        }
        notices.push('provider_unavailable');
        return finish();
      }
      usage.inputTokens += response.usage.inputTokens;
      usage.outputTokens += response.usage.outputTokens;
      totalTokens += response.usage.inputTokens + response.usage.outputTokens;
      if (this.pricing) costUsd += (response.usage.inputTokens * this.pricing.inputUsdPerMillion
        + response.usage.outputTokens * this.pricing.outputUsdPerMillion) / 1e6;
      usage.estimatedCostUsd = this.pricing && usage.accountingComplete ? costUsd : null;
      const calls = response.message.toolCalls;
      const costs = calls.map(call => call.name === clarificationTool.name ? 1 : policy.callCost?.(call) ?? 1);
      if (costs.some(cost => !Number.isSafeInteger(cost) || cost < 1)) { notices.push('invalid_response'); return finish(); }
      const callCost = costs.reduce((total, cost) => total + cost, 0);
      if (totalCalls + callCost > this.maxToolCalls || messages.length + calls.length > this.maxHistoryMessages
        || response.usage.inputTokens > this.maxInputTokens || totalTokens > this.maxTotalTokens
        || (this.maxCostUsd !== undefined && costUsd > this.maxCostUsd) || this.now() >= deadlineMs || context.signal.aborted) {
        recordLimit(totalCalls + callCost > this.maxToolCalls ? 'tool_calls'
          : messages.length + calls.length > this.maxHistoryMessages ? 'history_messages'
          : response.usage.inputTokens > this.maxInputTokens ? 'input_context'
          : totalTokens > this.maxTotalTokens ? 'total_tokens'
          : this.maxCostUsd !== undefined && costUsd > this.maxCostUsd ? 'cost' : 'time');
        return finish();
      }
      if (new Set(calls.map(call => call.id)).size !== calls.length
        || response.usage.outputTokens > availableOutput
        || this.finishWithVerifiedResults && calls.some(call => call.name !== 'tools_select' && Object.hasOwn(call.arguments, 'turnDisposition')
          && !turnDispositionSchema.safeParse(call.arguments.turnDisposition).success)) {
        notices.push('invalid_response'); return finish();
      }
      if (decisions) {
        // A fresh, accounted no-effect response may request the missing decision once.
        // This is not provider retry/recovery and never replays proposed arguments.
        if (!decisions.declared && !decisions.hasLegacyActivity && !calls.length && response.stopReason === 'completed'
          && !decisionCorrectionUsed && usage.accountingComplete) {
          decisionCorrectionUsed = true;
          decisions.requireDecision();
          if (step + 1 === this.maxModelSteps) { recordLimit('model_steps'); return finish(); }
          continue;
        }
        if ((decisions.needsKnownFacts(calls) || decisions.needsDeclaration(calls)) && !decisionCorrectionUsed && usage.accountingComplete) {
          // The rejected control is counted, but no sibling, journal or history is replayed.
          totalCalls += callCost;
          decisionCorrectionUsed = true;
          decisions.requireDecision();
          if (step + 1 === this.maxModelSteps) { recordLimit('model_steps'); return finish(); }
          continue;
        }
        if (decisions.declared && !decisions.complete && !calls.length && response.stopReason === 'completed'
          && !executionCorrectionUsed && usage.accountingComplete && !reconciliationRequired) {
          // One bounded fresh proposal, never execution derived from declaration metadata.
          executionCorrectionUsed = true;
          const lastMsg = history[history.length - 1];
          if (lastMsg && lastMsg.role === 'tool' && typeof lastMsg.content === 'object' && lastMsg.content !== null && !Array.isArray(lastMsg.content)) {
            lastMsg.content = { ...lastMsg.content, warning: 'Premature text reply was rejected. You MUST emit tool calls with decisionItem for remainingReady before any text.' };
          }
          if (step + 1 === this.maxModelSteps) { recordLimit('model_steps'); return finish(); }
          continue;
        }
        if (!decisions.admit(calls, availableNames)) { notices.push('invalid_response'); return finish(); }
      }
      // Namespacing avoids collisions between provider-local IDs on separate turns.
      const normalizedCalls = calls.map(call => ({ ...call,
        arguments: catalogue.some(tool => tool.name === call.name)
          ? Object.fromEntries(Object.entries(call.arguments).filter(([key]) => !(this.finishWithVerifiedResults && key === 'turnDisposition')
            && !(decisions && key === 'decisionItem'))) : call.arguments,
        id: `${encodeURIComponent(context.requestId)}:${step === 0 ? '' : `step:${step}:`}${encodeURIComponent(call.id)}` }));
      // Validate the entire decision before appending or dispatching any part.
      // A clarification cannot carry prose, authorization or a sibling write.
      if (calls.some(call => call.name === clarificationTool.name)) {
        const candidate = calls[0]!;
        const parsed = productivityClarificationSchema.safeParse(candidate.arguments);
        if (calls.length !== 1 || !availableNames.has(clarificationTool.name) || reconciliationRequired
          || !policy.canClarify?.() || response.message.content !== '' || !parsed.success) {
          notices.push('invalid_response'); return finish();
        }
        clarification = parsed.data;
        const call = normalizedCalls[0]!;
        history.push({ role: 'assistant', content: '', toolCalls: [call] },
          { role: 'tool', toolCallId: call.id, isError: false,
            content: { status: 'clarification_required', clarification: { ...clarification } } });
        aiTranscriptSchema.parse(history);
        return finish();
      }
      history.push({ role: 'assistant', content: response.message.content, toolCalls: normalizedCalls.map((call, index) => ({ ...call,
        arguments: calls[index]!.arguments })) });
      if (!calls.length && response.stopReason === 'completed') conversationReply = response.message.content.trim() || null;
      totalCalls += callCost;
      const finishRequested = this.finishWithVerifiedResults && calls.some(call => call.name !== 'tools_select' && call.arguments.turnDisposition === 'finish');
      for (const call of normalizedCalls) {
        if (decisions && call.name === decisionTool.name) {
          selected = [...new Set([...selected, ...decisions.remainingReady.map(item => item.tool)])];
          history.push({ role: 'tool', toolCallId: call.id, isError: false, content: { status: 'decision_recorded', execution: false, remainingReady: decisions.remainingReady,
              next: 'Decision recorded. You MUST propose fresh tool calls for remainingReady items using decisionItem before replying. Do NOT reply with text.' } });
          continue;
        }
        if (this.discoverTools && call.name === 'tools_select') {
          const name = call.arguments.name;
          const valid = availableNames.has(call.name) && Object.keys(call.arguments).length === 1
            && typeof name === 'string' && catalogue.some(tool => tool.name === name);
          const alreadyLoaded = typeof name === 'string' && availableNames.has(name);
          if (valid) {
            explicitSelections = [...new Set([...explicitSelections, ...normalizedCalls.filter(candidate => candidate.name === 'tools_select'
            && Object.keys(candidate.arguments).length === 1 && typeof candidate.arguments.name === 'string'
            && catalogue.some(tool => tool.name === candidate.arguments.name)).map(candidate => String(candidate.arguments.name))])];
            selected = explicitSelections;
          }
          history.push({ role: 'tool', toolCallId: call.id, content: valid
            ? { status: 'success', selectedTool: name, alreadyLoaded, observation: alreadyLoaded
              ? `Schema already loaded. Call ${name} directly next; do not select it again. No domain action executed.`
              : 'Schema loaded for the next step. No domain action executed.' }
            : { status: 'denied', code: 'TOOL_UNAVAILABLE' }, isError: !valid });
          continue;
        }
        const effect = this.registry.effect(call.name);
        if (!availableNames.has(call.name) || !policy.acceptsTool(call.name) || !effect) {
          notices.push('unavailable_tool');
          history.push({ role: 'tool', toolCallId: call.id, content: { status: 'denied', code: 'TOOL_UNAVAILABLE' }, isError: true });
          continue;
        }
        const referenceMissing = policy.referenceMissing(call);
        const read = effect === 'read';
        const journalMissing = !read && !policy.writeJournalAvailable;
        const writeKey = `${call.name}:${canonicalArguments(call.arguments)}`;
        const repeatedWrite = !read && completedWrites.has(writeKey);
        const priorWrite = completedWrites.get(writeKey);
        if (priorWrite?.outcome.status === 'success') {
          // Reuse the receipt as an observation, not another effect or UI item.
          history.push({ role: 'tool', toolCallId: call.id, content: {
            status: 'success', code: 'WRITE_ALREADY_CONFIRMED', earlierCallId: priorWrite.callId,
            observation: priorWrite.outcome.observation,
          }, isError: false });
          continue;
        }
        const writeLimitReached = !read && completedWrites.size >= this.maxWriteOperations;
        let stopped = this.now() >= deadlineMs || context.signal.aborted;
        let permitted = read;
        const blockedByUnknown = reconciliationRequired && !read;
        if (!permitted && !referenceMissing && !stopped && !blockedByUnknown && !repeatedWrite && !writeLimitReached && !journalMissing && this.executionMode === 'execute') {
          try { permitted = await this.authorizeWrite(structuredClone(call), context); }
          catch { permitted = false; }
        }
        stopped = stopped || this.now() >= deadlineMs || context.signal.aborted;
        let outcome: ToolOutcome<unknown> = stopped
          ? { status: 'failed' as const, code: 'TURN_STOPPED', observation: 'No action dispatched after the turn was stopped.' }
          : repeatedWrite
            ? { status: 'denied' as const, code: 'DUPLICATE_WRITE', observation: 'This exact write already completed in this turn; use its earlier receipt.' }
          : writeLimitReached
            ? { status: 'approval_required' as const, code: 'WRITE_OPERATION_LIMIT', observation: 'The host-authorized write scope for this turn is exhausted; no additional write was dispatched.' }
          : journalMissing
            ? { status: 'failed' as const, code: 'DURABLE_JOURNAL_REQUIRED', observation: 'No write was dispatched; an execution journal is required.' }
          : referenceMissing
            ? { status: 'clarification_required' as const, code: 'REFERENCE_REQUIRED',
                observation: typeof call.arguments.reminderId === 'string'
                  ? `Target reminder ${call.arguments.reminderId} not found. If it does not exist, do not call tools: reply to the user. Never call unadvertised tools like reminder_read directly.`
                  : 'Read or identify an observed resource before changing it.' }
            : blockedByUnknown
              ? { status: 'approval_required', code: 'EFFECT_RECONCILIATION_REQUIRED',
                observation: 'Reconcile the earlier unknown write before dispatching more writes.' }
              : !permitted
                ? { status: 'approval_required', code: this.executionMode === 'shadow' ? 'SHADOW_WRITE_DISABLED' : 'USER_AUTHORIZATION_REQUIRED',
                  observation: 'No write was dispatched; authorization or execution mode did not permit it.' }
                : { status: 'failed', code: 'NOT_DISPATCHED', observation: 'Not dispatched.' };
        if (!stopped && !referenceMissing && !blockedByUnknown && !repeatedWrite && !writeLimitReached && !journalMissing && permitted) {
          await policy.beforeDispatch(structuredClone(call), context);
          // Persistence can consume the remaining deadline or lose ownership.
          stopped = this.now() >= deadlineMs || context.signal.aborted;
          if (stopped) outcome = { status: 'failed', code: 'TURN_STOPPED', observation: 'No action dispatched after the turn was stopped.' };
        }
        if (!stopped && !referenceMissing && !blockedByUnknown && !repeatedWrite && !writeLimitReached && !journalMissing && permitted) {
          try { outcome = await this.registry.execute(call.name, call.arguments, context, call.id); }
          catch { outcome = read
            ? { status: 'failed', code: 'READ_UNAVAILABLE', observation: 'The read was not verified.' }
            : { status: 'indeterminate', operationId: call.id, observation: 'Reconcile this write before retrying.' }; }
        }
        try {
          outcome = policy.normalizeOutcome(call, outcome);
          if ('receipt' in outcome && (outcome.receipt.userId !== context.userId
            || outcome.receipt.operationId !== call.id || outcome.receipt.toolName !== call.name)) {
            throw new Error('Receipt identity mismatch');
          }
          if (outcome.status === 'indeterminate' && outcome.operationId !== call.id) throw new Error('Operation identity mismatch');
        }
        catch { outcome = read
          ? { status: 'failed', code: 'READ_UNAVAILABLE', observation: 'The read was not verified.' }
          : { status: 'indeterminate', operationId: call.id, observation: 'Reconcile this write before retrying.' }; }
        if (!read && (outcome.status === 'success' || outcome.status === 'partial')) completedWrites.set(writeKey, { callId: call.id, outcome });
        if (outcome.status === 'indeterminate' || policy.requiresReconciliation(call, outcome)) reconciliationRequired = true;
        await policy.afterOutcome(structuredClone(call), outcome);
        const rawKey = calls[normalizedCalls.indexOf(call)]?.arguments.decisionItem;
        decisions?.record(rawKey, outcome.status === 'success' && !!outcome.data && typeof outcome.data === 'object'
          && 'complete' in outcome.data && outcome.data.complete === true);
        if (this.discoverTools && read && outcome.status === 'success') {
          const data = outcome.data as unknown;
          const resources = data && typeof data === 'object' ? ('records' in data ? data.records : 'events' in data ? data.events : null) : null;
          followups = Array.isArray(resources) && resources.length ? this.readFollowups[call.name] ?? [] : [];
          if (followups.length) selected = selected.filter(name => name !== call.name);
        }
        if (this.discoverTools && !read && (outcome.status === 'success' || outcome.status === 'partial')) { followups = []; }
        const disposition = calls[normalizedCalls.indexOf(call)]?.arguments.turnDisposition;
        const content: JsonObject = { status: outcome.status, observation: outcome.observation,
          ...(this.finishWithVerifiedResults && disposition !== undefined ? { turnDisposition: disposition } : {}) };
        history.push({ role: 'tool', toolCallId: call.id, content, isError: outcome.status !== 'success' && outcome.status !== 'partial' });
      }
      aiTranscriptSchema.parse(history);
      if (decisions?.complete && !notices.length && !reconciliationRequired
        && (decisions.reply !== undefined || decisions.noReady || policy.requestSatisfied?.())
        && (decisions.reply !== undefined || decisions.noReady || decisions.pending || decisions.resolutionId || finishRequested)) {
        pendingDecision = decisions.pending;
        resolvedPendingId = decisions.resolutionId;
        clarification = pendingQuestion(pendingDecision);
        conversationReply = decisions.reply ?? null;
        return finish();
      }
      if ((!decisions || !decisions.declared) && finishRequested && !notices.length && !reconciliationRequired && policy.requestSatisfied?.()) return finish();
      if (!calls.length || reconciliationRequired || this.maxModelSteps === 1) return finish();
      if (step + 1 === this.maxModelSteps) recordLimit('model_steps');
    }
    return finish();
  }
}
