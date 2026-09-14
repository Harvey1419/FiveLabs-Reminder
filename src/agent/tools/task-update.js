import {
  supabase,
  updateTask,
  rescheduleRemindersByTaskId,
  acknowledgeRemindersByTaskId,
} from '../../infrastructure/database/index.js';
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
    entityName: params.entityName || null,
    entityId: params.entityId || null,
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
    const candidates = Array.isArray(resolution.candidates) ? resolution.candidates : [];
    const candidateLines = candidates.map((cand, idx) => `${idx + 1}. *${cand.title || cand.name || 'Tarea'}*`).join('\n');
    const message = language === 'en'
      ? `⚠️ *Multiple tasks match your request*\n\n${candidateLines}\n\nPlease clarify which one you want to update.`
      : `⚠️ *Hay múltiples tareas que coinciden*\n\n${candidateLines}\n\nPor favor aclara cuál deseas actualizar.`;
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
  const title = updatesObj.title !== undefined ? updatesObj.title : params.title;
  const priority = updatesObj.priority !== undefined ? updatesObj.priority : params.priority;
  const status = updatesObj.status !== undefined ? updatesObj.status : params.status;
  const dueDate = updatesObj.dueDate !== undefined ? updatesObj.dueDate : params.dueDate;
  const description = updatesObj.description !== undefined ? updatesObj.description : params.description;
  const updates = {};

  if (title) updates.title = String(title).trim();
  if (description !== undefined) {
    const cleanDesc = description ? String(description).trim() : null;
    const shouldAppend = Boolean(updatesObj.append ?? params.append);
    let existingDesc = resolution.task?.description ? String(resolution.task.description).trim() : null;

    if (cleanDesc && shouldAppend && resolution.taskId) {
      try {
        const { data: freshTask } = await supabase
          .from('tasks')
          .select('id, description')
          .eq('id', resolution.taskId)
          .eq('user_id', userId)
          .maybeSingle();
        if (freshTask?.description) {
          existingDesc = String(freshTask.description).trim();
        }
      } catch {
        // Fallback to in-memory description
      }
    }

    if (cleanDesc && shouldAppend && existingDesc) {
      if (!existingDesc.includes(cleanDesc)) {
        updates.description = `${existingDesc}\n• ${cleanDesc.startsWith('• ') || cleanDesc.startsWith('- ') ? cleanDesc.slice(2) : cleanDesc}`;
      } else {
        updates.description = existingDesc;
      }
    } else {
      updates.description = cleanDesc;
    }
  }
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
  if (updates.due_date) {
    await rescheduleRemindersByTaskId(resolution.taskId, updates.due_date, userId);
  }
  if (updates.status === 'completed') {
    await acknowledgeRemindersByTaskId(resolution.taskId, userId);
  }

  return {
    success: true,
    action: 'updated_task',
    taskId: updatedTask.id,
    title: updatedTask.title,
    data: updatedTask,
  };
}
