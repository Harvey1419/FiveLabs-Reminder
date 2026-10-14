import { safeLogSnippet } from './router-action-preparation.js';
import type { createRouterActionPreparation, RouterActionResponse } from './router-action-preparation.js';
import type { createRouterTurnInitialization, RouterInitialHistoryTurn, RouterTurnInitializationOptions } from './router-turn-initialization.js';
import type { RouterProfileFact, RouterProfileDecision } from './router-profile-context.js';
import type { createRouterContextReads, RouterContextMemory, RouterKnowledgeIndex } from './router-context-reads.js';
import type { createRouterPromptPreparation } from './router-prompt-preparation.js';
import type { createRouterActiveRun, RouterActiveRunResponse } from './router-active-run.js';
import type { createRouterForegroundDecision, RouterForegroundResponse } from './router-foreground-decision.js';
import type { createRouterExecutionBoundary, RouterProjectedResult } from './router-execution-boundary.js';
import type { createRouterObservedReply, RouterReplyFact } from './router-observed-reply.js';
import type { RouterLifecycleEntities } from './router-turn-lifecycle.js';
import type { WorkingMemoryState } from '../core/working-memory-cache.js';
import type { PromptOverview, AgentPromptInput } from '../core/agent-prompt.js';
import type { FollowupOverview } from './router-turn-decisions.js';
export type RouterPipelineFact = RouterProfileFact & RouterReplyFact;
export type RouterPipelineOverview = (PromptOverview & FollowupOverview) | null | undefined;
export type RouterPipelineResult<Fact, Entities> = RouterActiveRunResponse<Fact, Entities> | RouterForegroundResponse<Entities>
  | RouterActionResponse<Entities> | RouterProjectedResult<Fact, Entities>;
