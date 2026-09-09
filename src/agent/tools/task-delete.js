import { deleteTask } from '../../infrastructure/database/index.js';
import { resolveTaskTarget } from './task-reference.js';

export async function executeTaskDelete({
  params = {},
  user = null,
  language = 'es',
} = {}) {
  const userId = user?.id;
  const phoneNumber = user?.phone_number;
  const targetQuery = params.taskId || params.id || params.target || params.title || params.query || null;

  if (!targetQuery) {
    return {
      success: false,
      action: 'missing_target_id',
      errorCode: 'MISSING_TARGET_ID',
      error: language === 'en' ? 'Missing task ID to delete.' : 'Falta el ID de la tarea a eliminar.',
      rawSummary: language === 'en' ? 'Which task would you like me to delete?' : '¿Cuál tarea deseas que elimine?',
      confirmation: language === 'en' ? 'Which task would you like me to delete?' : '¿Cuál tarea deseas que elimine?',
    };
  }

  const resolution = await resolveTaskTarget({
    target: targetQuery,
    userId,
    userOrPhone: user || phoneNumber,
    operation: 'delete',
    allowedStatuses: ['pending', 'completed'],
  });

  if (resolution.status === 'AMBIGUOUS') {
    const message = language === 'en'
      ? 'Multiple tasks match your request. Please clarify which one you want to delete.'
      : 'Hay múltiples tareas que coinciden. Por favor aclara cuál deseas eliminar.';
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
      ? 'No task matching that description was found.'
      : 'No se encontró la tarea especificada.';
    return {
      success: false,
      action: 'task_not_found',
      errorCode: 'NOT_FOUND',
      error: message,
      rawSummary: message,
      confirmation: `⚠️ ${message}`,
    };
  }

  const deleteResult = await deleteTask(resolution.taskId, userId);
  if (deleteResult?.error || deleteResult?.success === false) {
    const errorCode = deleteResult?.error?.code || 'NOT_FOUND';
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
      error: deleteResult?.error?.message || defaultMessage,
      rawSummary: defaultMessage,
      confirmation: `⚠️ ${defaultMessage}`,
    };
  }

  const resolvedTask = resolution.task || resolution.item?.raw || resolution.item || null;
  return {
    success: true,
    action: 'deleted_task',
    data: {
      id: resolution.taskId,
      title: resolvedTask?.title || resolvedTask?.summary || null,
      entityName: resolvedTask?.entities?.name || resolvedTask?.entityName || null,
    },
  };
}
