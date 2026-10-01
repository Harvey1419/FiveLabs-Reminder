import {
  createAgentRunInDb,
  getActiveRunFromDb,
  updateAgentRunInDb,
  stagePreparedActionsInDb,
  getPreparedActionsFromDb,
  updatePreparedActionInDb,
  recordExecutionEventInDb,
} from '../../infrastructure/database/agent-runs.js';
import { mergePendingSchedule } from '../orchestration/typed-schedule.js';
import { buildDomainCall } from '../orchestration/domain-call.js';
import { executeTool } from '../tools/index.js';
import { TOOL_NAMES } from '../contracts/tool-names.js';
import { createExecutionFact } from './execution-facts.js';
import { saveWorkingMemory } from './working-memory-store.js';

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

  const staged = await stagePendingActions(run.id, preparedActions);
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
  partialAction = null,
  partialActions = [],
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
  await recordExecutionEventInDb({
    runId: run.id,
    userId,
    threadId,
    eventType: 'run_created_waiting_input',
    factPayload: { kind, missingFields, question, draftCount: drafts.length },
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
  const preparedActions = await getPreparedActionsFromDb(run.id);
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

  // Group by domain for efficient execution if entity/project batch delete
  if (run.kind === 'entity_destructive_batch') {
    const isProject = actionsToExecute[0]?.domain === 'project';
    const targetTool = isProject ? TOOL_NAMES.MANAGE_PROJECT : TOOL_NAMES.MANAGE_ENTITY;
    const entityIds = actionsToExecute
      .map((a) => a.target_id)
      .filter(Boolean);

    if (entityIds.length > 0) {
      const deleteResult = await executeTool({
        ...executionContext,
        user: executionUser,
        toolName: targetTool,
        params: {
          action: 'delete',
          ...(isProject ? { projectIds: entityIds } : { entityIds }),
        },
        clarificationResolution: true,
      });

      const fact = createExecutionFact({
        toolName: targetTool,
        params: { action: 'delete', ...(isProject ? { projectIds: entityIds } : { entityIds }) },
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
      const toolName = action.domain === 'project' ? TOOL_NAMES.MANAGE_PROJECT
        : (action.domain === 'entity' ? TOOL_NAMES.MANAGE_ENTITY
        : (action.domain === 'reminder' ? TOOL_NAMES.MANAGE_REMINDER : TOOL_NAMES.MANAGE_TASK));
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

  const allItems = executedResults.flatMap((r) => {
    const data = r.result?.data;
    if (!data) return [];
    if (Array.isArray(data)) return data;
    if (Array.isArray(data.items)) return data.items;
    if (Array.isArray(data.reminders)) return data.reminders;
    if (data.id && (data.title || data.content || data.name || data.summary)) return [data];
    return [];
  });
  if (allItems.length > 0) {
    saveWorkingMemory(executionUser, {
      source: preparedActions[0]?.domain || 'reminder',
      scope: 'current',
      entityType: preparedActions[0]?.domain || 'reminder',
      lastAction: 'created',
      items: allItems,
    });
  }

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
  executeTool: injectedExecuteTool = executeTool,
}) {
  const preparedActions = await getPreparedActionsFromDb(run.id);
  if (preparedActions.length === 0) {
    return { success: false, error: 'No prepared actions found in run.' };
  }

  const userId = run.user_id;
  const threadId = run.thread_id;
  const executionUser = (executionContext.user && typeof executionContext.user === 'object' && executionContext.user.id)
    ? executionContext.user
    : { ...(typeof executionContext.user === 'object' ? executionContext.user : {}), id: userId || threadId };

  const executedResults = [];
  const executedFacts = [];
  let allSucceeded = true;

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
        });
        executedFacts.push(failedFact);
        executedResults.push({ callId: action.call_id, result });
      }
      if (action.execution_fact?.outcome === 'unknown') break;
      continue;
    }

    const missingFields = action.payload?.missingFields || run.waiting_for?.fields || [];
    const mergedPayload = {
      ...action.payload,
      ...suppliedFields,
    };

    // Protect draft-specific content/title from being overwritten by a blanket suppliedFields
    if (action.payload?.content && !missingFields.includes('content')) {
      mergedPayload.content = action.payload.content;
    }
    if (action.payload?.title && !missingFields.includes('title') && !missingFields.includes('content')) {
      mergedPayload.title = action.payload.title;
    }
    if (action.target_name && !mergedPayload.content && !mergedPayload.title) {
      mergedPayload.content = action.target_name;
    }

    if (action.payload?.schedule || suppliedFields.schedule) {
      mergedPayload.schedule = mergePendingSchedule(
        action.payload?.schedule,
        suppliedFields.schedule
      );
    }

    const prepared = buildDomainCall(mergedPayload, executionContext);
    if (!prepared.valid || prepared.orchestrationOnly) {
      const result = {
        success: false,
        error: prepared.error || prepared.result?.error || 'The resumed action is not executable.',
        errorCode: prepared.errorCode || 'INVALID_RESUMED_ACTION',
      };
      const fact = createExecutionFact({
        toolName: prepared.toolName || 'orchestrator',
        params: prepared.params || {},
        result,
        callId: action.call_id,
        language: executionContext.language || 'es',
      });
      executedFacts.push(fact);
      allSucceeded = false;
      await updatePreparedActionInDb(run.id, action.call_id, {
        status: 'failed',
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
        ...executionContext,
        user: executionUser,
        toolName,
        params,
        clarificationResolution: true,
      });
      if (!result || typeof result !== 'object') {
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
    });
    executedFacts.push(fact);

    const unknownWriteOutcome = result.outcome === 'unknown'
      || result.errorCode === 'UNKNOWN_WRITE_OUTCOME';
    const isSuccess = result.success !== false && !unknownWriteOutcome;
    if (!isSuccess) allSucceeded = false;
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

  const finalStatus = (allSucceeded && executedResults.length > 0) ? 'completed' : 'failed';

  await updateAgentRunInDb(run.id, { status: finalStatus });
  await recordExecutionEventInDb({
    runId: run.id,
    userId: run.user_id,
    threadId: run.thread_id,
    eventType: 'run_continuation_executed',
    factPayload: { success: allSucceeded, executedCount: executedResults.length, status: finalStatus },
  });

  const allItems = executedResults.flatMap((r) => {
    const data = r.result?.data;
    if (!data) return [];
    if (Array.isArray(data)) return data;
    if (Array.isArray(data.items)) return data.items;
    if (Array.isArray(data.reminders)) return data.reminders;
    if (data.id && (data.title || data.content || data.name || data.summary)) return [data];
    return [];
  });
  if (allItems.length > 0) {
    saveWorkingMemory(executionUser, {
      source: preparedActions[0]?.domain || 'reminder',
      scope: 'current',
      entityType: preparedActions[0]?.domain || 'reminder',
      lastAction: 'created',
      items: allItems,
    });
  }

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
    lines.push('Instrucción: Si el usuario aprueba todo, responde con relation="approval" y decision="approve_all". Si aprueba solo algunos, decision="approve_subset" con los selectedCallIds exactos. Si rechaza o cancela, relation="cancel". Si habla de otro tema no relacionado, relation="unrelated". IMPORTANTE: Si aprueba (approve_all o approve_subset), la acción se ejecutará de inmediato en este turno; redacta el campo reply en tiempo pasado o confirmación inmediata (ej: "Listo, eliminé los proyectos seleccionados."), NUNCA en tiempo futuro ("eliminaré", "voy a eliminar").');
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
