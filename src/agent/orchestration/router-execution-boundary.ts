import type { RouterActionUser, RouterLearningMetadata, RouterRuntimeIntent } from './router-action-preparation.js';
import type { RuntimeAction } from './runtime-intent-normalizer.js';

export interface RouterObservedPresentation extends Record<string, unknown> {
  ctaUrl?: unknown; ctaHeader?: unknown; ctaButtonText?: unknown; flow?: unknown; buttons?: unknown;
  list?: { sections?: unknown } | null;
}
export interface RouterObservedResult extends RouterObservedPresentation {
  success?: unknown; action?: unknown; errorCode?: unknown;
  data?: { auth_url?: unknown; checkout_url?: unknown } | null;
}
export interface RouterObservedRecord { toolName?: string; params?: unknown; result?: RouterObservedResult | null }
export interface RouterObservedExecution<Fact extends RouterObservedPresentation> {
  records: RouterObservedRecord[]; facts: Fact[]; excluded?: readonly unknown[] | null; memoryProcessed?: unknown;
}
export interface RouterExecutionContext {
  user: RouterActionUser; isPro: boolean; language: string; userMessage: string;
  referenceTime: Date; timezone: string; correlationId: unknown; latestAssistantMessage: unknown;
  supersedesRunId: string | null; preserveExistingActiveRun: boolean; preserveDisplayedReferences: boolean;
}
export interface RouterExecutionDependencies<Fact extends RouterObservedPresentation, Entities> {
  executeTurnIntent(intent: RouterRuntimeIntent, context: RouterExecutionContext): Promise<RouterObservedExecution<Fact>>;
  inferIntentFromTool(toolName: string | undefined): string;
  mutationReceiptsFromFacts(facts: Fact[]): unknown;
  conversationStateEntities(user: RouterActionUser, extra: Record<string, unknown>): Entities;
  now(): number; logger: Pick<Console, 'log'>;
}
export interface RouterExecutionInput {
  runtimeIntent: RouterRuntimeIntent; operationalActions: RuntimeAction[]; recap?: RuntimeAction | undefined;
  user: RouterActionUser; isPro: boolean; language: string; currentUserText: string;
  requestReferenceTime: Date; timezone: string; options?: { correlationId?: unknown };
  latestAssistantMessage: unknown; supersedesRunId: string | null; preserveExistingActiveRun: boolean; requestId: unknown;
}
export interface RouterResultInput<Fact extends RouterObservedPresentation> {
  execution: RouterObservedExecution<Fact>; runtimeIntent: RouterRuntimeIntent; learningMetadata: RouterLearningMetadata;
  user: RouterActionUser; language: string; finalReply: string; interpretationOutcome?: unknown;
  requestId: unknown; startMs: number; contextElapsedMs: number; modelElapsedMs: number; toolElapsedMs: number;
}
export interface RouterProjectedResult<Fact, Entities> extends RouterLearningMetadata {
  intent: string; entities: Entities; language: string; confirmation: string;
  ctaUrl: unknown; ctaHeader: unknown; ctaButtonText: unknown; flow: unknown; buttons: unknown; list: unknown;
  plan: { type: 'turn_intent'; actions: { domain: string | undefined; action: string | undefined }[] };
  executionFacts: Fact[]; memoryDisposition: 'processed' | 'skip_operational';
}

