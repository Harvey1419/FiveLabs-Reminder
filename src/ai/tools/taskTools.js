import {
  createTask,
  findOrCreateEntityFuzzy,
  getTasksWithEntities,
  completeTasksByQuery,
  updateTask,
  deleteTask,
  saveReminder,
  getTasks,
} from '../../db/index.js';
import { normalizeTaskPriority } from '../../db/tasks.js';
import { parseTargetTime, DEFAULT_TIMEZONE } from '../../utils/time.js';
import {
  formatTaskCreatedCard,
  formatTaskListCard,
  formatTaskCompletedCard,
  formatTaskUpdatedCard,
} from './formatters.js';

/**
 * Domain tool for managing tasks.
 */
export async function executeTaskTool({ action, params = {}, user, language = 'es' }) {
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
        const entityCategory = item.entityCategory || item.entity_category || params.entityCategory || 'other';
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
          parsedDueDate = parseTargetTime(dueDate, timezone);
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
      const { taskId = null, scope = null, completeAll = false, entityName = null } = params;

      // 1. Missing Target Guard: single-task completion strictly REQUIRES taskId
      if (!taskId && scope !== 'all' && !completeAll) {
        return {
          success: false,
          action: 'missing_target_id',
          errorCode: 'MISSING_TARGET_ID',
          error: language === 'en' ? 'Missing task ID to complete. Please specify which task you want to complete.' : 'Falta el ID de la tarea a completar. Por favor especifica cuál tarea deseas completar.',
          rawSummary: language === 'en' ? 'Which task would you like me to complete?' : '¿Cuál tarea deseas que complete?',
          confirmation: language === 'en' ? 'Which task would you like me to complete?' : '¿Cuál tarea deseas que complete?',
        };
      }

      let completedCount = 0;

      if (taskId) {
        const updateRes = await updateTask(taskId, { status: 'completed' }, userId);
        if (updateRes?.error || !updateRes?.id) {
          const errCode = updateRes?.error?.code || 'NOT_FOUND';
          return {
            success: false,
            action: errCode === 'NOT_FOUND' ? 'task_not_found' : 'database_error',
            errorCode: errCode,
            error: updateRes?.error?.message || (language === 'en' ? 'Task not found or access denied.' : 'No se encontró la tarea o no tienes permisos sobre ella.'),
            rawSummary: language === 'en' ? 'Task not found.' : 'No se encontró la tarea especificada.',
            confirmation: language === 'en' ? '⚠️ Task not found.' : '⚠️ No se encontró la tarea especificada.',
          };
        }
        completedCount = 1;
      } else if (scope === 'all' || completeAll) {
        const res = await completeTasksByQuery({
          userId,
          entityName,
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
        completedCount = typeof res === 'object' ? (res?.completedCount || 0) : (Number(res) || 0);
      }

      const formattedCard = formatTaskCompletedCard(completedCount, language);

      return {
        success: true,
        action: 'completed_tasks',
        data: {
          completedCount,
        },
        rawSummary: formattedCard,
        formattedCard,
      };
    }

    case 'update': {
      const taskId = params.taskId || params.id;
      if (!taskId) {
        return {
          success: false,
          action: 'missing_target_id',
          errorCode: 'MISSING_TARGET_ID',
          error: language === 'en' ? 'Missing task ID to update.' : 'Falta el ID de la tarea a actualizar.',
          rawSummary: language === 'en' ? 'Which task would you like me to update?' : '¿Cuál tarea deseas que actualice?',
          confirmation: language === 'en' ? 'Which task would you like me to update?' : '¿Cuál tarea deseas que actualice?',
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
        const parsedDue = dueDate ? parseTargetTime(dueDate, timezone) : null;
        updates.due_date = parsedDue ? parsedDue.toISOString() : null;
      }

      const updateRes = await updateTask(taskId, updates, userId);
      if (updateRes?.error || !updateRes?.id) {
        const errCode = updateRes?.error?.code || 'NOT_FOUND';
        return {
          success: false,
          action: errCode === 'NOT_FOUND' ? 'task_not_found' : 'database_error',
          errorCode: errCode,
          error: updateRes?.error?.message || (language === 'en' ? 'Task not found or access denied.' : 'No se encontró la tarea o no tienes permisos sobre ella.'),
          rawSummary: language === 'en' ? 'Task not found.' : 'No se encontró la tarea especificada.',
          confirmation: language === 'en' ? '⚠️ Task not found.' : '⚠️ No se encontró la tarea especificada.',
        };
      }

      const updatedTask = updateRes.data || updateRes;
      const formattedCard = formatTaskUpdatedCard(updatedTask, language);

      return {
        success: true,
        action: 'updated_task',
        data: updatedTask,
        rawSummary: formattedCard,
        formattedCard,
      };
    }

    case 'delete': {
      const taskId = params.taskId || params.id;

      if (!taskId) {
        return {
          success: false,
          action: 'missing_target_id',
          errorCode: 'MISSING_TARGET_ID',
          error: language === 'en' ? 'Missing task ID to delete.' : 'Falta el ID de la tarea a eliminar.',
          rawSummary: language === 'en' ? 'Which task would you like me to delete?' : '¿Cuál tarea deseas que elimine?',
          confirmation: language === 'en' ? 'Which task would you like me to delete?' : '¿Cuál tarea deseas que elimine?',
        };
      }

      const deleteRes = await deleteTask(taskId, userId);
      if (deleteRes?.error || deleteRes?.success === false) {
        const errCode = deleteRes?.error?.code || 'NOT_FOUND';
        return {
          success: false,
          action: errCode === 'NOT_FOUND' ? 'task_not_found' : 'database_error',
          errorCode: errCode,
          error: deleteRes?.error?.message || (language === 'en' ? 'Task not found or access denied.' : 'No se encontró la tarea especificada.'),
          rawSummary: language === 'en' ? 'Task not found.' : 'No se encontró la tarea especificada.',
          confirmation: language === 'en' ? '⚠️ Task not found.' : '⚠️ No se encontró la tarea especificada.',
        };
      }

      return {
        success: true,
        action: 'deleted_task',
        rawSummary: language === 'en' ? 'Task deleted.' : 'Tarea eliminada.',
        formattedCard: language === 'en' ? '🗑️ *Task deleted*' : '🗑️ *Tarea eliminada*',
      };
    }

    case 'list': {
      const { entityName = null, status = 'pending', limit = 50 } = params;
      const tasks = await getTasksWithEntities({
        userId,
        entityName,
        status,
        limit,
      });

      const formattedCard = formatTaskListCard(tasks, entityName, language);

      return {
        success: true,
        action: 'listed_tasks',
        data: tasks,
        rawSummary: formattedCard,
        formattedCard,
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

