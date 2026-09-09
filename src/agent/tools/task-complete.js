import {
  completeTasksByQuery,
  updateTask,
} from '../../infrastructure/database/index.js';
import { resolveTaskTarget } from './task-reference.js';

/** Canonical task completion mutation. */
export async function executeTaskComplete({
  params = {},
  user = {},
  language = 'es',
} = {}) {
  const userId = user?.id;
  const phoneNumber = user?.phone_number;
  const targetQuery = params.target || null;

  if (!targetQuery) {
    const message = language === 'en'
      ? 'Which task would you like me to complete?'
      : '¿Cuál tarea deseas que complete?';
    return {
      success: false,
      action: 'missing_target_id',
      errorCode: 'MISSING_TARGET_ID',
      error: language === 'en'
        ? 'Missing task to complete. Please specify which task you want to complete.'
        : 'Falta la tarea a completar. Por favor especifica cuál tarea deseas completar.',
      rawSummary: message,
      confirmation: message,
    };
  }

  const resolution = await resolveTaskTarget({
    target: targetQuery,
    userId,
    userOrPhone: user || phoneNumber,
    operation: 'complete',
    allowedStatuses: ['pending'],
  });

  if (resolution.status === 'RESOLVED_CONTAINER') {
    const result = await completeTasksByQuery({
      userId,
      entityName: resolution.entityName,
      entityId: resolution.entityId || null,
      completeAll: true,
    });
    if (result?.error) {
      return {
        success: false,
        action: 'database_error',
        errorCode: result.error.code || 'DATABASE_ERROR',
        error: result.error.message,
        rawSummary: result.error.message,
      };
    }

    const completedCount = typeof result === 'object'
      ? (result?.completedCount || 0)
      : (Number(result) || 0);
    return {
      success: true,
      action: 'completed_tasks',
      data: { completedCount, entityName: resolution.entityName },
    };
  }

  if (resolution.status === 'MISSING_CONTEXT') {
    const message = language === 'en'
      ? 'Which task would you like me to complete? Please specify the task title.'
      : '¿Cuál tarea deseas que complete? Por favor especifica el nombre de la tarea.';
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
      ? 'Multiple tasks match your request. Please clarify which one you want to complete.'
      : 'Hay múltiples tareas que coinciden con tu solicitud. Por favor aclara cuál de ellas deseas completar.';
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
      : 'No se encontró ninguna tarea pendiente que coincida con esa descripción.';
    return {
      success: false,
      action: 'task_not_found',
      errorCode: 'NOT_FOUND',
      error: message,
      rawSummary: message,
      confirmation: `⚠️ ${message}`,
    };
  }

  const updateResult = await updateTask(resolution.taskId, { status: 'completed' }, userId);
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

  const completedTask = updateResult.data || updateResult;
  return {
    success: true,
    action: 'completed_task',
    taskId: completedTask.id,
    title: completedTask.title,
    data: completedTask,
  };
}
