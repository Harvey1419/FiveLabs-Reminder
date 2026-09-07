import {
  supabase,
  createTask,
  findOrCreateEntityFuzzy,
  completeTasksByQuery,
  updateTask,
  deleteTask,
  saveReminder,
  getTasks,
} from '../../infrastructure/database/index.js';
import { normalizeTaskPriority } from '../../infrastructure/database/tasks.js';
import { parseTargetTime, DEFAULT_TIMEZONE } from '../../shared/time.js';
import {
  formatTaskCreatedCard,
  formatTaskCompletedCard,
  formatTaskUpdatedCard,
} from './formatters.js';
import { getWorkingMemory, resolveEntityReference } from '../core/working-memory.js';
import {
  isStrictUUID,
  UUID_REGEX,
  normalizeTextForMatching,
  stripConversationalWrappers,
  isStandaloneAffirmative,
  calculateMatchScore,
} from '../../shared/entity-resolution.js';
import { selectEntityCandidate } from '../../infrastructure/database/entities.js';

async function resolveUserContainer(cleanQuery, normClean, userId) {
  if (!userId || !normClean) return null;
  const { data: userEntities } = await supabase
    .from('entities')
    .select('id, name, category')
    .eq('user_id', userId);

  if (userEntities && userEntities.length > 0) {
    const selection = selectEntityCandidate(userEntities, cleanQuery);
    if (selection.status === 'RESOLVED') {
      const matchedEntity = selection.entity;
      return {
        status: 'RESOLVED_CONTAINER',
        entityId: matchedEntity.id,
        entityName: matchedEntity.name,
        entity: matchedEntity,
      };
    }
    if (selection.status === 'AMBIGUOUS') {
      return { status: 'AMBIGUOUS', candidates: selection.candidates };
    }
  }
  return null;
}

/**
 * Deterministic Task Identifier Resolver following the Strict Resolution Hierarchy:
 * 1. Direct 36-character UUID (isStrictUUID)
 * 2. Working Memory (Ordinal reference '1', 'el primero', 'la segunda' from previous turn)
 * 3. Database search for user's pending tasks (normalized exact title -> substring -> token match)
 * 4. Container / Project Entity resolution
 * 5. Disambiguation: 1 match -> RESOLVED, >1 match -> AMBIGUOUS, 0 match -> NOT_FOUND / MISSING_CONTEXT
 */
