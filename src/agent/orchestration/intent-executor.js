import { executeTool } from '../tools/index.js';
import { TOOL_NAMES } from '../contracts/tool-names.js';
import { createExecutionFact } from '../core/execution-facts.js';
import {
  getWorkingMemory,
  saveWorkingMemory,
  clearWorkingMemory,
} from '../core/working-memory-store.js';
import {
  extractMultipleOrdinals,
} from '../core/context-reference.js';
import { formatAssistantClarification } from './clarification-presentation.js';
import {
  findOutOfRangeTaskOrdinalTargets,
  pinReminderCancellationTargets,
  pinTaskMutationTargets,
} from './context-target-pinner.js';
import { createApprovalRun, createInputRun } from '../core/agent-run.js';
import { buildDomainCall, failedResult, intentTarget } from './domain-call.js';

const MAX_ACTIONS_PER_TURN = 12;

function extractWorkingItems(data) {
  if (!data) return [];
  if (Array.isArray(data)) return data;
  if (Array.isArray(data.items)) return data.items;
  if (Array.isArray(data.events)) return data.events;
  if (Array.isArray(data.reminders)) return data.reminders;
  if (Array.isArray(data.tasks)) return data.tasks;
  if (data.id && (data.title || data.content || data.name || data.summary)) return [data];
  return [];
}

function inferItemType(toolName) {
  if (toolName === TOOL_NAMES.MANAGE_TASK) return 'task';
  if (toolName === TOOL_NAMES.MANAGE_PROJECT) return 'project';
  if (toolName === TOOL_NAMES.MANAGE_REMINDER) return 'reminder';
  if (toolName === TOOL_NAMES.MANAGE_GOOGLE_CALENDAR) return 'calendar_event';
  if (toolName === TOOL_NAMES.MANAGE_ENTITY) return 'entity';
  return 'all';
}

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

