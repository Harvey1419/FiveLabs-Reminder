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

export const AGENT_RUN_TTL_MS = 15 * 60 * 1000;

function resolveThreadId(userOrPhone) {
  if (!userOrPhone) return 'anonymous';
  if (typeof userOrPhone === 'string') return userOrPhone.trim();
  return String(userOrPhone.phone_number || userOrPhone.id || 'anonymous').trim();
}

function resolveUserId(userOrPhone) {
  if (userOrPhone && typeof userOrPhone === 'object' && userOrPhone.id) {
    return String(userOrPhone.id).trim();
  }
  return null;
}

async function stagePendingActions(runId, actions) {
  try {
    return await stagePreparedActionsInDb(runId, actions);
  } catch (error) {
    try {
      await updateAgentRunInDb(runId, { status: 'failed' });
    } catch (cleanupError) {
      error.cleanupError = cleanupError;
    }
    throw error;
  }
}

function storedDomainCall(action, executionContext) {
  const call = action.execution_fact?._domainCall;
  if (call?.toolName && call.params && typeof call.params === 'object') return call;
  return buildDomainCall(action.payload || {}, executionContext);
}

function approvedDomainCall(action, context) {
  if (action.payload?.domain) return buildDomainCall(action.payload, context);
  // Compatibility with already persisted, fully resolved approval payloads.
  const toolName = {
    project: TOOL_NAMES.MANAGE_PROJECT, entity: TOOL_NAMES.MANAGE_ENTITY,
    reminder: TOOL_NAMES.MANAGE_REMINDER, task: TOOL_NAMES.MANAGE_TASK,
  }[action.domain];
  return { valid: Boolean(toolName), toolName, params: action.payload };
}

function toolResultFromExecutionFact(executionFact) {
  if (!executionFact || typeof executionFact !== 'object') return executionFact;
  const { _domainCall: _storedCall, ...toolResult } = executionFact;
  return toolResult;
}

function executionFactWithDomainCall(result, toolName, params) {
  return {
    ...result,
    _domainCall: { toolName, params },
  };
}

async function claimPendingRun(run, expectedStatus, executionContext, nextStatus = 'running') {
  const caller = executionContext.user;
  if (caller?.id && run.user_id && String(caller.id) !== String(run.user_id)) return false;
  return updateAgentRunIfStatusFromDb({
    runId: run.id, userId: run.user_id, threadId: run.thread_id,
    expectedStatus, nextStatus, now: executionContext.referenceTime || new Date(),
  });
}

async function observedRunResult(run, executionContext) {
  if (executionContext.user?.id && run.user_id && String(executionContext.user.id) !== String(run.user_id)) {
    return { success: false, executed: false, facts: [], results: [], error: 'Request owner mismatch.' };
  }
  const actions = await getPreparedActionsFromDb(run.id);
  const results = actions.filter(action => action.execution_fact).map(action => ({
    callId: action.call_id, result: toolResultFromExecutionFact(action.execution_fact),
  }));
  const facts = actions.filter(action => action.execution_fact).map(action => {
    const call = storedDomainCall(action, executionContext);
    return createExecutionFact({ ...call, result: toolResultFromExecutionFact(action.execution_fact), callId: action.call_id, language: executionContext.language, timezone: executionContext.timezone || executionContext.user?.timezone });
  });
  return { success: false, executed: false, status: 'not_acquired', results, facts,
    error: executionContext.language === 'en'
      ? 'This request is already being processed or is no longer pending. I did not repeat it.'
      : 'Esta solicitud ya se está procesando o dejó de estar pendiente. No la repetí.' };
}

/**
 * Retrieve the active AgentRun with its prepared actions.
 */
export async function getActiveAgentRun(userOrPhone, now = new Date()) {
  const threadId = resolveThreadId(userOrPhone);
  const userId = resolveUserId(userOrPhone);
  const run = await getActiveRunFromDb(threadId, userId, now);
  if (!run) return null;

  const preparedActions = await getPreparedActionsFromDb(run.id);
  return {
    ...run,
    preparedActions: preparedActions || [],
  };
}