async function resolveTargetTask({ target, userId, userOrPhone, userMessage = '', operation = 'complete', allowedStatuses = null }) {
  if (!target && !userMessage) return { status: 'MISSING' };
  const rawStr = String(target || userMessage || '').trim();
  if (!rawStr) return { status: 'MISSING' };

  // Determine allowed statuses based on operation
  const statuses = allowedStatuses || (operation === 'complete' ? ['pending'] : ['pending', 'completed']);

  // 1. Direct UUID
  if (isStrictUUID(rawStr)) {
    if (operation === 'complete') {
      const { data: directTask } = await supabase
        .from('tasks')
        .select('id, user_id, status')
        .eq('id', rawStr)
        .maybeSingle();
      if (!directTask || (userId && directTask.user_id !== userId)) {
        return { status: 'NOT_FOUND' };
      }
      if (directTask.status !== 'pending') {
        return { status: 'NOT_FOUND', reason: 'TASK_ALREADY_COMPLETED' };
      }
      return { status: 'RESOLVED', taskId: directTask.id, task: directTask };
    }
    return { status: 'RESOLVED', taskId: rawStr };
  }

  // 2. Working Memory (Short-term context from previous turn / ordinals)
  const refRes = resolveEntityReference({
    userOrPhone,
    reference: rawStr,
    preferredType: 'task',
  });

  if (refRes.status === 'RESOLVED' && refRes.item?.internalId) {
    if (operation === 'complete') {
      const { data: directTask } = await supabase
        .from('tasks')
        .select('id, user_id, status')
        .eq('id', refRes.item.internalId)
        .maybeSingle();
      if (directTask && directTask.status !== 'pending') {
        return { status: 'NOT_FOUND', reason: 'TASK_ALREADY_COMPLETED' };
      }
    }
    return { status: 'RESOLVED', taskId: refRes.item.internalId, item: refRes.item, task: refRes.item.raw || refRes.item };
  }
  if (refRes.status === 'RESOLVED_CONTAINER') {
    return refRes;
  }
  if (refRes.status === 'AMBIGUOUS') {
    return { status: 'AMBIGUOUS', candidates: refRes.candidates };
  }

  // 3. Database Search on user's tasks (tenant isolated, matching allowed statuses)
  if (!userId) {
    return { status: 'NOT_FOUND' };
  }

  // Clean raw reference string: strip completion phrases and prefixes
  const cleanQuery = stripConversationalWrappers(rawStr);
  const normClean = normalizeTextForMatching(cleanQuery);

  // If cleanQuery is empty (e.g. user just said "ya la hice" with no task title and no Working Memory context):
  // Rule 8: Do NOT guess an arbitrary task, ask clarification!
  if (!normClean) {
    if (isStandaloneAffirmative(rawStr)) {
      return { status: 'MISSING_CONTEXT', reason: 'STANDALONE_AFFIRMATIVE_WITHOUT_CONTEXT' };
    }
    return { status: 'NOT_FOUND' };
  }

  let tasksQ = supabase
    .from('tasks')
    .select('*, entities:entity_id(id, name, category)')
    .eq('user_id', userId);

  if (statuses.length === 1) {
    tasksQ = tasksQ.eq('status', statuses[0]);
  } else {
    tasksQ = tasksQ.in('status', statuses);
  }

  const { data: dbTasks, error: dbErr } = await tasksQ;

  if (dbErr || !dbTasks || dbTasks.length === 0) {
    const containerRes = await resolveUserContainer(cleanQuery, normClean, userId);
    if (containerRes) return containerRes;
    return { status: 'NOT_FOUND' };
  }

  // Prefix UUID match (e.g. 8-character prefix ID)
  if (rawStr.length >= 8 && /^[0-9a-fA-F-]+$/.test(rawStr)) {
    const prefixMatches = dbTasks.filter(t => t.id.toLowerCase().startsWith(rawStr.toLowerCase()));
    if (prefixMatches.length === 1) {
      return { status: 'RESOLVED', taskId: prefixMatches[0].id, task: prefixMatches[0] };
    }
    if (prefixMatches.length > 1) {
      return { status: 'AMBIGUOUS', candidates: prefixMatches };
    }
  }

  // A. Exact normalized title match (case, accent, punctuation insensitive)
  const exact = dbTasks.filter(t => normalizeTextForMatching(t.title) === normClean);
  if (exact.length === 1) {
    return { status: 'RESOLVED', taskId: exact[0].id, task: exact[0] };
  }
  if (exact.length > 1) {
    return { status: 'AMBIGUOUS', candidates: exact };
  }

  // B. Substring match on normalized title
  const sub = dbTasks.filter(t => {
    const normT = normalizeTextForMatching(t.title);
    return normT.includes(normClean) || normClean.includes(normT);
  });
  if (sub.length === 1) {
    return { status: 'RESOLVED', taskId: sub[0].id, task: sub[0] };
  }
  if (sub.length > 1) {
    return { status: 'AMBIGUOUS', candidates: sub };
  }

  // C. Tokenized matching with deterministic scoring
  const scored = [];
  for (const t of dbTasks) {
    const score = calculateMatchScore(cleanQuery, t.title);
    if (score >= 0.5) {
      scored.push({ task: t, score });
    }
  }

  scored.sort((a, b) => b.score - a.score);

  if (scored.length === 1) {
    return { status: 'RESOLVED', taskId: scored[0].task.id, task: scored[0].task };
  }
  if (scored.length > 1) {
    const top = scored[0];
    const runnerUp = scored[1];
    if (top.score >= 0.75 && (top.score - runnerUp.score) >= 0.20) {
      return { status: 'RESOLVED', taskId: top.task.id, task: top.task };
    }
    return { status: 'AMBIGUOUS', candidates: scored.map(s => s.task) };
  }

  // D. Container Matching (Project / List Entity Resolution fallback)
  const containerRes = await resolveUserContainer(cleanQuery, normClean, userId);
  if (containerRes) return containerRes;

  return { status: 'NOT_FOUND' };
}