function updateWorkingMemoryFromExecution({ user, action, toolName, params, result }) {
  const existingMemory = getWorkingMemory(user);

  if (
    toolName === TOOL_NAMES.MANAGE_REMINDER
    && params.action === 'acknowledge'
    && result.success
  ) {
    if (!existingMemory) return;
    const acknowledgedId = String(result.data?.id || params.reminderId || '').trim();
    const remainingItems = (existingMemory.items || []).filter((item) => (
      !acknowledgedId || String(item?.internalId || '').trim() !== acknowledgedId
    ));
    if (remainingItems.length === 0 && !existingMemory.activeEntity) {
      clearWorkingMemory(user);
      return;
    }
    saveWorkingMemory(user, {
      ...existingMemory,
      lastAction: 'reminder_acknowledged',
      notificationReminderId: null,
      notificationContent: null,
      items: remainingItems,
    });
    return;
  }

  if (
    toolName === TOOL_NAMES.MANAGE_TASK
    && ['update', 'complete', 'delete'].includes(params.action)
    && result.success
    && existingMemory?.items?.length > 0
    && (existingMemory.entityType === 'task' || existingMemory.items.every((item) => item.type === 'task'))
  ) {
    const targetId = String(params.target || '').trim();
    const matchingIndex = existingMemory.items.findIndex((item) => String(item.internalId || '').trim() === targetId);
    if (matchingIndex < 0) return;

    const returnedTask = result.data && typeof result.data === 'object' && !Array.isArray(result.data)
      ? (result.data.data && typeof result.data.data === 'object' ? result.data.data : result.data)
      : {};
    const items = existingMemory.items.map((item, index) => {
      if (index !== matchingIndex) return item;
      const raw = { ...(item.raw || {}), ...returnedTask, id: item.internalId };
      if (params.action === 'delete') raw.status = 'deleted';
      return {
        ...item,
        title: params.action === 'delete' ? item.title : String(returnedTask.title || returnedTask.content || item.title),
        summary: params.action === 'delete' ? item.summary : String(returnedTask.title || returnedTask.content || item.summary),
        raw,
      };
    });

    saveWorkingMemory(user, {
      ...existingMemory,
      lastAction: result.action || `task_${params.action}`,
      items,
    });
    return;
  }

  const items = extractWorkingItems(result.data);
  if (items.length === 0) return;
  const firstType = items[0]?.type || inferItemType(toolName);
  const uniform = items.every((item) => (item.type || firstType) === firstType);
  const source = toolName === TOOL_NAMES.GET_UNIFIED_AGENDA
    ? 'unified'
    : toolName === TOOL_NAMES.MANAGE_GOOGLE_CALENDAR
      ? 'calendar'
      : toolName === TOOL_NAMES.MANAGE_REMINDER
        ? 'reminder'
        : toolName === TOOL_NAMES.MANAGE_PROJECT
          ? 'project'
          : toolName === TOOL_NAMES.MANAGE_ENTITY ? 'entity' : 'task';

  const uniformEntityName = items.length > 0
    && items.every((item) => item?.entityName && item.entityName === items[0]?.entityName)
    ? items[0].entityName
    : null;
  const uniformEntityId = items.length > 0
    ? items
      .map((item) => item?.entityId || item?.raw?.entity_id || item?.raw?.entityId || item?.raw?.entities?.id || null)
      .filter(Boolean)
      .find((id, _index, ids) => ids.every((candidate) => candidate === id)) || null
    : null;
  const activeEntity = result.data?.entityName
    || params.entityName
    || ((toolName === TOOL_NAMES.MANAGE_PROJECT || toolName === TOOL_NAMES.MANAGE_ENTITY) ? result.data?.name : null)
    || uniformEntityName;
  const activeEntityId = result.data?.entityId
    || ((toolName === TOOL_NAMES.MANAGE_PROJECT || toolName === TOOL_NAMES.MANAGE_ENTITY) ? result.data?.id : null)
    || uniformEntityId;

  let workingItems = items;
  const sameContainer = Boolean(
    existingMemory
    && toolName === TOOL_NAMES.MANAGE_TASK
    && params.action === 'create'
    && (
      (activeEntityId && existingMemory.activeEntityId === activeEntityId)
      || (activeEntity && existingMemory.activeEntity === activeEntity)
    )
  );
  if (sameContainer) {
    const byId = new Map();
    for (const item of [...(existingMemory.items || []), ...items]) {
      const id = String(item?.internalId || item?.id || '').trim();
      if (id) byId.set(id, item);
    }
    workingItems = [...byId.values()].slice(-10);
  }

  saveWorkingMemory(user, {
    source,
    scope: params.scope || 'current',
    semanticQuery: params.query || null,
    entityType: uniform ? firstType : 'all',
    activeEntity,
    activeEntityId,
    lastAction: result?.action === 'partially_created_reminders' ? 'partially_created' : toolName,
    items: workingItems,
  });
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
    if (Array.isArray(action.missingFields) && action.missingFields.length > 0) return true;
    return buildDomainCall(action, context).requiresClarification === true;
  });
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

    await createInputRun({
      user: context.user,
      kind: stagedDrafts.every((d) => d.domain === 'reminder') ? 'reminder_creation' : 'input_draft',
      partialActions: stagedDrafts,
      missingFields: pendingMissingFields(stagedDrafts, clarification),
      question: clarification.question || '',
      context: { drafts: stagedDrafts },
      referenceTime: context.referenceTime,
    });

    const stagedSet = new Set(staged);
    actions = actions.filter((action) => !stagedSet.has(action));
    if (clarificationActions.length === 0) actions.push(clarification);
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
      const runTool = context.executeTool || executeTool;
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
      const runTool = context.executeTool || executeTool;
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
      const runTool = context.executeTool || executeTool;
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
          const runTool = context.executeTool || executeTool;
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

    const fact = createExecutionFact({
      toolName,
      params,
      result,
      callId: `call_${actionIndex + 1}`,
      language: context.language,
    });
    records.push({ toolName, params, result, fact });
    facts.push(fact);

    if (
      (result.action === 'entity_deletion_confirmation_required' || result.action === 'project_deletion_confirmation_required')
      && (Array.isArray(result.data?.previewProjects) || Array.isArray(result.data?.previewEntities))
    ) {
      const isProject = result.action === 'project_deletion_confirmation_required';
      const items = (isProject ? result.data?.previewProjects : result.data?.previewEntities) || [];
      if (items.length > 0) {
        const preparedActions = items.map((item, idx) => ({
          callId: `call-${idx + 1}`,
          domain: isProject ? 'project' : 'entity',
          action: 'delete',
          targetId: item.id,
          targetName: item.name,
          payload: isProject ? { action: 'delete', projectIds: [item.id] } : { action: 'delete', entityIds: [item.id] },
          status: 'prepared',
        }));

        await createApprovalRun({
          user: context.user,
          kind: 'entity_destructive_batch',
          preparedActions,
          question: result.error || result.rawSummary,
          context: { previewEntities: items, isProject },
        });

        const approvalButtons = [
          { id: 'btn_confirm', title: context.language === 'en' ? '✅ Confirm' : '✅ Confirmar' },
          { id: 'btn_cancel', title: context.language === 'en' ? '❌ Cancel' : '❌ Cancelar' },
        ];
        result.buttons = approvalButtons;
      }
    }

    if ((result.success || result.requiresClarification) && toolName !== 'orchestrator') {
      updateWorkingMemoryFromExecution({ user: context.user, action, toolName, params, result });
    }
  }

  const allProposedReminders = records.flatMap(({ result }) => (
    Array.isArray(result?.data?.pendingClarifications)
      ? result.data.pendingClarifications.filter((item) => item?.proposedReminder?.targetTime)
      : []
  ));

  if (allProposedReminders.length > 0) {
    const preparedActions = allProposedReminders.map((item, idx) => ({
      callId: `call-${idx + 1}`,
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
    }));

    const questions = allProposedReminders.map((p) => p.question).filter(Boolean);
    await createApprovalRun({
      user: context.user,
      kind: 'proposal_approval',
      preparedActions,
      question: questions.join('\n') || (context.language === 'en' ? 'Do you want me to schedule these reminders?' : '¿Deseas programar estos recordatorios?'),
      context: { proposedReminders: allProposedReminders },
      referenceTime: context.referenceTime,
    });

    const approvalButtons = [
      { id: 'btn_confirm', title: context.language === 'en' ? '✅ Confirm' : '✅ Confirmar' },
      { id: 'btn_reschedule', title: context.language === 'en' ? '✏️ Reschedule' : '✏️ Cambiar hora' },
      { id: 'btn_cancel', title: context.language === 'en' ? '❌ Cancel' : '❌ Cancelar' },
    ];
    records.forEach(({ result }) => {
      if (Array.isArray(result?.data?.pendingClarifications)) {
        result.buttons = approvalButtons;
      }
    });
  }

  return { records, facts, excluded: intent?.excluded || [] };
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