/**
 * Create an AgentRun in waiting_for_approval state for batch destructive operations.
 */
export async function createApprovalRun({
  user,
  kind = 'entity_destructive_batch',
  preparedActions = [],
  question = '',
  expiresAtMs = null,
  context = {},
  referenceTime = null,
}) {
  const threadId = resolveThreadId(user);
  const userId = resolveUserId(user);
  const baseNow = referenceTime
    ? (referenceTime instanceof Date ? referenceTime.getTime() : new Date(referenceTime).getTime())
    : Date.now();
  const expiresAt = new Date(baseNow + (expiresAtMs || AGENT_RUN_TTL_MS)).toISOString();

  const existingRun = await getActiveAgentRun(user, new Date(baseNow));
  if (existingRun?.status === 'running') return null;

  const run = await createAgentRunInDb({
    userId,
    threadId,
    kind,
    waitingFor: {
      type: 'approval',
      question: String(question || '').trim(),
    },
    context: { ...context, referenceTime: new Date(baseNow).toISOString(), timezone: user?.timezone || null },
    expiresAt,
    initialStatus: 'failed',
  });

  const staged = await stagePendingActions(run.id, preparedActions);
  if (existingRun && !await updateAgentRunIfStatusFromDb({
    runId: existingRun.id, userId, threadId, expectedStatus: existingRun.status,
    nextStatus: 'cancelled', now: new Date(baseNow),
  })) return null;
  if (!await updateAgentRunIfStatusFromDb({
    runId: run.id, userId, threadId, expectedStatus: 'failed',
    nextStatus: 'waiting_for_approval', now: new Date(baseNow),
  })) return null;
  await recordExecutionEventInDb({
    runId: run.id,
    userId,
    threadId,
    eventType: 'run_created_waiting_approval',
    factPayload: { kind, actionCount: preparedActions.length, question },
  });

  return {
    ...run,
    status: 'waiting_for_approval',
    preparedActions: staged,
  };
}

/**
 * Create an AgentRun in waiting_for_input state for incomplete operations (e.g. reminder without time).
 */
