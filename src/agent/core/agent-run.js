import {
  createAgentRunInDb,
  getActiveRunFromDb,
  updateAgentRunInDb,
  stagePreparedActionsInDb,
  getPreparedActionsFromDb,
  updatePreparedActionInDb,
  recordExecutionEventInDb,
} from '../../infrastructure/database/agent-runs.js';
import { mergePendingSchedule } from './pending-intent.js';
import { resolveTypedSchedule } from '../orchestration/typed-schedule.js';
import { executeTool } from '../tools/index.js';
import { TOOL_NAMES } from '../contracts/tool-names.js';
import { createExecutionFact } from './execution-facts.js';

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

  // Invariant 1: Ensure any previous active run on this thread is cancelled before creating a new one
  const existingRun = await getActiveAgentRun(user);
  if (existingRun) {
    await updateAgentRunInDb(existingRun.id, { status: 'cancelled' });
  }

  const run = await createAgentRunInDb({
    userId,
    threadId,
    kind,
    waitingFor: {
      type: 'approval',
      question: String(question || '').trim(),
    },
    context,
    expiresAt,
  });

  const staged = await stagePreparedActionsInDb(run.id, preparedActions);
  await recordExecutionEventInDb({
    runId: run.id,
    userId,
    threadId,
    eventType: 'run_created_waiting_approval',
    factPayload: { kind, actionCount: preparedActions.length, question },
  });

  return {
    ...run,
    preparedActions: staged,
  };
}

/**
 * Create an AgentRun in waiting_for_input state for incomplete operations (e.g. reminder without time).
 */
