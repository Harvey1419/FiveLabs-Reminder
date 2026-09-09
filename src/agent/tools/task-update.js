import { updateTask } from '../../infrastructure/database/index.js';
import { normalizeTaskPriority } from '../../infrastructure/database/tasks.js';
import { parseTargetTime, DEFAULT_TIMEZONE } from '../../shared/time.js';
import { resolveTaskTarget } from './task-reference.js';

export async function executeTaskUpdate({
  params = {},
  user = null,
  language = 'es',
  referenceTime = null,
} = {}) {
  const userId = user?.id;
  const phoneNumber = user?.phone_number;
  const timezone = user?.timezone || DEFAULT_TIMEZONE;
  const targetQuery = params.target || null;

  if (!targetQuery) {
    return {
      success: false,
      action: 'missing_target_id',
      errorCode: 'MISSING_TARGET_ID',
      error: language === 'en' ? 'Missing task ID to update.' : 'Falta el ID de la tarea a actualizar.',
      rawSummary: language === 'en' ? 'Which task would you like me to update?' : '¿Cuál tarea deseas que actualice?',
      confirmation: language === 'en' ? 'Which task would you like me to update?' : '¿Cuál tarea deseas que actualice?',
    };
  }

  const resolution = await resolveTaskTarget({
    target: targetQuery,
    userId,
    userOrPhone: user || phoneNumber,
    operation: 'update',
    allowedStatuses: ['pending', 'completed'],
  });

  if (resolution.status === 'MISSING_CONTEXT') {
    const message = language === 'en'
      ? 'Which task would you like me to update? Please specify the task title.'
      : '¿Cuál tarea deseas que actualice? Por favor especifica el nombre de la tarea.';
    return {
      success: false,
      action: 'missing_target_id',
      errorCode: 'MISSING_TARGET_ID',
      error: message,
      rawSummary: message,
      confirmation: message,
    };
  }

  if (resolution.status === 'AMBIGUOUS') {
    const message = language === 'en'
      ? 'Multiple tasks match your request. Please clarify which one you want to update.'
      : 'Hay múltiples tareas que coinciden. Por favor aclara cuál deseas actualizar.';
    return {
      success: false,
      action: 'ambiguous_target',
      errorCode: 'AMBIGUOUS_TARGET',
      error: message,
      rawSummary: message,
      confirmation: `⚠️ ${message}`,
    };
  }

  if (resolution.status === 'NOT_FOUND' || !resolution.taskId) {
    const message = language === 'en'
      ? 'No pending task matching that description was found.'
      : 'No se encontró ninguna tarea que coincida con esa descripción.';
    return {
      success: false,
      action: 'task_not_found',
      errorCode: 'NOT_FOUND',
      error: message,
      rawSummary: message,
      confirmation: `⚠️ ${message}`,
    };
  }

  const updatesObj = params.updates || {};
  const title = updatesObj.title;
  const priority = updatesObj.priority;
  const status = updatesObj.status;
  const dueDate = updatesObj.dueDate;
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

  const updateResult = await updateTask(resolution.taskId, updates, userId);
  if (updateResult?.error || !updateResult?.id) {
    const errorCode = updateResult?.error?.code || 'NOT_FOUND';
    const accessDenied = errorCode === 'ACCESS_DENIED';
    const defaultMessage = accessDenied
      ? (language === 'en' ? 'Access denied: this task belongs to another user.' : 'No tienes permisos sobre esta tarea.')
      : (errorCode === 'NOT_FOUND'
        ? (language === 'en' ? 'Task not found.' : 'No se encontró la tarea especificada.')
        : 'Error de base de datos.');
    return {
      success: false,
      action: accessDenied ? 'access_denied' : (errorCode === 'NOT_FOUND' ? 'task_not_found' : 'database_error'),
      errorCode,
      error: updateResult?.error?.message || defaultMessage,
      rawSummary: defaultMessage,
      confirmation: `⚠️ ${defaultMessage}`,
    };
  }

  const updatedTask = updateResult.data || updateResult;
  return {
    success: true,
    action: 'updated_task',
    taskId: updatedTask.id,
    title: updatedTask.title,
    data: updatedTask,
  };
}
