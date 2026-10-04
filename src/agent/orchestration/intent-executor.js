import { executeTool } from '../tools/index.js';
import { TOOL_NAMES } from '../contracts/tool-names.js';
import { createExecutionFact } from '../core/execution-facts.js';
import { getWorkingMemory } from '../core/working-memory-store.js';
import { updateWorkingMemoryFromExecution, updateWorkingMemoryFromFacts } from '../core/working-memory-execution.js';
import {
  extractMultipleOrdinals,
} from '../core/context-reference.js';
import { formatAssistantClarification } from './clarification-presentation.js';
import {
  findOutOfRangeTaskOrdinalTargets,
  pinReminderCancellationTargets,
  pinTaskMutationTargets,
} from './context-target-pinner.js';
import { cancelSupersededInputRun, createApprovalRun, createInputRun } from '../core/agent-run.js';
import { buildDomainCall, failedResult, intentTarget } from './domain-call.js';
import { resolveObservedTarget } from './resolve-observed-target.js';

const MAX_ACTIONS_PER_TURN = 12;

const MISSING_FIELD_BY_ERROR = Object.freeze({
  AMBIGUOUS_TARGET: 'selection',
  MISSING_TARGET: 'target',
  MISSING_TARGET_ID: 'target',
  MISSING_CONTENT: 'content',
  MISSING_SCHEDULE: 'schedule',
  MISSING_CLOCK_TIME: 'time',
  AMBIGUOUS_CLOCK_TIME: 'time',
  MISSING_CALENDAR_DATE: 'date',
  MISSING_UPDATES: 'content',
});

function pendingMissingFields(actions, clarification = null, fallbackErrorCode = null) {
  const fields = [
    ...actions.flatMap((action) => Array.isArray(action?.missingFields) ? action.missingFields : []),
    ...(Array.isArray(clarification?.missingFields) ? clarification.missingFields : []),
    ...(MISSING_FIELD_BY_ERROR[fallbackErrorCode] ? [MISSING_FIELD_BY_ERROR[fallbackErrorCode]] : []),
  ];
  return [...new Set(fields)];
}

function defaultPendingQuestion(actions, language = 'es') {
  const action = actions.find((candidate) => candidate?.question || candidate?.content || candidate?.title) || actions[0];
  if (action?.question) return action.question;
  if (action?.schedule?.clockMode === 'ambiguous_12h') {
    return language === 'en'
      ? 'Should I use that time in the morning or afternoon?'
      : '¿Esa hora es de la mañana o de la tarde?';
  }
  if (action?.domain === 'reminder' && action?.action === 'create') {
    const content = action.content || action.title;
    const missing = new Set(Array.isArray(action.missingFields) ? action.missingFields : []);
    if (content && missing.size === 1 && missing.has('time')) return language === 'en'
      ? `What time should I remind you about “${content}”?`
      : `¿A qué hora quieres que te recuerde “${content}”?`;
    if (content && missing.size === 1 && missing.has('date')) return language === 'en'
      ? `What day should I remind you about “${content}”?`
      : `¿Qué día quieres que te recuerde “${content}”?`;
    if (content) return language === 'en'
      ? `When should I remind you about “${content}”?`
      : `¿Cuándo quieres que te recuerde “${content}”?`;
  }
  return language === 'en'
    ? 'What information should I use to continue?'
    : '¿Qué dato debo usar para continuar?';
}

