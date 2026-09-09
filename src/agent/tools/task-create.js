import {
  createTask,
  findOrCreateEntityFuzzy,
  saveReminder,
} from '../../infrastructure/database/index.js';
import { normalizeTaskPriority } from '../../infrastructure/database/tasks.js';
import { parseTargetTime, DEFAULT_TIMEZONE } from '../../shared/time.js';

/** Canonical task creation mutation. Natural-language interpretation belongs
 * upstream; this module only validates and persists structured task data. */
export async function executeTaskCreate({
  params = {},
  user = {},
  language = 'es',
  referenceTime = null,
} = {}) {
  const userId = user?.id;
  const phoneNumber = user?.phone_number;
  const timezone = user?.timezone || DEFAULT_TIMEZONE;

  const rawItems = Array.isArray(params.items) && params.items.length > 0
    ? params.items
    : (Array.isArray(params.titles) && params.titles.length > 0
      ? params.titles.map((title) => ({ title, ...params }))
      : [params]);

  const createdTasks = [];
  let lastFailure = null;

  const hasAnyTitle = rawItems.some((item) => {
    const title = item.title || item.content || item.name || item.text || '';
    return Boolean(String(title).trim());
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
      } catch (error) {
        console.warn('[task-create] entity resolution error:', error.message);
      }
    }

    let parsedDueDate = null;
    if (dueDate) parsedDueDate = parseTargetTime(dueDate, timezone, referenceTime);

    const taskResult = await createTask({
      userId,
      title: cleanTitle,
      description,
      priority: normalizedPriority,
      dueDate: parsedDueDate ? parsedDueDate.toISOString() : null,
      entityId,
    });

    if (taskResult?.error) {
      lastFailure = taskResult.error;
      continue;
    }

    const task = taskResult?.data || taskResult;
    if (!task?.id) continue;

    createdTasks.push({
      id: task.id,
      title: cleanTitle,
      entityId,
      entityName: resolvedEntityName || entityName,
      dueDate: parsedDueDate ? parsedDueDate.toISOString() : null,
      priority: normalizedPriority,
    });

    // Preserve current product behavior: an explicitly dated task may schedule
    // a confirmation reminder for the same due time.
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
      } catch (error) {
        console.warn('[task-create] auto-reminder error:', error.message);
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

  return {
    success: true,
    action: 'created_tasks_batch',
    data: createdTasks,
  };
}
