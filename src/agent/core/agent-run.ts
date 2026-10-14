import { createLegacyRunLifecycle } from './active-run-lifecycle.js';
import { createLegacyRunExecutor } from './active-run-executor.js';
import {
  createAgentRunInDb,
  getActiveRunFromDb,
  updateAgentRunInDb,
  stagePreparedActionsInDb,
  getPreparedActionsFromDb,
  updatePreparedActionInDb,
  recordExecutionEventInDb,
  cancelActiveInputRunFromDb,
  updateAgentRunIfStatusFromDb,
} from '../../infrastructure/database/agent-runs.js';
import { mergePendingSchedule } from '../orchestration/typed-schedule.js';
import { buildDomainCall } from '../orchestration/domain-call.js';
import { pendingInputForValidation } from '../orchestration/clarification-presentation.js';
import { executeTool } from '../tools/index.js';
import { TOOL_NAMES } from '../contracts/tool-names.js';
import { CONTINUATION_DECISION_SCHEMA } from '../contracts/agent-run-contracts.js';
import { createExecutionFact } from './execution-facts.js';
import { updateWorkingMemoryFromFacts } from './working-memory-execution.js';

export { AGENT_RUN_TTL_MS } from './active-run-lifecycle.js';

const lifecycle = createLegacyRunLifecycle({
  get createRun() { return createAgentRunInDb as unknown as Parameters<typeof createLegacyRunLifecycle>[0]['createRun']; },
  get getActiveRun() { return getActiveRunFromDb as unknown as Parameters<typeof createLegacyRunLifecycle>[0]['getActiveRun']; },
  get updateRun() { return updateAgentRunInDb as unknown as Parameters<typeof createLegacyRunLifecycle>[0]['updateRun']; },
  get stagePreparedActions() { return stagePreparedActionsInDb as unknown as Parameters<typeof createLegacyRunLifecycle>[0]['stagePreparedActions']; },
  get getPreparedActions() { return getPreparedActionsFromDb as unknown as Parameters<typeof createLegacyRunLifecycle>[0]['getPreparedActions']; },
  get cancelActiveInputRun() { return cancelActiveInputRunFromDb as unknown as Parameters<typeof createLegacyRunLifecycle>[0]['cancelActiveInputRun']; },
  get updateRunIfStatus() { return updateAgentRunIfStatusFromDb as unknown as Parameters<typeof createLegacyRunLifecycle>[0]['updateRunIfStatus']; },
  get recordEvent() { return recordExecutionEventInDb as unknown as Parameters<typeof createLegacyRunLifecycle>[0]['recordEvent']; },
}, CONTINUATION_DECISION_SCHEMA.properties!.actionInputs!.items!.properties!.fields!.required!);

export const { getActiveAgentRun, createApprovalRun, createInputRun, cancelSupersededInputRun, formatActiveRunPrompt } = lifecycle;

export const { executeApprovalDecision, executeContinuationDecision } = createLegacyRunExecutor({
  toolNames: TOOL_NAMES as unknown as Parameters<typeof createLegacyRunExecutor>[0]['toolNames'], buildDomainCall: buildDomainCall as unknown as Parameters<typeof createLegacyRunExecutor>[0]['buildDomainCall'], mergePendingSchedule: mergePendingSchedule as unknown as Parameters<typeof createLegacyRunExecutor>[0]['mergePendingSchedule'], pendingInputForValidation: pendingInputForValidation as unknown as Parameters<typeof createLegacyRunExecutor>[0]['pendingInputForValidation'],
  createExecutionFact: createExecutionFact as unknown as Parameters<typeof createLegacyRunExecutor>[0]['createExecutionFact'], updateWorkingMemoryFromFacts: updateWorkingMemoryFromFacts as unknown as Parameters<typeof createLegacyRunExecutor>[0]['updateWorkingMemoryFromFacts'], executeTool: executeTool as unknown as Parameters<typeof createLegacyRunExecutor>[0]['executeTool'],
  executionRuntime: {
    get getPreparedActions() { return getPreparedActionsFromDb as unknown as Parameters<typeof createLegacyRunExecutor>[0]['executionRuntime']['getPreparedActions']; },
    get updatePreparedAction() { return updatePreparedActionInDb as unknown as Parameters<typeof createLegacyRunExecutor>[0]['executionRuntime']['updatePreparedAction']; },
    get updateRun() { return updateAgentRunInDb as unknown as Parameters<typeof createLegacyRunExecutor>[0]['executionRuntime']['updateRun']; },
    get recordEvent() { return recordExecutionEventInDb as unknown as Parameters<typeof createLegacyRunExecutor>[0]['executionRuntime']['recordEvent']; },
    claimRun: lifecycle.claimPendingRun,
    beforeWrite: async () => {},
  },
});

export type { LegacyPreparedAction, LegacyActiveRun, LegacyActiveRunRuntime, LegacyDomainExecutionCall, LegacyActiveRunResult } from './active-run-executor.js';
export type { LegacyAgentRunWithActions, LegacyPreparedActionInput, LegacyDraftAction, LegacyRunLifecycleStorage, LegacyRunUser, ApprovalRunOptions, InputRunOptions, ActiveRunPromptInput } from './active-run-lifecycle.js';