export async function createInputRun({
  user,
  kind = 'reminder_creation',
  partialAction = null,
  partialActions = [],
  missingFields = [],
  question = '',
  expiresAtMs = null,
  context = {},
  referenceTime = null,
  timezone = null,
  supersedesRunId = null,
  preserveExistingActiveRun = false,
}) {
  const threadId = resolveThreadId(user);
  const userId = resolveUserId(user);
  const baseNow = referenceTime
    ? (referenceTime instanceof Date ? referenceTime.getTime() : new Date(referenceTime).getTime())
    : Date.now();
  const expiresAt = new Date(baseNow + (expiresAtMs || AGENT_RUN_TTL_MS)).toISOString();

  // Invariant 1: Ensure any previous active run on this thread is cancelled before creating a new one
  const currentTime = referenceTime || new Date();
  const existingRun = await getActiveAgentRun(user, currentTime);
  if (existingRun?.status === 'running') return null;
  const referenceAnchor = referenceTime != null && Number.isFinite(baseNow)
    ? new Date(baseNow).toISOString()
    : null;
  const run = await createAgentRunInDb({
    userId,
    threadId,
    kind,
    waitingFor: {
      type: 'missing_fields',
      fields: missingFields,
      question: String(question || '').trim(),
    },
    context: {
      ...context,
      ...(referenceAnchor ? { referenceTime: referenceAnchor } : {}),
      ...(timezone ? { timezone } : {}),
    },
    expiresAt,
    // Keep the candidate out of active-run lookups until staging and retirement
    // have both succeeded. `failed` is an existing durable status, not a new FSM state.
    initialStatus: 'failed',
  });

  const drafts = Array.isArray(partialActions) && partialActions.length > 0
    ? partialActions
    : (partialAction ? [partialAction] : []);

  const prepared = drafts.map((draft, idx) => ({
    callId: `call-${idx + 1}`,
    domain: draft.domain,
    action: draft.action,
    targetId: null,
    targetName: draft.target || draft.content || draft.title || null,
    payload: draft,
    status: 'prepared',
  }));

  const staged = await stagePendingActions(run.id, prepared);
  if (supersedesRunId || (existingRun && !preserveExistingActiveRun)) {
    let retired = false;
    try {
      retired = supersedesRunId
        ? await cancelActiveInputRunFromDb({
          runId: supersedesRunId,
          expectedStatus: existingRun?.status || 'waiting_for_input',
          userId,
          threadId,
          now: currentTime,
        })
        : await updateAgentRunIfStatusFromDb({
          runId: existingRun.id,
          userId,
          threadId,
          expectedStatus: existingRun.status,
          nextStatus: 'cancelled',
          now: currentTime,
        });
    } catch (error) {
      // The candidate is already inert. Do not attempt a second cleanup write;
      // the retirement operation may have an unknown outcome.
      throw error;
    }
    if (!retired) {
      return null;
    }
  }
  let activated = false;
  try {
    activated = await updateAgentRunIfStatusFromDb({
      runId: run.id,
      userId,
      threadId,
      expectedStatus: 'failed',
      nextStatus: 'waiting_for_input',
      now: currentTime,
    });
  } catch (error) {
    // The activation write may have reached storage despite an error response.
    // Make one bounded fail-closed demotion attempt and preserve the staged payload.
    try {
      await updateAgentRunIfStatusFromDb({
        runId: run.id,
        userId,
        threadId,
        expectedStatus: 'waiting_for_input',
        nextStatus: 'failed',
        now: currentTime,
      });
    } catch { /* keep the activation outcome explicitly unknown */ }
    return {
      ...run,
      activationFailed: true,
      activationStatusUnknown: true,
      preparedActions: staged,
    };
  }
  if (!activated) {
    return {
      ...run,
      activationFailed: true,
      preparedActions: staged,
    };
  }
  await recordExecutionEventInDb({
    runId: run.id,
    userId,
    threadId,
    eventType: 'run_created_waiting_input',
    factPayload: { kind, missingFields, question, draftCount: drafts.length },
  });

  return {
    ...run,
    status: 'waiting_for_input',
    preparedActions: staged,
  };
}

/** Cancel the exact active input run only after its replacement has validated. */
export async function cancelSupersededInputRun(user, runId, now = new Date()) {
  if (!user || !runId) return false;
  const existing = await getActiveAgentRun(user, now);
  if (existing?.id !== runId || !['waiting_for_input', 'waiting_for_approval'].includes(existing.status)) return false;
  return cancelActiveInputRunFromDb({
    expectedStatus: existing.status,
    runId,
    userId: resolveUserId(user),
    threadId: resolveThreadId(user),
    now,
  });
}

/**
 * Execute an approved run (approve_all or approve_subset) deterministically.
 */
