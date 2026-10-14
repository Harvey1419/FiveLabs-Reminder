import { createRouterAssembly } from './router-assembly.js';
export const { routeMessage } = createRouterAssembly({
  initialization: {
    profileDependencies: {
      extractCurrentUserText: ((...args: Parameters<typeof extractCurrentUserText>) => extractCurrentUserText(...args)) as unknown as Parameters<typeof createRouterAssembly>[0]['initialization']['profileDependencies']['extractCurrentUserText'], detectLanguageFromText: ((...args: Parameters<typeof detectLanguageFromText>) => detectLanguageFromText(...args)) as unknown as Parameters<typeof createRouterAssembly>[0]['initialization']['profileDependencies']['detectLanguageFromText'],
      explicitEnglishDirective: EXPLICIT_ENGLISH_DIRECTIVE_RE as unknown as Parameters<typeof createRouterAssembly>[0]['initialization']['profileDependencies']['explicitEnglishDirective'], explicitSpanishDirective: EXPLICIT_SPANISH_DIRECTIVE_RE as unknown as Parameters<typeof createRouterAssembly>[0]['initialization']['profileDependencies']['explicitSpanishDirective'],
      assertTurnLease: ((...args: Parameters<typeof assertTurnLease>) => assertTurnLease(...args)) as unknown as Parameters<typeof createRouterAssembly>[0]['initialization']['profileDependencies']['assertTurnLease'], updateUserPreferences: ((...args: Parameters<typeof updateUserPreferences>) => updateUserPreferences(...args)) as unknown as Parameters<typeof createRouterAssembly>[0]['initialization']['profileDependencies']['updateUserPreferences'], createExecutionFact: ((...args: Parameters<typeof createExecutionFact>) => createExecutionFact(...args)) as unknown as Parameters<typeof createRouterAssembly>[0]['initialization']['profileDependencies']['createExecutionFact'],
    },
    isAdminUser: ((...args: Parameters<typeof isAdminUser>) => isAdminUser(...args)) as unknown as Parameters<typeof createRouterAssembly>[0]['initialization']['isAdminUser'], computeOffsetMinutes: ((...args: Parameters<typeof computeOffsetMinutes>) => computeOffsetMinutes(...args)) as unknown as Parameters<typeof createRouterAssembly>[0]['initialization']['computeOffsetMinutes'],
    nowISO: ((...args: Parameters<typeof nowISO>) => nowISO(...args)) as unknown as Parameters<typeof createRouterAssembly>[0]['initialization']['nowISO'], nowHuman: ((...args: Parameters<typeof nowHuman>) => nowHuman(...args)) as unknown as Parameters<typeof createRouterAssembly>[0]['initialization']['nowHuman'],
    hydrateClarificationStateFromHistory: ((...args: Parameters<typeof hydrateClarificationStateFromHistory>) => hydrateClarificationStateFromHistory(...args)) as unknown as Parameters<typeof createRouterAssembly>[0]['initialization']['hydrateClarificationStateFromHistory'],
    hydrateWorkingMemoryFromHistory: ((...args: Parameters<typeof hydrateWorkingMemoryFromHistory>) => hydrateWorkingMemoryFromHistory(...args)) as unknown as Parameters<typeof createRouterAssembly>[0]['initialization']['hydrateWorkingMemoryFromHistory'], now: () => Date.now(), logger: console,
  },
  lifecycle: {
    getClarificationStateSnapshot: ((...args: Parameters<typeof getClarificationStateSnapshot>) => getClarificationStateSnapshot(...args)) as unknown as Parameters<typeof createRouterAssembly>[0]['lifecycle']['getClarificationStateSnapshot'],
    getWorkingMemorySnapshot: ((...args: Parameters<typeof getWorkingMemorySnapshot>) => getWorkingMemorySnapshot(...args)) as unknown as Parameters<typeof createRouterAssembly>[0]['lifecycle']['getWorkingMemorySnapshot'], carryCreationReceiptEvents: ((...args: Parameters<typeof carryCreationReceiptEvents>) => carryCreationReceiptEvents(...args)) as unknown as Parameters<typeof createRouterAssembly>[0]['lifecycle']['carryCreationReceiptEvents'],
    carryOperationalEvidence: ((...args: Parameters<typeof carryOperationalEvidence>) => carryOperationalEvidence(...args)) as unknown as Parameters<typeof createRouterAssembly>[0]['lifecycle']['carryOperationalEvidence'], composeExecutionReply: ((...args: Parameters<typeof composeExecutionReply>) => composeExecutionReply(...args)) as unknown as Parameters<typeof createRouterAssembly>[0]['lifecycle']['composeExecutionReply'],
  },
  observedReply: {
    answerFromTaskReturnFields: ((...args: Parameters<typeof answerFromTaskReturnFields>) => answerFromTaskReturnFields(...args)) as unknown as Parameters<typeof createRouterAssembly>[0]['observedReply']['answerFromTaskReturnFields'], answerFromObservedReads: ((...args: Parameters<typeof answerFromObservedReads>) => answerFromObservedReads(...args)) as unknown as Parameters<typeof createRouterAssembly>[0]['observedReply']['answerFromObservedReads'],
    renderHistoricalEvidence: ((...args: Parameters<typeof renderHistoricalEvidence>) => renderHistoricalEvidence(...args)) as unknown as Parameters<typeof createRouterAssembly>[0]['observedReply']['renderHistoricalEvidence'], historicalRecap: ((...args: Parameters<typeof historicalRecap>) => historicalRecap(...args)) as unknown as Parameters<typeof createRouterAssembly>[0]['observedReply']['historicalRecap'],
    callResponseSynthesis: ((...args: Parameters<typeof callResponseSynthesis>) => callResponseSynthesis(...args)) as unknown as Parameters<typeof createRouterAssembly>[0]['observedReply']['callResponseSynthesis'], renderPersonalKnowledge: ((...args: Parameters<typeof renderPersonalKnowledge>) => renderPersonalKnowledge(...args)) as unknown as Parameters<typeof createRouterAssembly>[0]['observedReply']['renderPersonalKnowledge'],
    resolveNextBestAction: ((...args: Parameters<typeof resolveNextBestAction>) => resolveNextBestAction(...args)) as unknown as Parameters<typeof createRouterAssembly>[0]['observedReply']['resolveNextBestAction'], composeExecutionReply: ((...args: Parameters<typeof composeExecutionReply>) => composeExecutionReply(...args)) as unknown as Parameters<typeof createRouterAssembly>[0]['observedReply']['composeExecutionReply'],
    historicalMutationReceipts: ((...args: Parameters<typeof historicalMutationReceipts>) => historicalMutationReceipts(...args)) as unknown as Parameters<typeof createRouterAssembly>[0]['observedReply']['historicalMutationReceipts'], receiptBlock: ((...args: Parameters<typeof receiptBlock>) => receiptBlock(...args)) as unknown as Parameters<typeof createRouterAssembly>[0]['observedReply']['receiptBlock'],
    sanitizeResponseText: ((...args: Parameters<typeof sanitizeResponseText>) => sanitizeResponseText(...args)) as unknown as Parameters<typeof createRouterAssembly>[0]['observedReply']['sanitizeResponseText'], now: () => Date.now(),
  },
  execution: {
    executeTurnIntent: ((...args: Parameters<typeof executeTurnIntent>) => executeTurnIntent(...args)) as unknown as Parameters<typeof createRouterAssembly>[0]['execution']['executeTurnIntent'], inferIntentFromTool: ((...args: Parameters<typeof inferIntentFromTool>) => inferIntentFromTool(...args)) as unknown as Parameters<typeof createRouterAssembly>[0]['execution']['inferIntentFromTool'],
    mutationReceiptsFromFacts: ((...args: Parameters<typeof mutationReceiptsFromFacts>) => mutationReceiptsFromFacts(...args)) as unknown as Parameters<typeof createRouterAssembly>[0]['execution']['mutationReceiptsFromFacts'],
    now: () => Date.now(), logger: console,
  },
  actions: {
    normalizeTurnIntentForRuntime: ((...args: Parameters<typeof normalizeTurnIntentForRuntime>) => normalizeTurnIntentForRuntime(...args)) as unknown as Parameters<typeof createRouterAssembly>[0]['actions']['normalizeTurnIntentForRuntime'], renderOperationalEvidence: ((...args: Parameters<typeof renderOperationalEvidence>) => renderOperationalEvidence(...args)) as unknown as Parameters<typeof createRouterAssembly>[0]['actions']['renderOperationalEvidence'],
    renderHistoricalEvidence: ((...args: Parameters<typeof renderHistoricalEvidence>) => renderHistoricalEvidence(...args)) as unknown as Parameters<typeof createRouterAssembly>[0]['actions']['renderHistoricalEvidence'], renderPersonalKnowledge: ((...args: Parameters<typeof renderPersonalKnowledge>) => renderPersonalKnowledge(...args)) as unknown as Parameters<typeof createRouterAssembly>[0]['actions']['renderPersonalKnowledge'],
    getGoogleConnectUrl: ((...args: Parameters<typeof getGoogleConnectUrl>) => getGoogleConnectUrl(...args)) as unknown as Parameters<typeof createRouterAssembly>[0]['actions']['getGoogleConnectUrl'],
    now: () => Date.now(), logger: console,
  },
  foreground: {
    operationalEvidenceFromHistory: ((...args: Parameters<typeof operationalEvidenceFromHistory>) => operationalEvidenceFromHistory(...args)) as unknown as Parameters<typeof createRouterAssembly>[0]['foreground']['operationalEvidenceFromHistory'], callChatCompletion: ((...args: Parameters<typeof callChatCompletion>) => callChatCompletion(...args)) as unknown as Parameters<typeof createRouterAssembly>[0]['foreground']['callChatCompletion'],
    getWorkingMemory: ((...args: Parameters<typeof getWorkingMemory>) => getWorkingMemory(...args)) as unknown as Parameters<typeof createRouterAssembly>[0]['foreground']['getWorkingMemory'], saveWorkingMemory: ((...args: Parameters<typeof saveWorkingMemory>) => saveWorkingMemory(...args)) as unknown as Parameters<typeof createRouterAssembly>[0]['foreground']['saveWorkingMemory'],
    now: () => Date.now(), logger: console,
  },
  activeRun: {
    getActiveAgentRun: ((...args: Parameters<typeof getActiveAgentRun>) => getActiveAgentRun(...args)) as unknown as Parameters<typeof createRouterAssembly>[0]['activeRun']['getActiveAgentRun'], formatActiveRunPrompt: ((...args: Parameters<typeof formatActiveRunPrompt>) => formatActiveRunPrompt(...args)) as unknown as Parameters<typeof createRouterAssembly>[0]['activeRun']['formatActiveRunPrompt'],
    callChatCompletion: ((...args: Parameters<typeof callChatCompletion>) => callChatCompletion(...args)) as unknown as Parameters<typeof createRouterAssembly>[0]['activeRun']['callChatCompletion'], executeApprovalDecision: ((...args: Parameters<typeof executeApprovalDecision>) => executeApprovalDecision(...args)) as unknown as Parameters<typeof createRouterAssembly>[0]['activeRun']['executeApprovalDecision'],
    executeContinuationDecision: ((...args: Parameters<typeof executeContinuationDecision>) => executeContinuationDecision(...args)) as unknown as Parameters<typeof createRouterAssembly>[0]['activeRun']['executeContinuationDecision'], updateAgentRunIfStatusFromDb: ((...args: Parameters<typeof updateAgentRunIfStatusFromDb>) => updateAgentRunIfStatusFromDb(...args)) as unknown as Parameters<typeof createRouterAssembly>[0]['activeRun']['updateAgentRunIfStatusFromDb'],
    composeExecutionReply: ((...args: Parameters<typeof composeExecutionReply>) => composeExecutionReply(...args)) as unknown as Parameters<typeof createRouterAssembly>[0]['activeRun']['composeExecutionReply'],
    mutationReceiptsFromFacts: ((...args: Parameters<typeof mutationReceiptsFromFacts>) => mutationReceiptsFromFacts(...args)) as unknown as Parameters<typeof createRouterAssembly>[0]['activeRun']['mutationReceiptsFromFacts'], logger: console,
  },
  prompt: {
    shouldEnforceBillingForUser: ((...args: Parameters<typeof shouldEnforceBillingForUser>) => shouldEnforceBillingForUser(...args)) as unknown as Parameters<typeof createRouterAssembly>[0]['prompt']['shouldEnforceBillingForUser'],
    selectReminderProProvider: ((...args: Parameters<typeof selectReminderProProvider>) => selectReminderProProvider(...args)) as unknown as Parameters<typeof createRouterAssembly>[0]['prompt']['selectReminderProProvider'], getBillingProvider: () => process.env.BILLING_PROVIDER,
    buildAgentCorePrompt: ((...args: Parameters<typeof buildAgentCorePrompt>) => buildAgentCorePrompt(...args)) as unknown as Parameters<typeof createRouterAssembly>[0]['prompt']['buildAgentCorePrompt'],
  },
  context: {
    getMemoryServiceMethod: name => memoryService[name as keyof typeof memoryService],
    retrieveRelevantMemories: ((...args: Parameters<typeof retrieveRelevantMemories>) => retrieveRelevantMemories(...args)) as unknown as Parameters<typeof createRouterAssembly>[0]['context']['retrieveRelevantMemories'],
    retrieveStandingPreferences: ((...args: Parameters<typeof retrieveStandingPreferences>) => retrieveStandingPreferences(...args)) as unknown as Parameters<typeof createRouterAssembly>[0]['context']['retrieveStandingPreferences'],
    getDailyOverview: ((...args: Parameters<typeof getDailyOverview>) => getDailyOverview(...args)) as unknown as Parameters<typeof createRouterAssembly>[0]['context']['getDailyOverview'], getUserSubscription: ((...args: Parameters<typeof getUserSubscription>) => getUserSubscription(...args)) as unknown as Parameters<typeof createRouterAssembly>[0]['context']['getUserSubscription'],
    getUserIntegration: ((...args: Parameters<typeof getUserIntegration>) => getUserIntegration(...args)) as unknown as Parameters<typeof createRouterAssembly>[0]['context']['getUserIntegration'], hasProAccess: ((...args: Parameters<typeof hasProAccess>) => hasProAccess(...args)) as unknown as Parameters<typeof createRouterAssembly>[0]['context']['hasProAccess'],
    buildPersonalKnowledge: ((...args: Parameters<typeof buildPersonalKnowledge>) => buildPersonalKnowledge(...args)) as unknown as Parameters<typeof createRouterAssembly>[0]['context']['buildPersonalKnowledge'], now: () => Date.now(), logger: console,
  },
  workingMemory: {
    getWorkingMemory: ((...args: Parameters<typeof getWorkingMemory>) => getWorkingMemory(...args)) as unknown as Parameters<typeof createRouterAssembly>[0]['workingMemory']['getWorkingMemory'], freezeTaskReferenceSnapshot: ((...args: Parameters<typeof freezeTaskReferenceSnapshot>) => freezeTaskReferenceSnapshot(...args)) as unknown as Parameters<typeof createRouterAssembly>[0]['workingMemory']['freezeTaskReferenceSnapshot'],
    formatWorkingMemoryPrompt: ((...args: Parameters<typeof formatWorkingMemoryPrompt>) => formatWorkingMemoryPrompt(...args)) as unknown as Parameters<typeof createRouterAssembly>[0]['workingMemory']['formatWorkingMemoryPrompt'],
  },
  logger: console,
});
import { bindAuthoritativeFollowupTargets } from './router-turn-decisions.js';
export { bindAuthoritativeFollowupTargets };
import { sanitizeUserQueryText } from './router-context.js';
export { sanitizeUserQueryText };
import { buildPersonalKnowledge, renderPersonalKnowledge } from './personal-knowledge.js';
import { assertTurnLease } from '../core/turn-lease.js';
import { callChatCompletion, callResponseSynthesis } from '../providers/client.js';
import { retrieveRelevantMemories, retrieveStandingPreferences } from '../../features/memory/service.js';
import * as memoryService from '../../features/memory/service.js';
import {
  getDailyOverview,
  getUserSubscription,
  getUserIntegration,
  hasProAccess,
} from '../../infrastructure/database/index.js';
import { shouldEnforceBillingForUser } from '../../infrastructure/database/subscriptions.js';
import { selectReminderProProvider } from '../tools/reminder-pro.js';
import { getGoogleConnectUrl } from '../../integrations/google/auth.js';
import { buildAgentCorePrompt } from '../core/agent-core.js';
import {
  formatWorkingMemoryPrompt,
  getWorkingMemory,
  saveWorkingMemory,
  getWorkingMemorySnapshot,
  hydrateWorkingMemoryFromHistory,
  sanitizeResponseText,
} from '../core/working-memory.js';
import { hydrateClarificationStateFromHistory, getClarificationStateSnapshot } from './clarification-flow.js';
import { composeExecutionReply, createExecutionFact } from '../core/execution-facts.js';
import { isAdminUser } from '../../shared/auth.js';
import { nowISO, nowHuman, computeOffsetMinutes } from '../../shared/time.js';
import { updateUserPreferences } from '../../infrastructure/database/users.js';
import { extractCurrentUserText } from '../../shared/current-user-input.js';
import { detectLanguageFromText, EXPLICIT_ENGLISH_DIRECTIVE_RE, EXPLICIT_SPANISH_DIRECTIVE_RE } from '../../shared/language-detection.js';
import { executeTurnIntent, inferIntentFromTool } from './intent-executor.js';
import { normalizeTurnIntentForRuntime } from './intent-normalizer.js';
import { resolveNextBestAction } from './next-best-action.js';
import { answerFromObservedReads, answerFromTaskReturnFields, mutationReceiptsFromFacts, historicalMutationReceipts, carryCreationReceiptEvents, receiptBlock, historicalRecap, freezeTaskReferenceSnapshot, carryOperationalEvidence, operationalEvidenceFromHistory, renderOperationalEvidence, renderHistoricalEvidence } from './observed-answer.js';


import {
  getActiveAgentRun,
  executeApprovalDecision,
  executeContinuationDecision,
  formatActiveRunPrompt,
} from '../core/agent-run.js';
import { updateAgentRunIfStatusFromDb } from '../../infrastructure/database/agent-runs.js';