export interface RouterPipelineDependencies<Fact extends RouterPipelineFact, Entities extends RouterLifecycleEntities, Memory extends RouterContextMemory,
  Lookup, Snapshot, Overview extends RouterPipelineOverview, Subscription, Integration extends AgentPromptInput['googleIntegration'], Knowledge extends RouterKnowledgeIndex<Memory> & { lookup: Lookup }, Receipts> {
  initializeRouterTurn: ReturnType<typeof createRouterTurnInitialization<Fact>>['initializeRouterTurn'];
  loadRouterContext: ReturnType<typeof createRouterContextReads<Memory, Overview, Subscription, Integration, Knowledge>>['loadRouterContext'];
  getWorkingMemory(key: unknown): WorkingMemoryState | null | undefined;
  freezeTaskReferenceSnapshot(memory: WorkingMemoryState | null | undefined): Snapshot;
  formatWorkingMemoryPrompt(key: unknown, overview: Overview): string;
  prepareRouterPrompt: ReturnType<typeof createRouterPromptPreparation>['prepareRouterPrompt'];
  resolveRouterActiveRun: ReturnType<typeof createRouterActiveRun<Fact, Entities>>['resolveRouterActiveRun'];
  decideRouterForeground: ReturnType<typeof createRouterForegroundDecision<Entities>>['decideRouterForeground'];
  prepareRouterActions: ReturnType<typeof createRouterActionPreparation<Lookup, Entities>>['prepareRouterActions'];
  executeRouterActions: ReturnType<typeof createRouterExecutionBoundary<Fact, Entities>>['executeRouterActions'];
  composeRouterObservedReply: ReturnType<typeof createRouterObservedReply<Fact, Lookup, Snapshot, Overview, Receipts>>['composeRouterObservedReply'];
  projectRouterResult: ReturnType<typeof createRouterExecutionBoundary<Fact, Entities>>['projectRouterResult'];
  logger: Pick<Console, 'log'>;
}
/** Stages retain admission/execution authority; the coordinator preserves order, shared state and short-circuit results. */
export function createRouterPipeline<Fact extends RouterPipelineFact, Entities extends RouterLifecycleEntities, Memory extends RouterContextMemory,
  Lookup, Snapshot, Overview extends RouterPipelineOverview, Subscription, Integration extends AgentPromptInput['googleIntegration'], Knowledge extends RouterKnowledgeIndex<Memory> & { lookup: Lookup }, Receipts>(dependencies: RouterPipelineDependencies<Fact, Entities, Memory, Lookup, Snapshot, Overview, Subscription, Integration, Knowledge, Receipts>) {
  const { initializeRouterTurn, loadRouterContext, getWorkingMemory, freezeTaskReferenceSnapshot, formatWorkingMemoryPrompt,
    prepareRouterPrompt, resolveRouterActiveRun, decideRouterForeground, prepareRouterActions, executeRouterActions,
    composeRouterObservedReply, projectRouterResult, logger: console } = dependencies;
  /**
   * Canonical agent route:
   * context -> one Hermes semantic decision -> TurnIntent -> deterministic tools -> cards.
   * execute_turn is mandatory even for ordinary conversation; there is no prose
   * bypass and no second semantic recovery call.
   */
  async function routeMessageInternal(messageText: unknown, userOrPhone: unknown, history: readonly RouterInitialHistoryTurn[] = [], options: RouterTurnInitializationOptions = {}, contextEffects: Fact[] = []): Promise<RouterPipelineResult<Fact, Entities>> {
    const { startMs, requestReferenceTime, profileContext, user, currentUserText, phoneNumber, isAdmin, requestId,
      inputModality, nowStr, nowHumanStr, trustedMessageText, sanitizedUserText, isAttachmentOnlyTurn } = initializeRouterTurn(messageText, userOrPhone, history, options, contextEffects);
    let { timezone, language } = profileContext;
    const applyDecisionContext = async (decision: RouterProfileDecision) => {
      try { return await profileContext.applyDecisionContext(decision); }
      finally { timezone = profileContext.timezone; language = profileContext.language; }
    };

    const { relevantMemories, standingPreferences, dailyOverview, subscription, googleIntegration,
      memoryRetrievalStatus, contextElapsedMs, entitlementKnown, isPro, personalKnowledge, memoryHints, preferenceHints } = await loadRouterContext({ user, currentUserText, phoneNumber, timezone });
    const workingMemoryKey = phoneNumber || user.id;
    const workingMemory = getWorkingMemory(workingMemoryKey);
    // Freeze referents before read tools replace the current Working Memory view.
    const referenceSnapshot = freezeTaskReferenceSnapshot(workingMemory);
    const workingMemoryText = formatWorkingMemoryPrompt(workingMemoryKey, dailyOverview);
    if (workingMemory) {
      console.log(
        `[router req=${requestId}] working-memory source=${workingMemory.source || 'unknown'} lastAction=${workingMemory.lastAction || 'unknown'} items=${workingMemory.items?.length || 0} notification="${safeLogSnippet(workingMemory.notificationContent, 100)}"`,
      );
    } else {
      console.log(`[router req=${requestId}] working-memory empty`);
    }
    console.log(`[router req=${requestId}] context loaded in ${contextElapsedMs}ms memories=${relevantMemories?.length || 0} preferences=${standingPreferences?.length || 0} activeNotices=${dailyOverview?.pendingConfirmationReminders?.length || 0} google=${googleIntegration ? 'present' : 'absent'} pro=${isPro}`);

    const { rawPastTurns, pastTurns, latestAssistantMessage, historyChars, prompt, messages } = prepareRouterPrompt({
      user, history, messageText, currentUserText, trustedMessageText, sanitizedUserText, nowStr, nowHumanStr,
      timezone, phoneNumber, memoryHints, preferenceHints, dailyOverview, workingMemoryText, googleIntegration,
      isAdmin, isPro, inputModality, entitlementKnown, subscription, language, memoryRetrievalStatus,
    });

    const activeRunOutcome = await resolveRouterActiveRun({
      user, phoneNumber, requestReferenceTime, requestId, isPro, prompt, pastTurns,
      messageText, currentUserText, messages, options, applyDecisionContext,
      get language() { return language; }, get timezone() { return timezone; },
    });
    if (activeRunOutcome.handled) return activeRunOutcome.response;
    const { supersedesRunId, preserveExistingActiveRun } = activeRunOutcome;

    const foregroundOutcome = await decideRouterForeground({
      rawPastTurns, user, messages, isAdmin, isAttachmentOnlyTurn, requestId, prompt, pastTurns,
      historyChars, relevantMemories, options, language, currentUserText, workingMemoryKey,
    });
    if (!foregroundOutcome.accepted) return foregroundOutcome.response;
    const { intent: admittedIntent, hasHistoricalEvidence } = foregroundOutcome;
    let { modelElapsedMs } = foregroundOutcome;

    const actionPreparation = await prepareRouterActions({
      admittedIntent, user, dailyOverview, workingMemory, requestId, requestReferenceTime, rawPastTurns,
      hasHistoricalEvidence, personalKnowledge, phoneNumber, isAttachmentOnlyTurn, startMs, contextElapsedMs,
      modelElapsedMs, applyDecisionContext, get language() { return language; }, get timezone() { return timezone; },
    });
    if (actionPreparation.handled) return actionPreparation.response;
    const { runtimeIntent, learningMetadata, operationalActions, recap, conversationReply } = actionPreparation;

    const { execution, toolElapsedMs } = await executeRouterActions({
      runtimeIntent, operationalActions, recap, user, isPro, language, currentUserText, requestReferenceTime,
      timezone, options, latestAssistantMessage, supersedesRunId, preserveExistingActiveRun, requestId,
    });

    const observedReply = await composeRouterObservedReply({
      execution, runtimeIntent, operationalActions, recap, conversationReply, language, rawPastTurns,
      currentUserText, user, personalKnowledge, referenceSnapshot, options, requestId, dailyOverview,
      requestReferenceTime, timezone, phoneNumber, modelElapsedMs,
    });
    const { finalReply, interpretationOutcome } = observedReply;
    modelElapsedMs = observedReply.modelElapsedMs;

    return projectRouterResult({
      execution, runtimeIntent, learningMetadata, user, language, finalReply, interpretationOutcome,
      requestId, startMs, contextElapsedMs, modelElapsedMs, toolElapsedMs,
    });
  }
  return { routeMessageInternal };
}