export async function executeApprovalDecision({
  run,
  decision, // 'approve_all' | 'approve_subset' | 'reject'
  selectedCallIds = [],
  executionContext = {},
  executeTool: injectedExecuteTool = executeTool,
}) {
  const preparedActions = await getPreparedActionsFromDb(run.id);
  const threadId = run.thread_id;
  const userId = run.user_id;

  if (decision === 'reject') {
    if (!await claimPendingRun(run, 'waiting_for_approval', executionContext, 'cancelled')) return observedRunResult(run, executionContext);
    for (const action of preparedActions) {
      await updatePreparedActionInDb(run.id, action.call_id, { status: 'skipped' });
    }
    await recordExecutionEventInDb({
      runId: run.id,
      userId,
      threadId,
      eventType: 'run_rejected_by_user',
      factPayload: {},
    });
    return {
      success: true,
      executed: false,
      status: 'cancelled',
      facts: [],
      message: 'Operación cancelada por el usuario.',
    };
  }

  if (!Array.isArray(preparedActions) || preparedActions.length === 0) {
    return {
      success: false,
      executed: false,
      status: run.status,
      executedCount: 0,
      results: [],
      facts: [],
      message: 'No durably prepared actions are available for approval.',
    };
  }

  const actionsToExecute = decision === 'approve_all'
    ? preparedActions
    : preparedActions.filter((a) => selectedCallIds.includes(a.call_id));

  if (decision === 'approve_subset' && selectedCallIds.some(id => !preparedActions.some(action => action.call_id === id))) {
    return { success: false, executed: false, facts: [], results: [], error: 'The selection contains an unknown prepared action.' };
  }

  if (actionsToExecute.length === 0) {
    return {
      success: false,
      executed: false,
      status: run.status,
      executedCount: 0,
      results: [],
      facts: [],
      message: 'No matching prepared actions found for selection.',
    };
  }

  const actionsToSkip = preparedActions.filter((a) => !actionsToExecute.includes(a));

  if (!await claimPendingRun(run, 'waiting_for_approval', executionContext)) return observedRunResult(run, executionContext);

  for (const action of actionsToSkip) {
    await updatePreparedActionInDb(run.id, action.call_id, { status: 'skipped' });
  }

  const executedResults = [];
  const executedFacts = [];
  const executionUser = (executionContext.user && typeof executionContext.user === 'object' && executionContext.user.id)
    ? executionContext.user
    : { ...(typeof executionContext.user === 'object' ? executionContext.user : {}), id: userId || threadId };

  // Persist an unknown outcome before each external write. An interrupted
  // execution remains observable and is never automatically replayed.
  const executeApprovedTool = async (call, actions) => {
    const fence = { success: false, outcome: 'unknown', errorCode: 'WRITE_OUTCOME_UNKNOWN',
      _domainCall: { toolName: call.toolName, params: call.params } };
    for (const action of actions) {
      const stored = await updatePreparedActionInDb(run.id, action.call_id, { status: 'failed', executionFact: fence });
      if (!stored) throw new Error('Could not persist approval write fence.');
    }
    try {
      const result = await injectedExecuteTool(call);
      if (!result || typeof result.success !== 'boolean') return fence;
      return executionFactWithDomainCall(result, call.toolName, call.params);
    } catch { return fence; }
  };

  // Group by domain for efficient execution if entity/project batch delete
  if (run.kind === 'entity_destructive_batch') {
    const isProject = actionsToExecute[0]?.domain === 'project';
    const targetTool = isProject ? TOOL_NAMES.MANAGE_PROJECT : TOOL_NAMES.MANAGE_ENTITY;
    const entityIds = actionsToExecute
      .map((a) => a.target_id)
      .filter(Boolean);

    if (entityIds.length > 0) {
      const deleteResult = await executeApprovedTool({
        ...executionContext,
        user: executionUser,
        toolName: targetTool,
        params: {
          action: 'delete',
          ...(isProject ? { projectIds: entityIds } : { entityIds }),
        },
        clarificationResolution: true,
      }, actionsToExecute);

      const fact = createExecutionFact({
        toolName: targetTool,
        params: { action: 'delete', ...(isProject ? { projectIds: entityIds } : { entityIds }) },
        result: deleteResult,
        callId: 'approval_exec',
        language: executionContext.language || 'es',
        timezone: executionContext.timezone || executionContext.user?.timezone,
      });
      executedFacts.push(fact);

      for (const action of actionsToExecute) {
        await updatePreparedActionInDb(run.id, action.call_id, {
          status: deleteResult.success ? 'executed' : 'failed',
          executionFact: deleteResult,
        });
        executedResults.push({ callId: action.call_id, result: deleteResult });
      }
    }
  } else {
    // Generic action-by-action dispatch
    for (const action of actionsToExecute) {
      const call = approvedDomainCall(action, executionContext);
      const toolName = call.toolName || 'orchestrator';
      const toolResult = call.valid ? await executeApprovedTool({
        ...executionContext,
        user: executionUser,
        toolName,
        params: call.params,
        clarificationResolution: true,
      }, [action]) : { success: false, errorCode: 'INVALID_APPROVED_ACTION', error: executionContext.language === 'en' ? 'The approved action is invalid; it was not executed.' : 'La acción aprobada no es válida; no se ejecutó.' };

      const fact = createExecutionFact({
        toolName,
        params: call.params || {},
        result: toolResult,
        callId: action.call_id,
        language: executionContext.language || 'es',
        timezone: executionContext.timezone || executionContext.user?.timezone,
      });
      executedFacts.push(fact);

      await updatePreparedActionInDb(run.id, action.call_id, {
        status: toolResult.success ? 'executed' : 'failed',
        executionFact: toolResult,
      });
      executedResults.push({ callId: action.call_id, result: toolResult });
      if (toolResult.outcome === 'unknown') break;
    }
  }

  const allSucceeded = executedResults.length > 0 && executedResults.every((r) => r.result?.success === true && r.result.partialSuccess !== true && r.result.complete !== false && r.result.outcome !== 'unknown');
  const finalStatus = allSucceeded ? 'completed' : 'failed';

  await updateAgentRunInDb(run.id, { status: finalStatus });
  await recordExecutionEventInDb({
    runId: run.id,
    userId,
    threadId,
    eventType: 'run_approval_executed',
    factPayload: { decision, executedCount: executedResults.length, status: finalStatus },
  });

  updateWorkingMemoryFromFacts(executionUser, executedFacts);

  return {
    success: allSucceeded,
    executed: true,
    status: finalStatus,
    executedCount: executedResults.length,
    results: executedResults,
    facts: executedFacts,
  };
}

