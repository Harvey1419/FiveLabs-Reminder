import { createRouterPipeline, type RouterPipelineFact, type RouterPipelineOverview, type RouterPipelineResult, type RouterPipelineDependencies } from './router-pipeline.js';
import { createRouterTurnInitialization, type RouterTurnInitializationDependencies, type RouterInitialHistoryTurn } from './router-turn-initialization.js';
import { createRouterTurnLifecycle, type RouterTurnLifecycleDependencies, type RouterLifecycleEntities } from './router-turn-lifecycle.js';
import { createRouterObservedReply, type RouterReplyDependencies } from './router-observed-reply.js';
import { createRouterExecutionBoundary, type RouterExecutionDependencies } from './router-execution-boundary.js';
import { createRouterActionPreparation, type RouterActionDependencies } from './router-action-preparation.js';
import { createRouterForegroundDecision, type RouterForegroundDependencies } from './router-foreground-decision.js';
import { createRouterActiveRun, type RouterActiveRunDependencies, type RouterActiveRunOutcome } from './router-active-run.js';
import { createRouterPromptPreparation, type RouterPromptDependencies } from './router-prompt-preparation.js';
import { createRouterContextReads, type RouterContextReadDependencies, type RouterContextMemory, type RouterKnowledgeIndex } from './router-context-reads.js';
import type { AgentPromptInput } from '../core/agent-prompt.js';

export interface RouterAssemblyDependencies<Fact extends RouterPipelineFact, Memory extends RouterContextMemory, Lookup, Snapshot,
  Overview extends RouterPipelineOverview, Subscription, Integration extends AgentPromptInput['googleIntegration'],
  Knowledge extends RouterKnowledgeIndex<Memory> & { lookup: Lookup }, Receipts> {
  initialization: RouterTurnInitializationDependencies<Fact>;
  lifecycle: Omit<RouterTurnLifecycleDependencies<Fact, RouterPipelineResult<Fact, RouterLifecycleEntities>>, 'routeMessageInternal'>;
  observedReply: Omit<RouterReplyDependencies<Fact, Lookup, Snapshot, Overview, Receipts>, 'replaceTrustedLinkPlaceholders'>;
  execution: Omit<RouterExecutionDependencies<Fact, RouterLifecycleEntities>, 'conversationStateEntities'>;
  actions: Omit<RouterActionDependencies<Lookup, RouterLifecycleEntities>, 'conversationStateEntities'>;
  foreground: Omit<RouterForegroundDependencies<RouterLifecycleEntities>, 'conversationStateEntities'>;
  activeRun: Omit<RouterActiveRunDependencies<Fact, RouterLifecycleEntities>, 'conversationStateEntities'>;
  prompt: RouterPromptDependencies;
  context: RouterContextReadDependencies<Memory, Overview, Subscription, Integration, Knowledge>;
  workingMemory: Pick<RouterPipelineDependencies<Fact, RouterLifecycleEntities, Memory, Lookup, Snapshot, Overview, Subscription, Integration, Knowledge, Receipts>, 'getWorkingMemory' | 'freezeTaskReferenceSnapshot' | 'formatWorkingMemoryPrompt'>;
  logger: Pick<Console, 'log'>;
}

/** Typed stage assembly owns its lifecycle binding; SDK/service adapters stay in the host. */
export function createRouterAssembly<Fact extends RouterPipelineFact, Memory extends RouterContextMemory, Lookup, Snapshot,
  Overview extends RouterPipelineOverview, Subscription, Integration extends AgentPromptInput['googleIntegration'],
  Knowledge extends RouterKnowledgeIndex<Memory> & { lookup: Lookup }, Receipts>(dependencies: RouterAssemblyDependencies<Fact, Memory, Lookup, Snapshot, Overview, Subscription, Integration, Knowledge, Receipts>) {
  // Lazy closures preserve construction order and resolve the lifecycle/pipeline cycle
  // only when a turn starts, after every stage has been initialized.
  const { routeMessageInternal }: ReturnType<typeof createRouterPipeline<Fact, RouterLifecycleEntities, Memory, Lookup, Snapshot, Overview, Subscription, Integration, Knowledge, Receipts>> = createRouterPipeline<Fact, RouterLifecycleEntities, Memory, Lookup, Snapshot, Overview, Subscription, Integration, Knowledge, Receipts>({
    initializeRouterTurn: (...args) => initializeRouterTurn(...args),
    loadRouterContext: (...args) => loadRouterContext(...args),
    ...dependencies.workingMemory,
    prepareRouterPrompt: (...args) => prepareRouterPrompt(...args),
    resolveRouterActiveRun: (...args): Promise<RouterActiveRunOutcome<Fact, RouterLifecycleEntities>> => resolveRouterActiveRun(...args),
    decideRouterForeground: (...args) => decideRouterForeground(...args),
    prepareRouterActions: (...args) => prepareRouterActions(...args),
    executeRouterActions: (...args) => executeRouterActions(...args),
    composeRouterObservedReply: (...args) => composeRouterObservedReply(...args),
    projectRouterResult: (...args) => projectRouterResult(...args),
    logger: dependencies.logger,
  });
  const { initializeRouterTurn } = createRouterTurnInitialization<Fact>(dependencies.initialization);
  const { conversationStateEntities, routeMessage }: ReturnType<typeof createRouterTurnLifecycle<Fact, RouterPipelineResult<Fact, RouterLifecycleEntities>>> = createRouterTurnLifecycle<Fact, RouterPipelineResult<Fact, RouterLifecycleEntities>>({
    ...dependencies.lifecycle,
    // The lifecycle forwards opaque persisted turns; initialization owns their projection.
    routeMessageInternal: (text, user, history, options, effects): Promise<RouterPipelineResult<Fact, RouterLifecycleEntities>> => routeMessageInternal(text, user, history as readonly RouterInitialHistoryTurn[], options, effects),
  });
  const { composeRouterObservedReply } = createRouterObservedReply<Fact, Lookup, Snapshot, Overview, Receipts>({
    ...dependencies.observedReply, replaceTrustedLinkPlaceholders: (...args) => replaceTrustedLinkPlaceholders(...args),
  });
  const { executeRouterActions, projectRouterResult } = createRouterExecutionBoundary<Fact, RouterLifecycleEntities>({
    ...dependencies.execution, conversationStateEntities: (...args): RouterLifecycleEntities => conversationStateEntities(...args),
  });
  const { prepareRouterActions, replaceTrustedLinkPlaceholders } = createRouterActionPreparation<Lookup, RouterLifecycleEntities>({
    ...dependencies.actions, conversationStateEntities: (...args): RouterLifecycleEntities => conversationStateEntities(...args),
  });
  const { decideRouterForeground } = createRouterForegroundDecision<RouterLifecycleEntities>({
    ...dependencies.foreground, conversationStateEntities: (...args): RouterLifecycleEntities => conversationStateEntities(...args),
  });
  const { resolveRouterActiveRun } = createRouterActiveRun<Fact, RouterLifecycleEntities>({
    ...dependencies.activeRun, conversationStateEntities: (...args): RouterLifecycleEntities => conversationStateEntities(...args),
  });
  const { prepareRouterPrompt } = createRouterPromptPreparation(dependencies.prompt);
  const { loadRouterContext } = createRouterContextReads<Memory, Overview, Subscription, Integration, Knowledge>(dependencies.context);
  return { routeMessage };
}