/**
 * Domain tool for managing tasks.
 */
export async function executeTaskTool({ action, params = {}, user, language = 'es', userMessage = '', referenceTime = null }) {
  const userId = user?.id;
  const phoneNumber = user?.phone_number;
  const timezone = user?.timezone || DEFAULT_TIMEZONE;

  const normalizedAction = String(action || 'create').replace(/_task$/, '');

  switch (normalizedAction) {
    case 'create': {
      const rawItems = Array.isArray(params.items) && params.items.length > 0
        ? params.items
        : (Array.isArray(params.titles) && params.titles.length > 0
          ? params.titles.map(t => ({ title: t, ...params }))
          : [params]);

      const createdTasks = [];
      let lastFailure = null;

      // Check if at least one item has a non-empty title
      const hasAnyTitle = rawItems.some(item => {
        const t = item.title || item.content || item.name || item.text || '';
        return Boolean(String(t).trim());
      });

      if (!hasAnyTitle) {
        return {
          success: false,
          action: 'invalid_parameters',
          errorCode: 'INVALID_PARAMETERS',
          error: language === 'en' ? 'Missing task title.' : 'Falta el título de la tarea.',
          rawSummary: language === 'en' ? 'Missing task title.' : 'Falta el título de la tarea.',
        };
      }

      for (const item of rawItems) {
        const title = item.title || item.content || item.name || item.text || '';
        const entityName = item.entityName || item.entity_name || item.project || params.entityName || null;
        // A named task container is a project/list unless the planner has
        // explicit evidence for a different existing entity type.
        const entityCategory = item.entityCategory || item.entity_category || params.entityCategory || 'project';
        const dueDate = item.dueDate || item.due_date || item.targetTime || params.dueDate || null;
        const priority = item.priority || params.priority || 'medium';
        const description = item.description || params.description || null;
        const scheduleReminder = item.scheduleReminder ?? params.scheduleReminder ?? true;

        const cleanTitle = String(title).trim();
        if (!cleanTitle) continue;

        const normalizedPriority = normalizeTaskPriority(priority);
        if (!normalizedPriority) {
          return {
            success: false,
            action: 'invalid_parameters',
            errorCode: 'INVALID_PARAMETERS',
            error: `Prioridad inválida '${priority}'. Valores permitidos: 'low', 'medium', 'high', 'urgent'.`,
            rawSummary: `Prioridad inválida '${priority}'.`,
          };
        }

        let entityId = null;
        let resolvedEntityName = null;
        if (entityName) {
          try {
            const entity = await findOrCreateEntityFuzzy({
              userId,
              name: entityName,
              category: entityCategory,
            });
            if (entity) {
              entityId = entity.id;
              resolvedEntityName = entity.name;
            }
          } catch (entErr) {
            console.warn('[taskTools] entity resolution error:', entErr.message);
          }
        }

        let parsedDueDate = null;
        if (dueDate) {
          parsedDueDate = parseTargetTime(dueDate, timezone, referenceTime);
        }

        const taskRes = await createTask({
          userId,
          title: cleanTitle,
          description,
          priority: normalizedPriority,
          dueDate: parsedDueDate ? parsedDueDate.toISOString() : null,
          entityId,
        });

        if (taskRes?.error) {
          lastFailure = taskRes.error;
          continue;
        }

        const task = taskRes?.data || taskRes;

        if (task?.id) {
          createdTasks.push({
            id: task.id,
            title: cleanTitle,
            entityId,
            entityName: resolvedEntityName || entityName,
            dueDate: parsedDueDate ? parsedDueDate.toISOString() : null,
            priority: normalizedPriority,
          });

          // Auto-schedule reminder ONLY if dueDate was explicitly specified
          if (scheduleReminder && parsedDueDate && parsedDueDate.getTime() > Date.now()) {
            try {
              const reminderContent = resolvedEntityName
                ? `[${resolvedEntityName}] ${cleanTitle}`
                : cleanTitle;
              await saveReminder({
                userId,
                phoneNumber,
                taskId: task.id,
                content: reminderContent,
                sendAt: parsedDueDate.toISOString(),
                requiresConfirmation: true,
              });
            } catch (remErr) {
              console.warn('[taskTools] auto-reminder error:', remErr.message);
            }
          }
        }
      }

      if (createdTasks.length === 0) {
        if (lastFailure) {
          const isConstraint = lastFailure.code === 'DATABASE_CONSTRAINT_ERROR' || lastFailure.code === '23514';
          return {
            success: false,
            action: isConstraint ? 'database_constraint_error' : 'database_error',
            errorCode: isConstraint ? 'DATABASE_CONSTRAINT_ERROR' : 'DATABASE_ERROR',
            error: lastFailure.message || 'Error de base de datos al registrar la tarea.',
            rawSummary: lastFailure.message || 'Error de base de datos.',
          };
        }

        return {
          success: false,
          action: 'invalid_parameters',
          errorCode: 'INVALID_PARAMETERS',
          error: language === 'en' ? 'Missing task title.' : 'Falta el título de la tarea.',
          rawSummary: language === 'en' ? 'Missing task title.' : 'Falta el título de la tarea.',
        };
      }

      const formattedCard = formatTaskCreatedCard(createdTasks, language);

      return {
        success: true,
        action: 'created_tasks_batch',
        data: createdTasks,
        rawSummary: formattedCard,
        formattedCard,
      };
    }

    case 'complete': {
      const { taskId: rawTaskId = null, scope = null, completeAll = false, entityName = null } = params;
      const targetQuery = rawTaskId || params.id || params.target || params.title || params.query || null;

      // 1. Direct Complete All / Scope All (or active container in context)
      if (scope === 'all' || completeAll) {
        let resolvedEntName = entityName;
        let resolvedEntId = null;
        if (!resolvedEntName) {
          if (targetQuery) {
            const entRes = await resolveTargetTask({ target: targetQuery, userId, userOrPhone: user || phoneNumber, userMessage });
            if (entRes.status === 'RESOLVED_CONTAINER') {
              resolvedEntName = entRes.entityName;
              resolvedEntId = entRes.entityId || null;
            }
          }
          if (!resolvedEntName) {
            const wm = getWorkingMemory(user || phoneNumber);
            if (wm?.activeEntity) {
              resolvedEntName = wm.activeEntity;
            }
            if (wm?.activeEntityId) {
              resolvedEntId = wm.activeEntityId;
            }
          }
        }

        const res = await completeTasksByQuery({
          userId,
          entityName: resolvedEntName,
          entityId: resolvedEntId,
          completeAll: true,
        });
        if (res?.error) {
          return {
            success: false,
            action: 'database_error',
            errorCode: res.error.code || 'DATABASE_ERROR',
            error: res.error.message,
            rawSummary: res.error.message,
          };
        }
        const count = typeof res === 'object' ? (res?.completedCount || 0) : (Number(res) || 0);
        const card = formatTaskCompletedCard({ completedCount: count, entityName: resolvedEntName }, language);
        return {
          success: true,
          action: 'completed_tasks',
          data: { completedCount: count, entityName: resolvedEntName },
          rawSummary: card,
          formattedCard: card,
          confirmation: card,
        };
      }

      if (!targetQuery && !userMessage) {
        return {
          success: false,
          action: 'missing_target_id',
          errorCode: 'MISSING_TARGET_ID',
          error: language === 'en' ? 'Missing task to complete. Please specify which task you want to complete.' : 'Falta la tarea a completar. Por favor especifica cuál tarea deseas completar.',
          rawSummary: language === 'en' ? 'Which task would you like me to complete?' : '¿Cuál tarea deseas que complete?',
          confirmation: language === 'en' ? 'Which task would you like me to complete?' : '¿Cuál tarea deseas que complete?',
        };
      }

      const resolution = await resolveTargetTask({ target: targetQuery, userId, userOrPhone: user || phoneNumber, userMessage, operation: 'complete', allowedStatuses: ['pending'] });

      // Handle Container Resolution (e.g. user said "limpia la lista de compras" and targetQuery resolved to container)
      if (resolution.status === 'RESOLVED_CONTAINER') {
        const res = await completeTasksByQuery({
          userId,
          entityName: resolution.entityName,
          completeAll: true,
        });
        if (res?.error) {
          return {
            success: false,
            action: 'database_error',
            errorCode: res.error.code || 'DATABASE_ERROR',
            error: res.error.message,
            rawSummary: res.error.message,
          };
        }
        const count = typeof res === 'object' ? (res?.completedCount || 0) : (Number(res) || 0);
        const card = formatTaskCompletedCard({ completedCount: count, entityName: resolution.entityName }, language);
        return {
          success: true,
          action: 'completed_tasks',
          data: { completedCount: count, entityName: resolution.entityName },
          rawSummary: card,
          formattedCard: card,
          confirmation: card,
        };
      }

      if (resolution.status === 'MISSING_CONTEXT') {
        const missingContextMsg = language === 'en'
          ? 'Which task would you like me to complete? Please specify the task title.'
          : '¿Cuál tarea deseas que complete? Por favor especifica el nombre de la tarea.';
        return {
          success: false,
          action: 'missing_target_id',
          errorCode: 'MISSING_TARGET_ID',
          error: missingContextMsg,
          rawSummary: missingContextMsg,
          confirmation: missingContextMsg,
        };
      }

      if (resolution.status === 'AMBIGUOUS') {
        const ambiguityMsg = language === 'en'
          ? 'Multiple tasks match your request. Please clarify which one you want to complete.'
          : 'Hay múltiples tareas que coinciden con tu solicitud. Por favor aclara cuál de ellas deseas completar.';
        return {
          success: false,
          action: 'ambiguous_target',
          errorCode: 'AMBIGUOUS_TARGET',
          error: ambiguityMsg,
          rawSummary: ambiguityMsg,
          confirmation: `⚠️ ${ambiguityMsg}`,
        };
      }

      if (resolution.status === 'NOT_FOUND' || !resolution.taskId) {
        const notFoundMsg = language === 'en'
          ? 'No pending task matching that description was found.'
          : 'No se encontró ninguna tarea pendiente que coincida con esa descripción.';
        return {
          success: false,
          action: 'task_not_found',
          errorCode: 'NOT_FOUND',
          error: notFoundMsg,
          rawSummary: notFoundMsg,
          confirmation: `⚠️ ${notFoundMsg}`,
        };
      }

      const updateRes = await updateTask(resolution.taskId, { status: 'completed' }, userId);
      if (updateRes?.error || !updateRes?.id) {
        const errCode = updateRes?.error?.code || 'NOT_FOUND';
        const isAccessDenied = errCode === 'ACCESS_DENIED';
        const defaultMsg = isAccessDenied
          ? (language === 'en' ? 'Access denied: this task belongs to another user.' : 'No tienes permisos sobre esta tarea.')
          : (errCode === 'NOT_FOUND' ? (language === 'en' ? 'Task not found.' : 'No se encontró la tarea especificada.') : 'Error de base de datos.');
        return {
          success: false,
          action: isAccessDenied ? 'access_denied' : (errCode === 'NOT_FOUND' ? 'task_not_found' : 'database_error'),
          errorCode: errCode,
          error: updateRes?.error?.message || defaultMsg,
          rawSummary: defaultMsg,
          confirmation: `⚠️ ${defaultMsg}`,
        };
      }

      const completedTask = updateRes.data || updateRes;
      const formattedCard = formatTaskCompletedCard(completedTask, language);

      return {
        success: true,
        action: 'completed_task',
        taskId: completedTask.id,
        title: completedTask.title,
        data: completedTask,
        rawSummary: formattedCard,
        formattedCard,
        confirmation: formattedCard,
      };
    }

    case 'update': {
      const targetQuery = params.taskId || params.id || params.target || params.title || params.query || null;
      if (!targetQuery && !userMessage) {
        return {
          success: false,
          action: 'missing_target_id',
          errorCode: 'MISSING_TARGET_ID',
          error: language === 'en' ? 'Missing task ID to update.' : 'Falta el ID de la tarea a actualizar.',
          rawSummary: language === 'en' ? 'Which task would you like me to update?' : '¿Cuál tarea deseas que actualice?',
          confirmation: language === 'en' ? 'Which task would you like me to update?' : '¿Cuál tarea deseas que actualice?',
        };
      }

      const resolution = await resolveTargetTask({ target: targetQuery, userId, userOrPhone: user || phoneNumber, userMessage, operation: 'update', allowedStatuses: ['pending', 'completed'] });

      if (resolution.status === 'MISSING_CONTEXT') {
        const missingContextMsg = language === 'en'
          ? 'Which task would you like me to update? Please specify the task title.'
          : '¿Cuál tarea deseas que actualice? Por favor especifica el nombre de la tarea.';
        return {
          success: false,
          action: 'missing_target_id',
          errorCode: 'MISSING_TARGET_ID',
          error: missingContextMsg,
          rawSummary: missingContextMsg,
          confirmation: missingContextMsg,
        };
      }

      if (resolution.status === 'AMBIGUOUS') {
        const ambiguityMsg = language === 'en'
          ? 'Multiple tasks match your request. Please clarify which one you want to update.'
          : 'Hay múltiples tareas que coinciden. Por favor aclara cuál deseas actualizar.';
        return {
          success: false,
          action: 'ambiguous_target',
          errorCode: 'AMBIGUOUS_TARGET',
          error: ambiguityMsg,
          rawSummary: ambiguityMsg,
          confirmation: `⚠️ ${ambiguityMsg}`,
        };
      }

      if (resolution.status === 'NOT_FOUND' || !resolution.taskId) {
        const notFoundMsg = language === 'en'
          ? 'No pending task matching that description was found.'
          : 'No se encontró ninguna tarea que coincida con esa descripción.';
        return {
          success: false,
          action: 'task_not_found',
          errorCode: 'NOT_FOUND',
          error: notFoundMsg,
          rawSummary: notFoundMsg,
          confirmation: `⚠️ ${notFoundMsg}`,
        };
      }

      const updatesObj = params.updates || params;
      const title = updatesObj.title;
      const priority = updatesObj.priority;
      const status = updatesObj.status;
      const dueDate = updatesObj.dueDate !== undefined ? updatesObj.dueDate : updatesObj.due_date;

      const updates = {};
      if (title) updates.title = String(title).trim();
      if (priority) {
        const normalizedPriority = normalizeTaskPriority(priority);
        if (!normalizedPriority) {
          return {
            success: false,
            action: 'invalid_parameters',
            errorCode: 'INVALID_PARAMETERS',
            error: `Prioridad inválida '${priority}'. Valores permitidos: 'low', 'medium', 'high', 'urgent'.`,
            rawSummary: `Prioridad inválida '${priority}'.`,
          };
        }
        updates.priority = normalizedPriority;
      }
      if (status) updates.status = status;
      if (dueDate !== undefined) {
        const parsedDue = dueDate ? parseTargetTime(dueDate, timezone, referenceTime) : null;
        updates.due_date = parsedDue ? parsedDue.toISOString() : null;
      }

      const updateRes = await updateTask(resolution.taskId, updates, userId);
      if (updateRes?.error || !updateRes?.id) {
        const errCode = updateRes?.error?.code || 'NOT_FOUND';
        const isAccessDenied = errCode === 'ACCESS_DENIED';
        const defaultMsg = isAccessDenied
          ? (language === 'en' ? 'Access denied: this task belongs to another user.' : 'No tienes permisos sobre esta tarea.')
          : (errCode === 'NOT_FOUND' ? (language === 'en' ? 'Task not found.' : 'No se encontró la tarea especificada.') : 'Error de base de datos.');
        return {
          success: false,
          action: isAccessDenied ? 'access_denied' : (errCode === 'NOT_FOUND' ? 'task_not_found' : 'database_error'),
          errorCode: errCode,
          error: updateRes?.error?.message || defaultMsg,
          rawSummary: defaultMsg,
          confirmation: `⚠️ ${defaultMsg}`,
        };
      }

      const updatedTask = updateRes.data || updateRes;
      const formattedCard = formatTaskUpdatedCard(updatedTask, language);

      return {
        success: true,
        action: 'updated_task',
        taskId: updatedTask.id,
        title: updatedTask.title,
        data: updatedTask,
        rawSummary: formattedCard,
        formattedCard,
        confirmation: formattedCard,
      };
    }

    case 'delete': {
      const targetQuery = params.taskId || params.id || params.target || params.title || params.query || null;
      if (!targetQuery && !userMessage) {
        return {
          success: false,
          action: 'missing_target_id',
          errorCode: 'MISSING_TARGET_ID',
          error: language === 'en' ? 'Missing task ID to delete.' : 'Falta el ID de la tarea a eliminar.',
          rawSummary: language === 'en' ? 'Which task would you like me to delete?' : '¿Cuál tarea deseas que elimine?',
          confirmation: language === 'en' ? 'Which task would you like me to delete?' : '¿Cuál tarea deseas que elimine?',
        };
      }

      const resolution = await resolveTargetTask({ target: targetQuery, userId, userOrPhone: user || phoneNumber, userMessage, operation: 'delete', allowedStatuses: ['pending', 'completed'] });

      if (resolution.status === 'AMBIGUOUS') {
        const ambiguityMsg = language === 'en'
          ? 'Multiple tasks match your request. Please clarify which one you want to delete.'
          : 'Hay múltiples tareas que coinciden. Por favor aclara cuál deseas eliminar.';
        return {
          success: false,
          action: 'ambiguous_target',
          errorCode: 'AMBIGUOUS_TARGET',
          error: ambiguityMsg,
          rawSummary: ambiguityMsg,
          confirmation: `⚠️ ${ambiguityMsg}`,
        };
      }

      if (resolution.status === 'NOT_FOUND' || !resolution.taskId) {
        const notFoundMsg = language === 'en'
          ? 'No task matching that description was found.'
          : 'No se encontró la tarea especificada.';
        return {
          success: false,
          action: 'task_not_found',
          errorCode: 'NOT_FOUND',
          error: notFoundMsg,
          rawSummary: notFoundMsg,
          confirmation: `⚠️ ${notFoundMsg}`,
        };
      }

      const deleteRes = await deleteTask(resolution.taskId, userId);
      if (deleteRes?.error || deleteRes?.success === false) {
        const errCode = deleteRes?.error?.code || 'NOT_FOUND';
        const isAccessDenied = errCode === 'ACCESS_DENIED';
        const defaultMsg = isAccessDenied
          ? (language === 'en' ? 'Access denied: this task belongs to another user.' : 'No tienes permisos sobre esta tarea.')
          : (errCode === 'NOT_FOUND' ? (language === 'en' ? 'Task not found.' : 'No se encontró la tarea especificada.') : 'Error de base de datos.');
        return {
          success: false,
          action: isAccessDenied ? 'access_denied' : (errCode === 'NOT_FOUND' ? 'task_not_found' : 'database_error'),
          errorCode: errCode,
          error: deleteRes?.error?.message || defaultMsg,
          rawSummary: defaultMsg,
          confirmation: `⚠️ ${defaultMsg}`,
        };
      }

      return {
        success: true,
        action: 'deleted_task',
        rawSummary: language === 'en' ? 'Task deleted.' : 'Tarea eliminada.',
        formattedCard: language === 'en' ? '🗑️ *Task deleted*' : '🗑️ *Tarea eliminada*',
        confirmation: language === 'en' ? '🗑️ *Task deleted*' : '🗑️ *Tarea eliminada*',
      };
    }

    default:
      return {
        success: false,
        action: 'unsupported_action',
        errorCode: 'UNSUPPORTED_ACTION',
        error: `Acción '${action}' no soportada para manage_task.`,
        rawSummary: `Acción '${action}' no soportada para manage_task.`,
      };
  }
}