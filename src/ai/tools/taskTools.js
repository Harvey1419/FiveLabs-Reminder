import {
  createTask,
  findOrCreateEntityFuzzy,
  getTasksWithEntities,
  completeTasksByQuery,
  updateTask,
  saveReminder,
  getTasks,
} from '../../db/index.js';
import { parseTargetTime, DEFAULT_TIMEZONE } from '../../utils/time.js';
import { formatTaskCreatedCard, formatTaskListCard, formatTaskCompletedCard } from './formatters.js';

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

        const task = await createTask({
          userId,
          title: cleanTitle,
          description,
          priority,
          dueDate: parsedDueDate ? parsedDueDate.toISOString() : null,
          entityId,
        });

        if (task) {
          createdTasks.push({
            id: task.id,
            title: cleanTitle,
            entityName: resolvedEntityName || entityName,
            dueDate: parsedDueDate ? parsedDueDate.toISOString() : null,
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
        return {
          success: false,
          action: 'invalid_parameters',
          errorCode: 'INVALID_PARAMETERS',
          error: 'Falta el título de la tarea.',
          rawSummary: 'Falta el título de la tarea.',
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
        const updated = await updateTask(taskId, { status: 'completed' }, userId);
        if (!updated) {
          return {
            success: false,
            action: 'task_not_found',
            errorCode: 'NOT_FOUND',
            error: language === 'en' ? 'Task not found or access denied.' : 'No se encontró la tarea o no tienes permisos sobre ella.',
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
      const { taskId = null, title = null, priority = null, dueDate = null, status = null } = params;
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

      const updates = {};
      if (title) updates.title = String(title).trim();
      if (priority) updates.priority = priority;
      if (status) updates.status = status;
      if (dueDate !== undefined) {
        const parsedDue = dueDate ? parseTargetTime(dueDate, timezone) : null;
        updates.due_date = parsedDue ? parsedDue.toISOString() : null;
      }

      const updated = await updateTask(taskId, updates, userId);
      if (!updated) {
        return {
          success: false,
          action: 'task_not_found',
          errorCode: 'NOT_FOUND',
          error: language === 'en' ? 'Task not found or access denied.' : 'No se encontró la tarea o no tienes permisos sobre ella.',
          rawSummary: language === 'en' ? 'Task not found.' : 'No se encontró la tarea especificada.',
          confirmation: language === 'en' ? '⚠️ Task not found.' : '⚠️ No se encontró la tarea especificada.',
        };
      }

      return {
        success: true,
        action: 'updated_task',
        data: updated,
        rawSummary: 'Tarea actualizada.',
        formattedCard: '🔄 *Tarea actualizada*',
      };
    }

    case 'delete': {
      const { taskId = null } = params;

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

      const deleted = await deleteTask(taskId, userId);
      if (!deleted) {
        return {
          success: false,
          action: 'task_not_found',
          errorCode: 'NOT_FOUND',
          error: language === 'en' ? 'Task not found or access denied.' : 'No se encontró la tarea especificada.',
          rawSummary: language === 'en' ? 'Task not found.' : 'No se encontró la tarea especificada.',
          confirmation: language === 'en' ? '⚠️ Task not found.' : '⚠️ No se encontró la tarea especificada.',
        };
      }

      return {
        success: true,
        action: 'deleted_task',
        rawSummary: 'Tarea eliminada.',
        formattedCard: '🗑️ *Tarea eliminada*',
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