/** Execute semantic TurnIntent directly against deterministic domain tools. */
export async function executeTurnIntent(intent, context) {
  let actions = Array.isArray(intent?.actions) ? intent.actions : [];
  if (actions.length === 0) return { records: [], facts: [], excluded: intent?.excluded || [] };

  const expandedActions = [];
  for (const action of actions) {
    if (action.domain === 'task' && ['delete', 'complete'].includes(action.action) && action.target) {
      const ordinals = extractMultipleOrdinals(action.target);
      if (ordinals.length > 1) {
        for (const ord of ordinals) {
          expandedActions.push({
            ...action,
            target: ord,
          });
        }
        continue;
      }
    }
    expandedActions.push(action);
  }
  actions = expandedActions;

  if (actions.length > MAX_ACTIONS_PER_TURN) {
    const result = failedResult('TURN_ACTION_LIMIT', `El turno supera el límite de ${MAX_ACTIONS_PER_TURN} acciones.`, context.language);
    const fact = createExecutionFact({ toolName: 'orchestrator', params: {}, result, callId: 'intent_limit', language: context.language });
    return { records: [{ toolName: 'orchestrator', params: {}, result, fact }], facts: [fact], excluded: intent?.excluded || [] };
  }

  const clarificationActions = actions.filter((action) => action.domain === 'clarification');
  const regularActions = actions.filter((action) => action.domain !== 'clarification');

  const staged = regularActions.filter((action) => {
    const prepared = buildDomainCall(action, context);
    // A failed typed binding needs a fresh selection, not an input patch to
    // an invalid reference. Keep it in execution to publish its specific error.
    if (prepared.errorCode === 'INVALID_CONTEXT_REFERENCE') return false;
    if (Array.isArray(action.missingFields) && action.missingFields.length > 0) return true;
    return prepared.requiresClarification === true;
  });
  let supersededInputRunCancellation = 'pending';
  let pendingInputTransitionFailed = false;
  let pendingInputTransitionFailureMessage = null;
  if (staged.length > 0) {
    const stagedDrafts = staged.map((action) => action.schedule?.clockMode === 'ambiguous_12h'
      ? { ...action, missingFields: [...new Set([...(action.missingFields || []), 'time'])] }
      : action);
    const clarification = clarificationActions[0] || {
      domain: 'clarification',
      action: 'request',
      question: defaultPendingQuestion(stagedDrafts, context.language),
      missingFields: pendingMissingFields(stagedDrafts),
    };

    const cannotStageAlongsidePending = context.preserveExistingActiveRun === true;
    const stagedRun = cannotStageAlongsidePending ? null : await createInputRun({
      user: context.user,
      kind: stagedDrafts.every((d) => d.domain === 'reminder') ? 'reminder_creation' : 'input_draft',
      partialActions: stagedDrafts,
      missingFields: pendingMissingFields(stagedDrafts, clarification),
      question: clarification.question || '',
      context: { drafts: stagedDrafts },
      referenceTime: context.referenceTime,
      timezone: context.timezone,
      supersedesRunId: context.supersedesRunId || null,
      preserveExistingActiveRun: context.preserveExistingActiveRun === true,
    });
    const replacementCancellationFailed = stagedRun === null && !cannotStageAlongsidePending;
    const replacementActivationFailed = stagedRun?.activationFailed === true;
    pendingInputTransitionFailed = replacementCancellationFailed || replacementActivationFailed;
    if (replacementActivationFailed) {
      pendingInputTransitionFailureMessage = context.language === 'en'
        ? 'I saved the replacement draft but could not confirm that it became active, so I did not execute it. The previous request may already have been cancelled; please check your pending request before trying again.'
        : 'Guardé el borrador de reemplazo, pero no pude confirmar que quedara activo, así que no lo ejecuté. Es posible que la solicitud anterior ya se haya cancelado; revisa tus solicitudes pendientes antes de volver a intentarlo.';
    }
    if (context.supersedesRunId) {
      supersededInputRunCancellation = replacementCancellationFailed ? 'failed' : 'confirmed';
    }

    const stagedSet = new Set(staged);
    actions = actions.filter((action) => (
      !stagedSet.has(action)
      && (!(cannotStageAlongsidePending || replacementCancellationFailed || replacementActivationFailed) || action.domain !== 'clarification')
    ));
    if (cannotStageAlongsidePending || replacementCancellationFailed || replacementActivationFailed) {
      actions.push({
        domain: 'clarification',
        action: 'request',
        question: context.language === 'en'
          ? (replacementActivationFailed
            ? pendingInputTransitionFailureMessage
            : replacementCancellationFailed
            ? 'I could not confirm that the pending request was still active, so I did not run or save the replacement. Its status may have changed; please check your pending request before trying again.'
            : 'You already have a pending request. I did not save this new incomplete request; please finish or cancel the pending one first, then send this request again.' )
          : (replacementActivationFailed
            ? pendingInputTransitionFailureMessage
            : replacementCancellationFailed
            ? 'No pude confirmar que la solicitud pendiente siguiera activa, así que no ejecuté ni guardé el reemplazo. Su estado pudo haber cambiado; revisa tus solicitudes pendientes antes de volver a intentarlo.'
            : 'Ya tienes una solicitud pendiente. No guardé esta nueva solicitud incompleta; primero termina o cancela la anterior y después envíame esta solicitud nuevamente.'),
      });
    } else if (clarificationActions.length === 0) {
      actions.push(clarification);
    }
  }

  // Resolve contextual identities once against the pre-mutation snapshot. This
  // prevents ordinal drift and lets duplicate human labels be paired safely
  // when Hermes emitted one cancellation action per listed reminder.
  const preMutationMemory = getWorkingMemory(context.user);
  const pinnedReminderTargets = pinReminderCancellationTargets(actions, preMutationMemory);
  const pinnedTaskTargets = pinTaskMutationTargets(actions, preMutationMemory);
  const outOfRangeTaskOrdinals = findOutOfRangeTaskOrdinalTargets(actions, preMutationMemory);

  const records = [];
  const facts = [];
  // Scoped to this execution only; all save actions process the full source turn.
  const memoryTurn = { userText: context.userMessage, executionFacts: facts, processed: false, result: null };
  const approvalActions = [];
  let targetResolutionAttempted = false;
  const runTool = async (options) => {
    if (context.supersedesRunId && supersededInputRunCancellation === 'pending') {
      let cancelled = false;
      try {
        cancelled = await cancelSupersededInputRun(
          context.user,
          context.supersedesRunId,
          context.referenceTime || new Date(),
        );
      } catch {
        cancelled = false;
      }
      supersededInputRunCancellation = cancelled ? 'confirmed' : 'failed';
    }
    if (pendingInputTransitionFailed || supersededInputRunCancellation === 'failed') return {
      success: false,
      action: 'clarification_required',
      errorCode: 'PENDING_REQUEST_CHANGED',
      error: pendingInputTransitionFailureMessage || (context.language === 'en'
        ? 'I could not confirm that the pending request was still active, so I did not run the replacement. Its status may have changed; please check your pending request before trying again.'
        : 'No pude confirmar que la solicitud pendiente siguiera activa, así que no ejecuté el reemplazo. Su estado pudo haber cambiado; revisa tus solicitudes pendientes antes de volver a intentarlo.'),
    };
    try {
      const result = await (context.executeTool || executeTool)({ ...options, memoryTurn });
      if (!result || typeof result.success !== 'boolean') throw new Error('Missing observable tool outcome.');
      return result;
    } catch {
      return {
        success: false,
        outcome: 'unknown',
        action: 'execution_outcome_unknown',
        errorCode: 'UNKNOWN_WRITE_OUTCOME',
        error: context.language === 'en'
          ? 'I could not confirm the outcome of this operation. I stopped the remaining actions; I will not repeat this operation without checking its state.'
          : 'No pude confirmar el resultado de esta operación. Detuve las acciones restantes; no repetiré esta operación sin comprobar su estado.',
      };
    }
  };

  for (let index = 0; index < actions.length; index += 1) {
    const actionIndex = index;
    const action = actions[index];
    let toolName = 'orchestrator';
    let params = {};
    let result;

    const taskCreateBatch = [];
    const projectDeleteBatch = [];
    const entityDeleteBatch = [];
    let batchEnd = index;

    if (action.domain === 'task' && action.action === 'create') {
      while (
        batchEnd < actions.length
        && actions[batchEnd]?.domain === 'task'
        && actions[batchEnd]?.action === 'create'
      ) {
        taskCreateBatch.push(buildDomainCall(actions[batchEnd], context));
        batchEnd += 1;
      }
    } else if (action.domain === 'project' && action.action === 'delete' && action.scope !== 'all' && intentTarget(action)) {
      while (
        batchEnd < actions.length
        && actions[batchEnd]?.domain === 'project'
        && actions[batchEnd]?.action === 'delete'
        && actions[batchEnd]?.scope !== 'all'
        && intentTarget(actions[batchEnd])
      ) {
        projectDeleteBatch.push(actions[batchEnd]);
        batchEnd += 1;
      }
    } else if (action.domain === 'entity' && action.action === 'delete' && action.scope !== 'all' && intentTarget(action)) {
      while (
        batchEnd < actions.length
        && actions[batchEnd]?.domain === 'entity'
        && actions[batchEnd]?.action === 'delete'
        && actions[batchEnd]?.scope !== 'all'
        && intentTarget(actions[batchEnd])
      ) {
        entityDeleteBatch.push(actions[batchEnd]);
        batchEnd += 1;
      }
    }

    const invalidBatchItem = taskCreateBatch.find((prepared) => !prepared.valid);
    if (invalidBatchItem) {
      result = failedResult(invalidBatchItem.errorCode, invalidBatchItem.error, context.language, { requiresClarification: invalidBatchItem.requiresClarification });
      index = batchEnd - 1;
    } else if (taskCreateBatch.length > 0) {
      toolName = TOOL_NAMES.MANAGE_TASK;
      params = {
        action: 'create',
        items: taskCreateBatch.flatMap((prepared) => prepared.params.items || []),
      };
      result = await runTool({
        toolName,
        params,
        user: context.user,
        isPro: context.isPro,
        language: context.language,
        correlationId: context.correlationId,
        referenceTime: context.referenceTime,
      });
      index = batchEnd - 1;
    } else if (projectDeleteBatch.length > 1) {
      toolName = TOOL_NAMES.MANAGE_PROJECT;
      params = {
        action: 'delete',
        targetNames: projectDeleteBatch.map((a) => intentTarget(a)).filter(Boolean),
      };
      result = await runTool({
        toolName,
        params,
        user: context.user,
        isPro: context.isPro,
        language: context.language,
        correlationId: context.correlationId,
        referenceTime: context.referenceTime,
      });
      index = batchEnd - 1;
    } else if (entityDeleteBatch.length > 1) {
      toolName = TOOL_NAMES.MANAGE_ENTITY;
      params = {
        action: 'delete',
        targetNames: entityDeleteBatch.map((a) => intentTarget(a)).filter(Boolean),
      };
      result = await runTool({
        toolName,
        params,
        user: context.user,
        isPro: context.isPro,
        language: context.language,
        correlationId: context.correlationId,
        referenceTime: context.referenceTime,
      });
      index = batchEnd - 1;
    } else {
      if (outOfRangeTaskOrdinals.has(index)) {
        result = failedResult(
          'TASK_ORDINAL_OUT_OF_RANGE',
          context.language === 'en'
            ? 'That task number is not in the displayed list. Please choose a listed task.'
            : 'Ese número no está en la lista de tareas mostrada. Elige una tarea de la lista.',
          context.language,
          { requiresClarification: true },
        );
      } else {
        const prepared = buildDomainCall(action, context);
        if (!prepared.valid) {
          result = failedResult(prepared.errorCode, prepared.error, context.language, { requiresClarification: prepared.requiresClarification });
        } else if (prepared.orchestrationOnly) {
          result = prepared.result;
        } else {
          toolName = prepared.toolName;
          params = prepared.params;
          if (
            pinnedReminderTargets instanceof Map
            && pinnedReminderTargets.has(index)
            && toolName === TOOL_NAMES.MANAGE_REMINDER
            && ['cancel', 'update'].includes(params.action)
            && !params.scope
          ) {
            const pinnedId = pinnedReminderTargets.get(index);
            if (pinnedId) {
              params = {
                ...params,
                target: pinnedId,
                reminderId: pinnedId,
              };
            }
          }
          if (
            pinnedTaskTargets instanceof Map
            && pinnedTaskTargets.has(index)
            && toolName === TOOL_NAMES.MANAGE_TASK
            && ['update', 'complete', 'delete'].includes(params.action)
          ) {
            params = { ...params, target: pinnedTaskTargets.get(index) };
          }
          result = await runTool({
            toolName,
            params,
            user: context.user,
            isPro: context.isPro,
            language: context.language,
            correlationId: context.correlationId,
            referenceTime: context.referenceTime,
          });
        }
      }
    }

    if (!targetResolutionAttempted && result?.errorCode === 'AMBIGUOUS_TARGET' && context.userMessage) {
      targetResolutionAttempted = true;
      const resolved = await resolveObservedTarget({ toolName, params, result, userText: context.userMessage,
        timezone: context.timezone, language: context.language, correlationId: context.correlationId });
      if (resolved) {
        params = resolved;
        result = await runTool({ toolName, params, user: context.user, isPro: context.isPro, language: context.language,
          correlationId: context.correlationId, referenceTime: context.referenceTime });
      }
    }

    if ((context.preserveExistingActiveRun || staged.length > 0) && (
      result.action === 'entity_deletion_confirmation_required'
      || result.action === 'project_deletion_confirmation_required'
      || result.data?.pendingClarifications?.some(item => item?.proposedReminder)
    )) {
      const message = context.language === 'en'
        ? 'Your previous request is still pending. I did not save another approval request; finish or cancel the pending request first.'
        : 'Tu solicitud anterior sigue pendiente. No guardé otra solicitud de aprobación; primero termina o cancela la pendiente.';
      result = result.success
        ? { ...result, partialSuccess: true, complete: false, requiresClarification: false, rawSummary: `${result.rawSummary || ''}\n${message}`, data: { ...result.data, pendingClarifications: [] }, pendingClarifications: [] }
        : failedResult('PENDING_REQUEST_ACTIVE', message, context.language, { requiresClarification: true });
    }

    const fact = createExecutionFact({
      toolName,
      params,
      result,
      callId: `call_${actionIndex + 1}`,
      timezone: context.timezone || context.user?.timezone,
      language: context.language,
    });
    records.push({ toolName, params, result, fact });
    facts.push(fact);

    if (fact.outcome === 'unknown') break;

    if (
      (result.action === 'entity_deletion_confirmation_required' || result.action === 'project_deletion_confirmation_required')
      && (Array.isArray(result.data?.previewProjects) || Array.isArray(result.data?.previewEntities))
    ) {
      const isProject = result.action === 'project_deletion_confirmation_required';
      const items = (isProject ? result.data?.previewProjects : result.data?.previewEntities) || [];
      if (items.length > 0) {
        approvalActions.push(...items.map((item) => ({
          domain: isProject ? 'project' : 'entity', action: 'delete', targetId: item.id, targetName: item.name,
          payload: isProject ? { action: 'delete', projectIds: [item.id] } : { action: 'delete', entityIds: [item.id] },
          status: 'prepared',
        })));

      }
    }

    if ((result.success || result.requiresClarification) && toolName !== 'orchestrator'
      && !(context.preserveDisplayedReferences && toolName === TOOL_NAMES.MANAGE_TASK
        && ['list', 'read'].includes(params.action))) {
      updateWorkingMemoryFromExecution({ user: context.user, toolName, params, result });
    }
  }

  updateWorkingMemoryFromFacts(context.user, facts, { creationsOnly: true });

  const allProposedReminders = records.flatMap(({ result }) => (
    Array.isArray(result?.data?.pendingClarifications)
      ? result.data.pendingClarifications.filter((item) => item?.proposedReminder?.targetTime)
      : []
  ));

  if (allProposedReminders.length > 0) {
    approvalActions.push(...allProposedReminders.map((item) => ({
      domain: 'reminder',
      action: 'create',
      targetId: null,
      targetName: item.content,
      payload: {
        action: 'create',
        items: [{
          content: item.content,
          targetTime: item.proposedReminder.targetTime,
          ...(item.proposedReminder.advanceMinutes ? { advanceMinutes: item.proposedReminder.advanceMinutes } : {}),
          ...(item.proposedReminder.recurrence ? { recurrence: item.proposedReminder.recurrence } : {}),
          ...(item.proposedReminder.requiresConfirmation ? { requiresConfirmation: true } : {}),
          ...(item.proposedReminder.nudgeIntervalMinutes ? { nudgeIntervalMinutes: item.proposedReminder.nudgeIntervalMinutes } : {}),
          ...(item.proposedReminder.maxNudges ? { maxNudges: item.proposedReminder.maxNudges } : {}),
        }],
      },
      status: 'prepared',
    })));
  }

  if (approvalActions.length > 0) {
    const isDestructiveBatch = approvalActions.every(action => action.domain === approvalActions[0].domain && action.action === 'delete');
    let stagedRun = null;
    try {
      stagedRun = await createApprovalRun({
        user: context.user,
        kind: isDestructiveBatch ? 'entity_destructive_batch' : 'generic_operation',
        preparedActions: approvalActions.map((action, index) => ({ ...action, callId: `call-${index + 1}` })),
        question: [...allProposedReminders.map(item => item.question), ...records.filter(({ result }) => result.requiresClarification && !result.data?.pendingClarifications?.length).map(({ result }) => result.error || result.rawSummary)].filter(Boolean).join('\n'),
        referenceTime: context.referenceTime,
      });
    } catch { /* preserve earlier observed results and report staging failure */ }
    const approvalButtons = [
      { id: 'btn_confirm', title: context.language === 'en' ? '✅ Confirm' : '✅ Confirmar' },
      ...(allProposedReminders.length ? [{ id: 'btn_reschedule', title: context.language === 'en' ? '✏️ Reschedule' : '✏️ Cambiar hora' }] : []),
      { id: 'btn_cancel', title: context.language === 'en' ? '❌ Cancel' : '❌ Cancelar' },
    ];
    if (stagedRun) {
      records.filter(({ result }) => result.requiresClarification || result.data?.pendingClarifications?.length).forEach(({ result }) => { result.buttons = approvalButtons; });
    } else {
      const message = context.language === 'en'
        ? 'I could not save the pending approval. The proposed actions have not been executed.'
        : 'No pude guardar la aprobación pendiente. Las acciones propuestas no se ejecutaron.';
      const result = failedResult('APPROVAL_STORAGE_FAILED', message, context.language);
      const fact = createExecutionFact({ toolName: 'orchestrator', params: {}, result, callId: 'approval_storage', language: context.language });
      records.push({ toolName: 'orchestrator', params: {}, result, fact });
      facts.push(fact);
    }
  }

  return { records, facts, excluded: intent?.excluded || [], memoryProcessed: memoryTurn.processed };
}

export function inferIntentFromTool(toolName) {
  const intents = {
    [TOOL_NAMES.MANAGE_MEMORY]: 'memory',
    [TOOL_NAMES.MANAGE_REMINDER]: 'reminder',
    [TOOL_NAMES.MANAGE_TASK]: 'task',
    [TOOL_NAMES.MANAGE_PROJECT]: 'project',
    [TOOL_NAMES.MANAGE_ENTITY]: 'entity',
    [TOOL_NAMES.MANAGE_SUBSCRIPTION]: 'subscription',
    [TOOL_NAMES.MANAGE_GOOGLE_CALENDAR]: 'calendar',
    [TOOL_NAMES.GET_UNIFIED_AGENDA]: 'unified_agenda',
    [TOOL_NAMES.ADMIN_METRICS]: 'admin',
  };
  return intents[toolName] || 'chat';
}