/**
 * Resume a suspended run waiting for input with structured delta fields.
 */
export async function executeContinuationDecision({
  run,
  suppliedFields = {},
  actionInputs = [],
  executionContext = {},
  executeTool: injectedExecuteTool = executeTool,
}) {
  const preparedActions = await getPreparedActionsFromDb(run.id);
  if (preparedActions.length === 0) {
    return { success: false, error: 'No prepared actions found in run.' };
  }
  const inputIds = new Set(actionInputs.map(input => input.callId));
  if (inputIds.size !== actionInputs.length || actionInputs.some(input => !preparedActions.some(action => action.call_id === input.callId && action.status === 'prepared'))) {
    return { success: false, executed: false, error: executionContext.language === 'en' ? 'I could not match that change to a pending action.' : 'No pude asociar ese cambio a una acción pendiente.' };
  }
  if (!await claimPendingRun(run, 'waiting_for_input', executionContext)) return observedRunResult(run, executionContext);

  const userId = run.user_id;
  const threadId = run.thread_id;
  const executionUser = (executionContext.user && typeof executionContext.user === 'object' && executionContext.user.id)
    ? executionContext.user
    : { ...(typeof executionContext.user === 'object' ? executionContext.user : {}), id: userId || threadId };

  const executedResults = [];
  const executedFacts = [];
  let allSucceeded = true;
  const pendingInputs = [];

  for (const action of preparedActions) {
    if (action.status === 'executed' || action.status === 'skipped') {
      if (action.status === 'executed' && action.execution_fact) {
        const toolCall = storedDomainCall(action, executionContext);
        const result = toolResultFromExecutionFact(action.execution_fact);
        executedFacts.push(createExecutionFact({
          toolName: toolCall.toolName,
          params: toolCall.params,
          result,
          callId: action.call_id,
          language: executionContext.language || 'es',
          timezone: executionContext.timezone || executionContext.user?.timezone,
        }));
        executedResults.push({ callId: action.call_id, result });
      }
      continue;
    }
    if (action.status === 'failed') {
      allSucceeded = false;
      if (action.execution_fact) {
        const toolCall = storedDomainCall(action, executionContext);
        const result = toolResultFromExecutionFact(action.execution_fact);
        const failedFact = createExecutionFact({
          toolName: toolCall.toolName,
          params: toolCall.params,
          result,
          callId: action.call_id,
          language: executionContext.language || 'es',
          timezone: executionContext.timezone || executionContext.user?.timezone,
        });
        executedFacts.push(failedFact);
        executedResults.push({ callId: action.call_id, result });
      }
      if (action.execution_fact?.outcome === 'unknown') break;
      continue;
    }

    const delta = actionInputs.length ? (actionInputs.find(input => input.callId === action.call_id)?.fields || {}) : suppliedFields;
    const missingFields = action.payload?.missingFields || run.waiting_for?.fields || [];
    const mergedPayload = {
      ...action.payload,
      ...delta,
    };

    // Protect draft-specific content/title from being overwritten by a blanket suppliedFields
    if (!actionInputs.length && action.payload?.content && !missingFields.includes('content')) {
      mergedPayload.content = action.payload.content;
    }
    if (!actionInputs.length && action.payload?.title && !missingFields.includes('title') && !missingFields.includes('content')) {
      mergedPayload.title = action.payload.title;
    }
    if (action.target_name && !mergedPayload.content && !mergedPayload.title) {
      mergedPayload.content = action.target_name;
    }

    if (action.payload?.schedule || delta.schedule) {
      mergedPayload.schedule = mergePendingSchedule(
        action.payload?.schedule,
        delta.schedule
      );
    }

    const inheritedScheduleDate = ['calendar_date_time', 'weekday_time', 'relative_day_time'].includes(action.payload?.schedule?.kind)
      && (delta.schedule?.kind === 'local_time'
        || delta.schedule?.kind === 'inherit_context'
        || !delta.schedule)
      && Number.isFinite(new Date(run.context?.referenceTime || NaN).getTime());
    const actionExecutionContext = {
      ...executionContext,
      ...(inheritedScheduleDate && run.context?.timezone ? { timezone: run.context.timezone } : {}),
      ...(inheritedScheduleDate ? { referenceTime: new Date(run.context.referenceTime) } : {}),
    };
    const prepared = buildDomainCall(mergedPayload, actionExecutionContext);
    if (!prepared.valid || prepared.orchestrationOnly) {
      const pending = pendingInputForValidation(prepared, executionContext.language);
      if (pending) pendingInputs.push(pending);
      const result = {
        success: false,
        requiresClarification: Boolean(pending),
        error: pending?.question || prepared.error || prepared.result?.error || 'The resumed action is not executable.',
        errorCode: prepared.errorCode || 'INVALID_RESUMED_ACTION',
      };
      const fact = createExecutionFact({
        toolName: prepared.toolName || 'orchestrator',
        params: prepared.params || {},
        result,
        callId: action.call_id,
        language: executionContext.language || 'es',
        timezone: executionContext.timezone || executionContext.user?.timezone,
      });
      executedFacts.push(fact);
      allSucceeded = false;
      await updatePreparedActionInDb(run.id, action.call_id, {
        status: pending ? 'prepared' : 'failed',
        payload: { ...mergedPayload, ...(pending ? { missingFields: pending.fields } : {}) },
        executionFact: result,
      });
      executedResults.push({ callId: action.call_id, result });
      continue;
    }

    const { toolName, params } = prepared;
    const writeFence = {
      success: false,
      outcome: 'unknown',
      errorCode: 'WRITE_OUTCOME_UNKNOWN',
      error: 'The action may have been applied; it will not be replayed automatically.',
      _domainCall: { toolName, params },
    };
    const fencedAction = await updatePreparedActionInDb(run.id, action.call_id, {
      status: 'failed',
      executionFact: writeFence,
    });
    if (!fencedAction) {
      throw new Error('Could not persist the write fence; the action was not executed.');
    }

    let result;
    try {
      result = await injectedExecuteTool({
        ...actionExecutionContext,
        user: executionUser,
        toolName,
        params,
        clarificationResolution: true,
      });
      if (!result || typeof result.success !== 'boolean') {
        throw new Error('The tool returned no observable execution result.');
      }
    } catch (error) {
      const unknownResult = {
        success: false,
        outcome: 'unknown',
        errorCode: 'UNKNOWN_WRITE_OUTCOME',
        error: error instanceof Error ? error.message : 'The tool outcome could not be observed.',
        _domainCall: { toolName, params },
      };
      const fact = createExecutionFact({
        toolName,
        params,
        result: toolResultFromExecutionFact(unknownResult),
        callId: action.call_id,
        language: executionContext.language || 'es',
        timezone: executionContext.timezone || executionContext.user?.timezone,
      });
      executedFacts.push(fact);
      allSucceeded = false;
      await updatePreparedActionInDb(run.id, action.call_id, {
        status: 'failed',
        executionFact: unknownResult,
      });
      executedResults.push({ callId: action.call_id, result: toolResultFromExecutionFact(unknownResult) });
      break;
    }

    const fact = createExecutionFact({
      toolName,
      params,
      result,
      callId: action.call_id,
      language: executionContext.language || 'es',
      timezone: executionContext.timezone || executionContext.user?.timezone,
    });
    executedFacts.push(fact);

    const unknownWriteOutcome = result.outcome === 'unknown'
      || result.errorCode === 'UNKNOWN_WRITE_OUTCOME';
    const isSuccess = result.success === true && !unknownWriteOutcome;
    if (!isSuccess || result.partialSuccess === true || result.complete === false) allSucceeded = false;
    const persistedResult = executionFactWithDomainCall(
      unknownWriteOutcome ? { ...result, outcome: 'unknown' } : result,
      toolName,
      params,
    );

    await updatePreparedActionInDb(run.id, action.call_id, {
      status: isSuccess ? 'executed' : 'failed',
      executionFact: persistedResult,
    });
    executedResults.push({ callId: action.call_id, result });
    if (unknownWriteOutcome) break;
  }

  const finalStatus = executedFacts.some(fact => fact.outcome === 'unknown') ? 'failed' : pendingInputs.length ? 'waiting_for_input'
    : (allSucceeded && executedResults.length > 0) ? 'completed' : 'failed';

  await updateAgentRunInDb(run.id, {
    status: finalStatus,
    ...(pendingInputs.length ? { waitingFor: {
      fields: [...new Set(pendingInputs.flatMap(input => input.fields))],
      question: [...new Set(pendingInputs.map(input => input.question))].join('\n'),
    } } : {}),
  });
  await recordExecutionEventInDb({
    runId: run.id,
    userId: run.user_id,
    threadId: run.thread_id,
    eventType: 'run_continuation_executed',
    factPayload: { success: allSucceeded, executedCount: executedResults.length, status: finalStatus },
  });

  updateWorkingMemoryFromFacts(executionUser, executedFacts);

  return {
    success: allSucceeded,
    executed: allSucceeded,
    status: finalStatus,
    results: executedResults,
    result: executedResults[0]?.result,
    fact: executedFacts[0],
    facts: executedFacts,
    domain: preparedActions[0]?.domain || 'reminder',
  };
}

