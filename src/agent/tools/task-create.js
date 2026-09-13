import {
  createTasksBatch,
  findOrCreateEntityFuzzy,
  inspectOwnedEntityReferences,
  saveReminder,
} from '../../infrastructure/database/index.js';
import { getReminderConfirmationPreference } from '../../infrastructure/database/memories.js';
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

  const hasInvalidTitle = rawItems.length === 0
    || rawItems.some((item) => !String(item?.title || '').trim());

  if (hasInvalidTitle) {
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
  const preparedItems = [];
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

    preparedItems.push({
      title: cleanTitle,
      description,
      priority: normalizedPriority,
      dueDate: parsedDueDate ? parsedDueDate.toISOString() : null,
      entityId,
      entityName: resolvedEntityName || entityName,
      scheduleReminder,
    });
  }

  const taskResult = await createTasksBatch({
    userId,
    items: preparedItems,
  });

  if (taskResult?.error || !Array.isArray(taskResult?.data) || taskResult.data.length !== preparedItems.length) {
    const failure = taskResult?.error || {
      code: 'DATABASE_ERROR',
      message: 'La base de datos no confirmó el lote completo de tareas.',
    };
    const isConstraint = failure.code === 'DATABASE_CONSTRAINT_ERROR' || failure.code === '23514';
    const isValidation = failure.code === 'INVALID_PARAMETERS';
    return {
      success: false,
      action: isValidation ? 'invalid_parameters' : (isConstraint ? 'database_constraint_error' : 'database_error'),
      errorCode: isValidation ? 'INVALID_PARAMETERS' : (isConstraint ? 'DATABASE_CONSTRAINT_ERROR' : 'DATABASE_ERROR'),
      error: failure.message || 'Error de base de datos al registrar las tareas.',
      rawSummary: failure.message || 'Error de base de datos.',
    };
  }

  const createdTasks = taskResult.data.map((task, index) => {
    const item = preparedItems[index];
    return {
      id: task.id,
      title: item.title,
      entityId: item.entityId,
      entityName: item.entityName,
      dueDate: item.dueDate,
      priority: item.priority,
    };
  });

  // Preserve current product behavior: reminders remain post-persistence and
  // do not participate in the atomic task INSERT.
  let confirmationPref = null;
  let prefResolved = false;

  for (let index = 0; index < preparedItems.length; index += 1) {
    const item = preparedItems[index];
    const task = taskResult.data[index];
    if (item.scheduleReminder && item.dueDate && new Date(item.dueDate).getTime() > Date.now()) {
      try {
        if (!prefResolved) {
          try {
            confirmationPref = (userId && typeof getReminderConfirmationPreference === 'function')
              ? await getReminderConfirmationPreference(userId)
              : null;
          } catch {
            confirmationPref = null;
          }
          prefResolved = true;
        }

        const reminderContent = item.entityName
          ? `[${item.entityName}] ${item.title}`
          : item.title;
        await saveReminder({
          userId,
          phoneNumber,
          taskId: task.id,
          content: reminderContent,
          sendAt: item.dueDate,
          requiresConfirmation: true,
          nudgeIntervalMinutes: confirmationPref?.nudgeIntervalMinutes || 15,
        });
      } catch (error) {
        console.warn('[task-create] auto-reminder error:', error.message);
      }
    }
  }

  return {
    success: true,
    action: 'created_tasks_batch',
    data: createdTasks,
  };
}