export async function createInputRun({
  user,
  kind = 'reminder_creation',
  partialAction,
  missingFields = [],
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

  // Invariant 1: Ensure any previous active run on this thread is cancelled before creating a new one
  const existingRun = await getActiveAgentRun(user);
  if (existingRun) {
    await updateAgentRunInDb(existingRun.id, { status: 'cancelled' });
  }

  const run = await createAgentRunInDb({
    userId,
    threadId,
    kind,
    waitingFor: {
      type: 'missing_fields',
      fields: missingFields,
      question: String(question || '').trim(),
    },
    context,
    expiresAt,
  });

  const prepared = [{
    callId: 'call-1',
    domain: partialAction.domain,
    action: partialAction.action,
    targetId: null,
    targetName: partialAction.target || partialAction.content || partialAction.title || null,
    payload: partialAction,
    status: 'prepared',
  }];

  const staged = await stagePreparedActionsInDb(run.id, prepared);
  await recordExecutionEventInDb({
    runId: run.id,
    userId,
    threadId,
    eventType: 'run_created_waiting_input',
    factPayload: { kind, missingFields, question },
  });

  return {
    ...run,
    preparedActions: staged,
  };
}

/**
 * Execute an approved run (approve_all or approve_subset) deterministically.
 */
export async function executeApprovalDecision({
  run,
  decision, // 'approve_all' | 'approve_subset' | 'reject'
  selectedCallIds = [],
  executionContext = {},
}) {
  const preparedActions = run.preparedActions || (await getPreparedActionsFromDb(run.id));
  const threadId = run.thread_id;
  const userId = run.user_id;

  if (decision === 'reject') {
    await updateAgentRunInDb(run.id, { status: 'cancelled' });
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

  const actionsToExecute = decision === 'approve_all'
    ? preparedActions
    : preparedActions.filter((a) => selectedCallIds.includes(a.call_id));

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

  for (const action of actionsToSkip) {
    await updatePreparedActionInDb(run.id, action.call_id, { status: 'skipped' });
  }

  const executedResults = [];
  const executedFacts = [];
  const executionUser = (executionContext.user && typeof executionContext.user === 'object' && executionContext.user.id)
    ? executionContext.user
    : { ...(typeof executionContext.user === 'object' ? executionContext.user : {}), id: userId || threadId };

  // Group by domain for efficient execution if entity batch delete
  if (run.kind === 'entity_destructive_batch') {
    const entityIds = actionsToExecute
      .map((a) => a.target_id)
      .filter(Boolean);

    if (entityIds.length > 0) {
      const deleteResult = await executeTool({
        ...executionContext,
        user: executionUser,
        toolName: TOOL_NAMES.MANAGE_ENTITY,
        params: {
          action: 'delete',
          entityIds,
        },
        clarificationResolution: true,
      });

      const fact = createExecutionFact({
        toolName: TOOL_NAMES.MANAGE_ENTITY,
        params: { action: 'delete', entityIds },
        result: deleteResult,
        callId: 'approval_exec',
        language: executionContext.language || 'es',
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
      const toolName = action.domain === 'entity' ? TOOL_NAMES.MANAGE_ENTITY
        : (action.domain === 'reminder' ? TOOL_NAMES.MANAGE_REMINDER : TOOL_NAMES.MANAGE_TASK);
      const toolResult = await executeTool({
        ...executionContext,
        user: executionUser,
        toolName,
        params: action.payload,
        clarificationResolution: true,
      });

      const fact = createExecutionFact({
        toolName,
        params: action.payload,
        result: toolResult,
        callId: action.call_id,
        language: executionContext.language || 'es',
      });
      executedFacts.push(fact);

      await updatePreparedActionInDb(run.id, action.call_id, {
        status: toolResult.success ? 'executed' : 'failed',
        executionFact: toolResult,
      });
      executedResults.push({ callId: action.call_id, result: toolResult });
    }
  }

  const allSucceeded = executedResults.length > 0 && executedResults.every((r) => r.result?.success !== false);
  const finalStatus = allSucceeded ? 'completed' : 'failed';

  await updateAgentRunInDb(run.id, { status: finalStatus });
  await recordExecutionEventInDb({
    runId: run.id,
    userId,
    threadId,
    eventType: 'run_approval_executed',
    factPayload: { decision, executedCount: actionsToExecute.length, status: finalStatus },
  });

  return {
    success: allSucceeded,
    executed: true,
    status: finalStatus,
    executedCount: actionsToExecute.length,
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
  executionContext = {},
}) {
  const preparedActions = run.preparedActions || (await getPreparedActionsFromDb(run.id));
  if (preparedActions.length === 0) {
    return { success: false, error: 'No prepared actions found in run.' };
  }

  const targetAction = preparedActions[0];
  const mergedPayload = {
    ...targetAction.payload,
    ...suppliedFields,
  };

  if (targetAction.payload?.schedule || suppliedFields.schedule) {
    mergedPayload.schedule = mergePendingSchedule(
      targetAction.payload?.schedule,
      suppliedFields.schedule
    );
  }

  let toolName = TOOL_NAMES.MANAGE_REMINDER;
  let params = mergedPayload;

  if (targetAction.domain === 'task') {
    toolName = TOOL_NAMES.MANAGE_TASK;
  } else if (targetAction.domain === 'entity') {
    toolName = TOOL_NAMES.MANAGE_ENTITY;
  } else if (targetAction.domain === 'reminder' && targetAction.action === 'create') {
    const temporal = resolveTypedSchedule(mergedPayload.schedule, {
      referenceTime: executionContext.referenceTime,
      timezone: executionContext.timezone || 'UTC',
    });
    if (!temporal.valid) {
      return {
        success: false,
        executed: false,
        status: run.status,
        error: temporal.error,
        errorCode: temporal.errorCode,
      };
    }
    const content = mergedPayload.content || mergedPayload.title || '';
    params = {
      ...mergedPayload,
      action: 'create',
      items: [{
        content,
        targetTime: temporal.canonical,
        ...(mergedPayload.advanceMinutes ? { advanceMinutes: mergedPayload.advanceMinutes } : {}),
        ...(mergedPayload.recurrence ? { recurrence: mergedPayload.recurrence } : {}),
        ...(mergedPayload.requiresConfirmation ? { requiresConfirmation: true } : {}),
        ...(mergedPayload.nudgeIntervalMinutes ? { nudgeIntervalMinutes: mergedPayload.nudgeIntervalMinutes } : {}),
        ...(mergedPayload.maxNudges ? { maxNudges: mergedPayload.maxNudges } : {}),
      }],
    };
  }

  const userId = run.user_id;
  const threadId = run.thread_id;
  const executionUser = (executionContext.user && typeof executionContext.user === 'object' && executionContext.user.id)
    ? executionContext.user
    : { ...(typeof executionContext.user === 'object' ? executionContext.user : {}), id: userId || threadId };

  const result = await executeTool({
    ...executionContext,
    user: executionUser,
    toolName,
    params,
    clarificationResolution: true,
  });

  const fact = createExecutionFact({
    toolName,
    params,
    result,
    callId: targetAction.call_id,
    language: executionContext.language || 'es',
  });

  const isSuccess = result.success !== false;
  const finalStatus = isSuccess ? 'completed' : 'failed';

  await updatePreparedActionInDb(run.id, targetAction.call_id, {
    status: isSuccess ? 'executed' : 'failed',
    executionFact: result,
  });

  await updateAgentRunInDb(run.id, { status: finalStatus });
  await recordExecutionEventInDb({
    runId: run.id,
    userId: run.user_id,
    threadId: run.thread_id,
    eventType: 'run_continuation_executed',
    factPayload: { success: isSuccess, status: finalStatus },
  });

  return {
    success: isSuccess,
    executed: isSuccess,
    status: finalStatus,
    result,
    fact,
    facts: [fact],
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
    lines.push('Instrucción: Si el usuario aprueba todo, responde con relation="approval" y decision="approve_all". Si aprueba solo algunos, decision="approve_subset" con los selectedCallIds exactos. Si rechaza o cancela, relation="cancel". Si habla de otro tema no relacionado, relation="unrelated".');
  } else if (activeRun.status === 'waiting_for_input') {
    lines.push('[OPERACIÓN SUSPENDIDA ESPERANDO DATOS FALTANTES]');
    lines.push(`runId=${activeRun.id} | kind=${activeRun.kind}`);
    if (activeRun.waiting_for?.question) {
      lines.push(`Pregunta previa al usuario: "${activeRun.waiting_for.question}"`);
    }
    if (activeRun.waiting_for?.fields?.length) {
      lines.push(`Campos faltantes: ${activeRun.waiting_for.fields.join(', ')}`);
    }
    lines.push('Instrucción: Si el mensaje actual aporta los datos faltantes, responde con relation="resume" y suppliedFields con la información estructurada. Si el usuario cambia de tema, relation="unrelated". Si cancela, relation="cancel".');
  }

  return lines.join('\n');
}
