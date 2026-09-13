import {
  deleteTask,
  cancelRemindersByTaskId,
} from '../../infrastructure/database/index.js';
import { resolveTaskTarget } from './task-reference.js';

export async function executeTaskDelete({
  params = {},
  user = null,
  language = 'es',
} = {}) {
  const userId = user?.id;
  const phoneNumber = user?.phone_number;
  const targetQuery = params.target || null;

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
    entityName: params.entityName || null,
    entityId: params.entityId || null,
    userId,
    userOrPhone: user || phoneNumber,
    operation: 'delete',
    allowedStatuses: ['pending', 'completed'],
  });

  if (resolution.status === 'AMBIGUOUS') {
    const candidates = Array.isArray(resolution.candidates) ? resolution.candidates : [];
    const candidateLines = candidates.map((cand, idx) => `${idx + 1}. *${cand.title || cand.name || 'Tarea'}*`).join('\n');
    const message = language === 'en'
      ? `⚠️ *Multiple tasks match your request*\n\n${candidateLines}\n\nPlease clarify which one you want to delete.`
      : `⚠️ *Hay múltiples tareas que coinciden*\n\n${candidateLines}\n\nPor favor aclara cuál deseas eliminar.`;
    return {
      success: false,
      action: 'ambiguous_target',
      errorCode: 'AMBIGUOUS_TARGET',
      error: message,
      rawSummary: message,
      formattedCard: message,
      confirmation: message,
      requiresClarification: true,
      data: {
        tasks: candidates.map((cand, idx) => ({
          position: idx + 1,
          type: 'task',
          internalId: cand.id,
          id: cand.id,
          title: cand.title,
          summary: cand.title,
        })),
      },
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
  await cancelRemindersByTaskId(resolution.taskId, userId);

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
