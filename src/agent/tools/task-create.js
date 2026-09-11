import {
  createTask,
  findOrCreateEntityFuzzy,
  inspectOwnedEntityReferences,
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

  const rawItems = Array.isArray(params.items) && params.items.length > 0 ? params.items : [];

  const createdTasks = [];
  let lastFailure = null;

  const hasAnyTitle = rawItems.some((item) => Boolean(String(item.title || '').trim()));

  if (!hasAnyTitle) {
    return {
      success: false,
      action: 'invalid_parameters',
      errorCode: 'INVALID_PARAMETERS',
      error: language === 'en' ? 'Missing task title.' : 'Falta el título de la tarea.',
      rawSummary: language === 'en' ? 'Missing task title.' : 'Falta el título de la tarea.',
    };
  }

  const containerRequests = [];
  const seenContainers = new Set();
  for (const item of rawItems) {
    const name = String(item?.entityName || '').trim();
    if (!name) continue;
    const category = item?.entityCategory || 'project';
    const identity = `${category}\u0000${name.toLocaleLowerCase()}`;
    if (seenContainers.has(identity)) continue;
    seenContainers.add(identity);
    containerRequests.push({ name, category });
  }

  const preflight = await inspectOwnedEntityReferences({ userId, references: containerRequests });
  if (!preflight.success) {
    return {
      success: false,
      action: 'database_error',
      errorCode: preflight.errorCode || 'DATABASE_ERROR',
      error: preflight.error || 'No se pudieron validar los proyectos de las tareas.',
      rawSummary: preflight.error || 'No se pudieron validar los proyectos de las tareas.',
    };
  }
  const ambiguous = preflight.resolutions.find((resolution) => resolution.status === 'AMBIGUOUS');
  if (ambiguous) {
    const names = (ambiguous.candidates || []).slice(0, 5).map((entity) => entity.name).join(', ');
    const question = language === 'en'
      ? `Which project did you mean: ${names}?`
      : `¿A cuál proyecto te refieres: ${names}?`;
    return {
      success: false,
      action: 'ambiguous_entity',
      errorCode: 'AMBIGUOUS_TARGET',
      error: question,
      rawSummary: question,
      requiresClarification: true,
    };
  }

  const resolvedContainers = new Map();
  for (const request of containerRequests) {
    const identity = `${request.category}\u0000${request.name.toLocaleLowerCase()}`;
    try {
      const entity = await findOrCreateEntityFuzzy({
        userId,
        name: request.name,
        category: request.category,
      });
      if (!entity?.id) {
        return {
          success: false,
          action: 'database_error',
          errorCode: 'DATABASE_ERROR',
          error: 'No se pudo resolver el proyecto de las tareas.',
          rawSummary: 'No se pudo resolver el proyecto de las tareas.',
        };
      }
      resolvedContainers.set(identity, entity);
    } catch (error) {
      console.warn('[task-create] entity resolution error:', error.message);
      return {
        success: false,
        action: 'database_error',
        errorCode: 'DATABASE_ERROR',
        error: 'No se pudo resolver el proyecto de las tareas.',
        rawSummary: 'No se pudo resolver el proyecto de las tareas.',
      };
    }
  }

  for (const item of rawItems) {
    const title = item.title || '';
    const entityName = item.entityName || null;
    const entityCategory = item.entityCategory || 'project';
    const dueDate = item.dueDate || null;
    const priority = item.priority || 'medium';
    const description = item.description || null;
    const scheduleReminder = item.scheduleReminder ?? true;

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
      const identity = `${entityCategory}\u0000${String(entityName).trim().toLocaleLowerCase()}`;
      const entity = resolvedContainers.get(identity);
      entityId = entity.id;
      resolvedEntityName = entity.name;
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