/** The host executor retains write/lease authority; result projection consumes observed outputs only. */
export function createRouterExecutionBoundary<Fact extends RouterObservedPresentation, Entities>(dependencies: RouterExecutionDependencies<Fact, Entities>) {
  const { executeTurnIntent, inferIntentFromTool, mutationReceiptsFromFacts, conversationStateEntities, now, logger: console } = dependencies;
  async function executeRouterActions(input: RouterExecutionInput) {
    const { runtimeIntent, operationalActions, recap, user, isPro, language, currentUserText, requestReferenceTime,
      timezone, options, latestAssistantMessage, supersedesRunId, preserveExistingActiveRun, requestId } = input;
    const toolStart = now();
    const execution = await executeTurnIntent({ ...runtimeIntent, actions: operationalActions }, {
      user, isPro, language,
      userMessage: currentUserText,
      referenceTime: requestReferenceTime,
      timezone,
      correlationId: options?.correlationId,
      latestAssistantMessage,
      supersedesRunId,
      preserveExistingActiveRun,
      // This path replaces the numbered card with an unnumbered field answer.
      preserveDisplayedReferences: !recap && operationalActions.length === 1
        && Boolean(operationalActions[0]!.returnFields),
    });
    const toolElapsedMs = now() - toolStart;
    execution.records.forEach(({ toolName, result }, index) => {
      console.log(
        `[router req=${requestId}] execution[${index + 1}] tool=${toolName || 'unknown'} success=${Boolean(result?.success)} action=${result?.action || 'unknown'} errorCode=${result?.errorCode || 'none'}`,
      );
    });

    return { execution, toolElapsedMs };
  }
  function projectRouterResult(input: RouterResultInput<Fact>): RouterProjectedResult<Fact, Entities> {
    const { execution, runtimeIntent, learningMetadata, user, language, finalReply, interpretationOutcome,
      requestId, startMs, contextElapsedMs, modelElapsedMs, toolElapsedMs } = input;
    const primary = execution.records[0] || null;
    const ctaFact = execution.facts.find((fact) => fact.ctaUrl) || null;
    const ctaRecord = execution.records.find(({ result }) => result?.ctaUrl || result?.data?.auth_url || result?.data?.checkout_url) || null;
    const flowFact = execution.facts.find((fact) => fact.flow) || null;
    const flowRecord = execution.records.find(({ result }) => result?.flow) || null;
    const buttonsFact = execution.facts.find((fact) => Array.isArray(fact.buttons) && fact.buttons.length > 0) || null;
    const buttonsRecord = execution.records.find(({ result }) => Array.isArray(result?.buttons) && result.buttons.length > 0) || null;
    const listFact = execution.facts.find((fact) => fact.list?.sections) || null;
    const listRecord = execution.records.find(({ result }) => result?.list?.sections) || null;

    console.log(`[router req=${requestId}] action out in ${now() - startMs}ms (context=${contextElapsedMs}ms model=${modelElapsedMs}ms tools=${toolElapsedMs}ms actions=${runtimeIntent.actions.length})`);

    return {
      ...learningMetadata,
      intent: inferIntentFromTool(primary?.toolName),
      entities: conversationStateEntities(user, {
        _turnMetadata: { kind: 'operational_result', mutationReceipts: mutationReceiptsFromFacts(execution.facts),
          ...(interpretationOutcome ? { interpretationOutcome } : {}),
        },
        ...(primary?.params && typeof primary.params === 'object' && !Array.isArray(primary.params) ? primary.params : {}),
      }),
      language,
      confirmation: finalReply,
      ctaUrl: ctaFact?.ctaUrl || ctaRecord?.result?.ctaUrl || ctaRecord?.result?.data?.auth_url || ctaRecord?.result?.data?.checkout_url || null,
      ctaHeader: ctaFact?.ctaHeader || ctaRecord?.result?.ctaHeader || null,
      ctaButtonText: ctaFact?.ctaButtonText || ctaRecord?.result?.ctaButtonText || null,
      flow: flowFact?.flow || flowRecord?.result?.flow || null,
      buttons: buttonsFact?.buttons || buttonsRecord?.result?.buttons || null,
      list: listFact?.list || listRecord?.result?.list || null,
      plan: { type: 'turn_intent', actions: runtimeIntent.actions.map(({ domain, action }) => ({ domain, action })) },
      executionFacts: execution.facts,
      memoryDisposition: execution.memoryProcessed ? 'processed' : 'skip_operational',
    };
  }
  return { executeRouterActions, projectRouterResult };
}