/**
 * Format prompt context describing the active run.
 */
export function formatActiveRunPrompt(activeRun) {
  if (!activeRun) return '';
  const lines = [];

  if (activeRun.status === 'waiting_for_approval') {
    lines.push('[OPERACIÓN SUSPENDIDA ESPERANDO APROBACIÓN]');
    lines.push(`runId=${activeRun.id} | kind=${activeRun.kind}`);
    if (activeRun.waiting_for?.question) {
      lines.push(`Pregunta previa al usuario: "${activeRun.waiting_for.question}"`);
    }
    lines.push('Acciones preparadas:');
    for (const a of activeRun.preparedActions) {
      lines.push(` - ${a.call_id}: [${a.domain}.${a.action}] ${a.target_name || ''} (ID: ${a.target_id || 'n/a'})`);
    }
    lines.push('Instrucción: Si corrige o reemplaza la solicitud, responde relation="supersede"; nunca apruebes el contenido anterior. Si el usuario aprueba todo, responde con relation="approval" y decision="approve_all". Si aprueba solo algunos, decision="approve_subset" con los selectedCallIds exactos. Si rechaza o cancela, relation="cancel". Si habla de otro tema no relacionado, relation="unrelated". No afirmes ejecución en reply: Node renderiza hechos observados.');
  } else if (activeRun.status === 'waiting_for_input') {
    lines.push('[OPERACIÓN SUSPENDIDA ESPERANDO DATOS FALTANTES]');
    lines.push(`runId=${activeRun.id} | kind=${activeRun.kind}`);
    if (activeRun.waiting_for?.question) {
      lines.push(`Pregunta previa al usuario: "${activeRun.waiting_for.question}"`);
    }
    if (activeRun.waiting_for?.fields?.length) {
      lines.push(`Campos faltantes: ${activeRun.waiting_for.fields.join(', ')}`);
    }
    const drafts = (activeRun.preparedActions || []).map((action) => {
      return {
        ...(action.payload || {}),
        callId: action.call_id,
        domain: action.domain,
        action: action.action,
      };
    });
    if (drafts.length > 0) lines.push(`Borrador completo: ${JSON.stringify(drafts)}`);
    const fieldKeys = CONTINUATION_DECISION_SCHEMA.properties.actionInputs.items.properties.fields.required;
    lines.push(`Formato estricto de cada actionInputs[].fields: ${JSON.stringify(Object.fromEntries(fieldKeys.map(key => [key, null])))}. Incluye TODAS estas claves; sustituye null solo por cambios explícitos. Null no borra campos; para borrar usa clearFields. Los objetos schedule también incluyen todas sus claves con null cuando no aplican.`);
    if (activeRun.context?.referenceTime) lines.push(`Ancla original: ${activeRun.context.referenceTime} | zona horaria: ${activeRun.context.timezone || 'n/a'}`);
    lines.push('Instrucción: Reanuda solo si el mensaje actual aporta datos faltantes al borrador existente; responde relation="resume" y actionInputs con el callId exacto y fields para cada delta; diferentes horarios requieren entradas distintas. Usa únicamente actionInputs; para un valor compartido repítelo en cada callId afectado. Incluye tanto datos faltantes como correcciones explícitas del mensaje actual. Si el usuario cambia de tema, relation="unrelated". Si cancela, relation="cancel". Si el usuario reemplaza explícitamente toda la solicitud, responde relation="supersede"; Node volverá a interpretar el mensaje actual por el flujo canónico completo y no mezclará el borrador anterior.');
  }

  if (activeRun.status === 'waiting_for_approval') {
    lines.push(`Borrador completo: ${JSON.stringify(activeRun.preparedActions || [])}`);
    if (activeRun.context?.referenceTime) lines.push(`Ancla original: ${activeRun.context.referenceTime} | zona horaria: ${activeRun.context.timezone || 'n/a'}`);
  }
  lines.push('FORMATO DE ESTA RESPUESTA: usa únicamente el JSON de decisión suspendida definido por response_format (relation, responseLanguage, profileUpdate, reply y actionInputs o decision/selectedCallIds). No emitas TurnIntent/actions. Incluye todas las propiedades del esquema; usa null para las que no apliquen.');
  return lines.join('\n');
}
