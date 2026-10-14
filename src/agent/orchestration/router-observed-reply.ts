import { TOOL_NAMES } from '../contracts/tool-names-contract.js';
import { TASK_CARD_COVERAGE, type TaskCardCoverage } from '../core/execution-presentation.js';
import { safeIntentError } from './router-foreground-decision.js';
import type { RouterActionUser, RouterRuntimeIntent, LinkPlaceholderInput } from './router-action-preparation.js';
import type { RouterObservedExecution, RouterObservedPresentation } from './router-execution-boundary.js';
import type { RuntimeAction } from './runtime-intent-normalizer.js';
export interface ReplyFraming { before: string; after: string }
export interface RouterReplyFact extends RouterObservedPresentation {
  tool?: unknown; success?: unknown; complete?: unknown; requestedAction?: unknown; callId?: unknown; card?: unknown;
  presentationData?: { benefits?: unknown; hasProAccess?: unknown } | null;
  readonly [TASK_CARD_COVERAGE]?: readonly TaskCardCoverage[];
}
export type RouterReplyExecution<Fact extends RouterReplyFact> = Omit<RouterObservedExecution<Fact>, 'excluded'> & { excluded?: readonly unknown[] | null };
export type RouterReplyIntent = Omit<RouterRuntimeIntent, 'knowledgeRefs'> & { knowledgeRefs?: readonly string[] };
export interface RouterReplyInput<Fact extends RouterReplyFact, Lookup, Snapshot, Overview> {
  execution: RouterReplyExecution<Fact>; runtimeIntent: RouterReplyIntent; operationalActions: RuntimeAction[];
  recap?: RuntimeAction | undefined; conversationReply: string; language: string; rawPastTurns: readonly unknown[];
  currentUserText: string; user: RouterActionUser; personalKnowledge: { lookup: Lookup }; referenceSnapshot: Snapshot;
  options?: { correlationId?: unknown }; modelElapsedMs: number; requestId: unknown; dailyOverview: Overview;
  requestReferenceTime: Date; timezone: string; phoneNumber?: string | null | undefined;
}
export interface RouterObservedReadInput<Fact, Lookup, Snapshot> {
  userText: string; facts: Fact[]; language: string; correlationId: unknown; conversationHistory: readonly unknown[];
  currentRecap: boolean; referenceSnapshot: Snapshot; userId: string | undefined; personalKnowledge: Lookup;
  selectedKnowledgeRefs: readonly string[]; onKnowledgeRefs(refs: readonly string[]): void; onInterpretationOutcome(outcome: unknown): void;
  retainedTaskCoverage: (TaskCardCoverage & { callId: unknown })[];
}
export interface RouterReplyDependencies<Fact extends RouterReplyFact, Lookup, Snapshot, Overview, Receipts> {
  answerFromTaskReturnFields(action: RuntimeAction, facts: Fact[], userId: string | undefined, language: string): string | null;
  answerFromObservedReads(input: RouterObservedReadInput<Fact, Lookup, Snapshot>): Promise<string | null>;
  renderHistoricalEvidence(history: readonly unknown[], refs: undefined, userId: string | undefined, language: string): string;
  historicalRecap(history: readonly unknown[], language: string): string;
  callResponseSynthesis(input: { userText: string; facts: Fact[]; excludedClauses: readonly unknown[] | null | undefined; language: string; correlationId: unknown }): Promise<{ before?: string | undefined } | null>;
  renderPersonalKnowledge(refs: readonly string[], lookup: Lookup, userId: string | undefined, language: string): string;
  resolveNextBestAction(input: { executionFacts: Fact[]; userText: string; correlationId: unknown; dailyOverview: Overview;
    user: RouterActionUser; language: string; referenceTime: Date; timezone: string }): Promise<{ recommendationText?: string } | null>;
  composeExecutionReply(facts: Fact[], language: string, options?: { framing: ReplyFraming | null }): string;
  historicalMutationReceipts(history: readonly unknown[]): Receipts; receiptBlock(receipts: Receipts, language: string, historical: true): string;
  replaceTrustedLinkPlaceholders(input: LinkPlaceholderInput): Promise<string>; sanitizeResponseText(value: string): string;
  now(): number;
}
/** Framing uses observed facts; read interpretation, owned quotations and recommendations remain bounded host ports. */
export function createRouterObservedReply<Fact extends RouterReplyFact, Lookup, Snapshot, Overview, Receipts>(dependencies: RouterReplyDependencies<Fact, Lookup, Snapshot, Overview, Receipts>) {
  const { answerFromTaskReturnFields, answerFromObservedReads, renderHistoricalEvidence, historicalRecap,
    callResponseSynthesis, renderPersonalKnowledge, resolveNextBestAction, composeExecutionReply,
    historicalMutationReceipts, receiptBlock, replaceTrustedLinkPlaceholders, sanitizeResponseText, now } = dependencies;
  async function composeRouterObservedReply(input: RouterReplyInput<Fact, Lookup, Snapshot, Overview>) {
    const { execution, runtimeIntent, operationalActions, recap, conversationReply, language, rawPastTurns,
      currentUserText, user, personalKnowledge, referenceSnapshot, options, requestId, dailyOverview,
      requestReferenceTime, timezone, phoneNumber } = input;
    let { modelElapsedMs } = input;
    // Text planned before execution is not evidence of its outcome. Operational
    // acknowledgements come exclusively from observed execution facts.
    const hasSubscriptionInfo = operationalActions.some(action => action.domain === 'subscription' && action.action === 'info');
    const planFacts = execution.facts.filter(fact => fact.tool === TOOL_NAMES.MANAGE_SUBSCRIPTION
      && fact.success && fact.complete && Array.isArray(fact.presentationData?.benefits)
      && typeof fact.presentationData?.hasProAccess === 'boolean');
    // Presentation only, after observed entitlement: never accept model-authored
    // links or use prose as execution authority. Unscoped billing remains canonical.
    const planProse = planFacts.length && planFacts.length === execution.facts.length
      && !recap && conversationReply
      && !/https?:\/\/|www\.|\[checkout_url\]|\[auth_url\]/i.test(conversationReply)
      ? conversationReply : '';
    const hasTaskRead = execution.facts.some(fact =>
      ([TOOL_NAMES.MANAGE_TASK, TOOL_NAMES.GET_UNIFIED_AGENDA] as readonly unknown[]).includes(fact.tool)
      && (['read', 'list'] as readonly unknown[]).includes(fact.requestedAction));
    // Only a single simple read can replace its card. Complex/mixed turns retain
    // existing observation behavior; no identity is inferred from query or title.
    const simpleFieldAction = !recap
      && operationalActions.length === 1 && operationalActions[0]!.returnFields
      ? operationalActions[0] : null;
    const fieldAnswer = simpleFieldAction
      ? answerFromTaskReturnFields(simpleFieldAction, execution.facts, user.id, language) : null;
    let interpretationOutcome: unknown;
    let knowledgeRefs = runtimeIntent.knowledgeRefs || [];
    let framing: ReplyFraming | null = recap?.recapMode === 'historical'
      ? { before: renderHistoricalEvidence(rawPastTurns, undefined, user.id, language), after: '' } : null;
    if (recap?.recapMode === 'current' && hasSubscriptionInfo && !hasTaskRead) {
      const coverage = language === 'en'
        ? 'Current observations cover returned rows only. Unseen or filtered items remain unknown; complete inventory coverage is not verified.'
        : 'Las observaciones actuales cubren solo las filas devueltas. Los elementos no vistos o filtrados siguen desconocidos; no se verifica cobertura del inventario completo.';
      const failed = execution.facts.some(fact => !fact.success || !fact.complete);
      const unknown = language === 'en'
        ? 'Current status in failed or partial reads is unknown.'
        : 'El estado actual en consultas fallidas o parciales es desconocido.';
      framing = { before: [historicalRecap(rawPastTurns, language), coverage, failed ? unknown : ''].filter(Boolean).join('\n\n'), after: '' };
    }
    const answerFacts = hasSubscriptionInfo
      ? execution.facts.filter(fact => ([TOOL_NAMES.MANAGE_TASK, TOOL_NAMES.GET_UNIFIED_AGENDA] as readonly unknown[]).includes(fact.tool))
      : execution.facts;
    if (!simpleFieldAction && (!hasSubscriptionInfo || hasTaskRead) && (runtimeIntent.answerFromResults === true || recap?.recapMode === 'current')
      && operationalActions.every(action => action.domain === 'subscription' && action.action === 'info'
        || ['read', 'list', 'search', 'next', 'status', 'metrics'].includes(action.action as string))) {
      const answer = await answerFromObservedReads({ userText: currentUserText, facts: answerFacts, language, correlationId: options?.correlationId, conversationHistory: rawPastTurns, currentRecap: recap?.recapMode === 'current', referenceSnapshot, userId: user.id,
        personalKnowledge: personalKnowledge.lookup, selectedKnowledgeRefs: knowledgeRefs,
        onKnowledgeRefs: refs => { knowledgeRefs = [...new Set([...knowledgeRefs, ...refs])].slice(0, 8); },
        onInterpretationOutcome: outcome => { interpretationOutcome = outcome; },
        retainedTaskCoverage: answerFacts.slice(0, 12).flatMap(fact => (fact[TASK_CARD_COVERAGE] || [])
          .map(item => ({ ...item, callId: fact.callId }))).slice(0, 100),
      });
      if (answer) framing = { before: answer, after: '' };
    }
    if (!recap && !hasSubscriptionInfo && !planFacts.length && !hasTaskRead && (execution.excluded || []).length > 0 && execution.facts.length > 0) {
      const synthesisStart = now();
      const excludedFraming = await callResponseSynthesis({
        userText: currentUserText,
        facts: execution.facts,
        excludedClauses: execution.excluded,
        language,
        correlationId: options?.correlationId,
      });
      modelElapsedMs += now() - synthesisStart;
      const before = [framing?.before, excludedFraming?.before].filter(Boolean).join('\n\n');
      framing = before ? { before, after: '' } : null;
    }

    const personalAnswer = renderPersonalKnowledge(knowledgeRefs, personalKnowledge.lookup, user.id, language);
    const nextAction = recap || hasSubscriptionInfo || planFacts.length || simpleFieldAction || knowledgeRefs.length ? null : await resolveNextBestAction({
      executionFacts: execution.facts,
      userText: currentUserText,
      correlationId: requestId,
      dailyOverview,
      user,
      language,
      referenceTime: requestReferenceTime,
      timezone,
    });

    if (nextAction?.recommendationText) {
      framing = {
        before: framing?.before || '',
        after: [framing?.after, nextAction.recommendationText].filter(Boolean).join('\n\n'),
      };
    }

    if (planProse) framing = { before: [framing?.before, planProse].filter(Boolean).join('\n\n'), after: framing?.after || '' };

    const mixedInfoFacts = hasSubscriptionInfo && execution.facts.length > 1
      ? execution.facts.filter(fact => fact.tool === TOOL_NAMES.MANAGE_SUBSCRIPTION && fact.requestedAction === 'info') : [];
    // Keep the complete pure-information card beside the ordinary read cards;
    // mixed-batch summaries must not drop provider uncertainty or checkout authority.
    let finalReply = fieldAnswer || (mixedInfoFacts.length
      ? [framing?.before, composeExecutionReply(execution.facts.filter(fact => !mixedInfoFacts.includes(fact)), language),
        ...mixedInfoFacts.map(fact => fact.card), framing?.after].filter(Boolean).join('\n\n')
      : composeExecutionReply(execution.facts, language, { framing }));
    if (hasTaskRead && execution.excluded?.length) finalReply += `\n\n${language === 'en'
      ? 'Excluded instructions were not executed.' : 'Las instrucciones excluidas no se ejecutaron.'}`;
    if (!finalReply) finalReply = safeIntentError(language);
    // Historical execution quotes survive prose classification, unavailable synthesis,
    // and partial read errors, but never become current-state evidence.
    if (!recap && !hasSubscriptionInfo && operationalActions.every(action => ['read', 'list', 'search', 'next', 'status', 'metrics'].includes(action.action as string))
      && execution.facts.some(fact => !fact.success || !fact.complete)) {
      const historicalBlock = receiptBlock(historicalMutationReceipts(rawPastTurns), language, true);
      if (historicalBlock && !finalReply.includes(historicalBlock)) finalReply += `\n\n${historicalBlock}`;
    }
    finalReply = await replaceTrustedLinkPlaceholders({ text: finalReply, user, phoneNumber });
    finalReply = sanitizeResponseText(finalReply);
    // Stored originals are not operational prose, link templates or new evidence.
    if (personalAnswer) finalReply += `\n\n${personalAnswer}`;

    return { finalReply, interpretationOutcome, modelElapsedMs };
  }
  return { composeRouterObservedReply };
}
