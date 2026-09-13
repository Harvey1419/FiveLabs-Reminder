import { supabase } from './index.js';
import { findOrCreateEntityFuzzy, selectEntityCandidate } from './entities.js';

export function normalizeTaskPriority(priority) {
  if (!priority) return 'medium';
  const clean = String(priority).trim().toLowerCase();
  if (clean === 'high' || clean === 'alta' || clean === 'alto') return 'high';
  if (clean === 'urgent' || clean === 'urgente' || clean === 'critica' || clean === 'crítica') return 'urgent';
  if (clean === 'low' || clean === 'baja' || clean === 'bajo') return 'low';
  if (clean === 'medium' || clean === 'media' || clean === 'medio' || clean === 'normal') return 'medium';
  return null;
}

/**
 * Create a new task for a user.
 *
 * @param {object} params
 * @param {string} params.userId
 * @param {string} params.title
 * @param {string} [params.description]
 * @param {'low'|'medium'|'high'|'urgent'} [params.priority='medium']
 * @param {string|Date} [params.dueDate]
 * @param {string} [params.entityId]
 * @returns {Promise<object>}
 */
export async function createTask({
  userId,
  title,
  description = null,
  priority = 'medium',
  dueDate = null,
  entityId = null,
}) {
  if (!userId) {
    return { data: null, error: { code: 'INVALID_PARAMETERS', message: 'Missing userId', source: 'validation' } };
  }
  if (!title || !String(title).trim()) {
    return { data: null, error: { code: 'INVALID_PARAMETERS', message: 'Falta el título de la tarea.', source: 'validation' } };
  }

  const normalizedPriority = normalizeTaskPriority(priority);
  if (!normalizedPriority) {
    return {
      data: null,
      error: {
        code: 'INVALID_PARAMETERS',
        message: `Prioridad inválida '${priority}'. Valores permitidos: 'low', 'medium', 'high', 'urgent'.`,
        source: 'validation',
      },
    };
  }

  try {
    const cleanTitle = String(title).trim();

    // Deduplication check: return existing pending task with matching title, entity, and dueDate
    const isoDueDate = dueDate ? new Date(dueDate).toISOString() : null;
    let dedupQ = supabase
      .from('tasks')
      .select('*, entities:entity_id(id, name, category)')
      .eq('user_id', userId)
      .eq('status', 'pending')
      .ilike('title', cleanTitle);

    if (entityId) {
      dedupQ = dedupQ.eq('entity_id', entityId);
    } else {
      dedupQ = dedupQ.is('entity_id', null);
    }

    if (isoDueDate) {
      dedupQ = dedupQ.eq('due_date', isoDueDate);
    } else {
      dedupQ = dedupQ.is('due_date', null);
    }

    const { data: existing } = await dedupQ.limit(1);

    if (existing && existing.length > 0) {
      console.log(`[tasks] Duplicate pending task prevented for "${cleanTitle}" in same entity/date context, reusing id=${existing[0].id}`);
      return { ...existing[0], data: existing[0], error: null };
    }

    const payload = {
      user_id: userId,
      title: cleanTitle,
      description: description ? String(description).trim() : null,
      priority: normalizedPriority,
      status: 'pending',
      entity_id: entityId || null,
      project_id: entityId || null,
      due_date: dueDate ? new Date(dueDate).toISOString() : null,
    };

    const { data, error } = await supabase
      .from('tasks')
      .insert(payload)
      .select('*, entities:entity_id(id, name, category)')
      .single();

    if (error) {
      console.error('[tasks] createTask failed:', error);
      const isConstraint = error.code === '23514' || error.message?.includes('check constraint');
      return {
        data: null,
        error: {
          code: isConstraint ? 'DATABASE_CONSTRAINT_ERROR' : (error.code || 'DATABASE_ERROR'),
          message: error.message || 'Error de base de datos al crear la tarea',
          details: error.details || error,
          source: 'database',
        },
      };
    }

    return { ...data, data, error: null };
  } catch (err) {
    console.error('[tasks] createTask threw:', err);
    return {
      data: null,
      error: {
        code: 'DATABASE_ERROR',
        message: err.message || 'Excepción al conectar con la base de datos',
        details: err,
        source: 'database',
      },
    };
  }
}

/**
 * Create a coherent task batch with one atomic INSERT statement.
 * Existing pending tasks are reused using the same identity as createTask.
 *
 * @param {object} params
 * @param {string} params.userId
 * @param {Array<object>} params.items
 * @returns {Promise<{data: Array<object>|null, error: object|null}>}
 */
export async function createTasksBatch({ userId, items = [] }) {
  if (!userId) {
    return { data: null, error: { code: 'INVALID_PARAMETERS', message: 'Missing userId', source: 'validation' } };
  }
  if (!Array.isArray(items) || items.length === 0) {
    return { data: null, error: { code: 'INVALID_PARAMETERS', message: 'Falta el título de la tarea.', source: 'validation' } };
  }

  try {
    const prepared = [];
    for (const item of items) {
      const cleanTitle = String(item?.title || '').trim();
      if (!cleanTitle) {
        return { data: null, error: { code: 'INVALID_PARAMETERS', message: 'Falta el título de la tarea.', source: 'validation' } };
      }

      const normalizedPriority = normalizeTaskPriority(item?.priority || 'medium');
      if (!normalizedPriority) {
        return {
          data: null,
          error: {
            code: 'INVALID_PARAMETERS',
            message: `Prioridad inválida '${item?.priority}'. Valores permitidos: 'low', 'medium', 'high', 'urgent'.`,
            source: 'validation',
          },
        };
      }

      const isoDueDate = item?.dueDate ? new Date(item.dueDate).toISOString() : null;
      const entityId = item?.entityId || null;
      const identity = taskPersistenceIdentity(cleanTitle, entityId, isoDueDate);
      prepared.push({
        identity,
        payload: {
          user_id: userId,
          title: cleanTitle,
          description: item?.description ? String(item.description).trim() : null,
          priority: normalizedPriority,
          status: 'pending',
          entity_id: entityId,
          project_id: entityId || null,
          due_date: isoDueDate,
        },
      });
    }

    const uniquePrepared = Array.from(
      new Map(prepared.map((item) => [item.identity, item])).values(),
    );
    const persistedByIdentity = new Map();
    const toInsert = [];

    for (const item of uniquePrepared) {
      const { payload } = item;
      let dedupQ = supabase
        .from('tasks')
        .select('*, entities:entity_id(id, name, category)')
        .eq('user_id', userId)
        .eq('status', 'pending')
        .ilike('title', payload.title);

      dedupQ = payload.entity_id
        ? dedupQ.eq('entity_id', payload.entity_id)
        : dedupQ.is('entity_id', null);
      dedupQ = payload.due_date
        ? dedupQ.eq('due_date', payload.due_date)
        : dedupQ.is('due_date', null);

      const { data: existing, error: lookupError } = await dedupQ.limit(1);
      if (lookupError) {
        return { data: null, error: mapTaskDatabaseError(lookupError, 'consultar las tareas existentes') };
      }
      if (existing?.length) {
        persistedByIdentity.set(item.identity, existing[0]);
      } else {
        toInsert.push(payload);
      }
    }

    if (toInsert.length > 0) {
      const { data: inserted, error } = await supabase
        .from('tasks')
        .insert(toInsert)
        .select('*, entities:entity_id(id, name, category)');

      if (error) {
        console.error('[tasks] createTasksBatch failed:', error);
        return { data: null, error: mapTaskDatabaseError(error, 'crear las tareas') };
      }
      if (!Array.isArray(inserted) || inserted.length !== toInsert.length) {
        return {
          data: null,
          error: {
            code: 'DATABASE_ERROR',
            message: 'La base de datos no confirmó el lote completo de tareas.',
            source: 'database',
          },
        };
      }

      inserted.forEach((task) => {
        const identity = taskPersistenceIdentity(task.title, task.entity_id, task.due_date);
        persistedByIdentity.set(identity, task);
      });
    }

    const data = prepared.map((item) => persistedByIdentity.get(item.identity));
    if (data.some((task) => !task?.id)) {
      return {
        data: null,
        error: {
          code: 'DATABASE_ERROR',
          message: 'La base de datos no confirmó el lote completo de tareas.',
          source: 'database',
        },
      };
    }

    return { data, error: null };
  } catch (err) {
    console.error('[tasks] createTasksBatch threw:', err);
    return {
      data: null,
      error: {
        code: 'DATABASE_ERROR',
        message: err.message || 'Excepción al conectar con la base de datos',
        details: err,
        source: 'database',
      },
    };
  }
}

function taskPersistenceIdentity(title, entityId, dueDate) {
  const isoDueDate = dueDate ? new Date(dueDate).toISOString() : null;
  return JSON.stringify([String(title).trim().toLocaleLowerCase(), entityId || null, isoDueDate]);
}

function mapTaskDatabaseError(error, operation) {
  const isConstraint = error?.code === '23514' || error?.message?.includes('check constraint');
  return {
    code: isConstraint ? 'DATABASE_CONSTRAINT_ERROR' : (error?.code || 'DATABASE_ERROR'),
    message: error?.message || `Error de base de datos al ${operation}`,
    details: error?.details || error,
    source: 'database',
  };
}

/**
 * Fetch tasks for a user, optionally filtered by status or entity.
 *
 * @param {object} params
 * @param {string} params.userId
 * @param {'pending'|'in_progress'|'completed'|'cancelled'|'all'} [params.status='pending']
 * @param {string} [params.entityId]
 * @param {string} [params.entityName]
 * @param {number} [params.limit=50]
 * @returns {Promise<Array<object>>}
 */
export async function getTasks({ userId, status = 'pending', entityId = null, entityName = null, limit = 50 }) {
  if (!userId) return [];
  const safeLimit = Math.min(Math.max(1, Number(limit) || 50), 100);

  try {
    const matchingEntityIds = new Set();
    if (entityId) matchingEntityIds.add(entityId);

    if (entityName && !entityId) {
      const { data: allEntities } = await supabase
        .from('entities')
        .select('id, name')
        .eq('user_id', userId);

      if (allEntities && allEntities.length > 0) {
        const selection = selectEntityCandidate(allEntities, entityName);
        if (selection.status === 'RESOLVED') matchingEntityIds.add(selection.entity.id);
      }

      // A named container that cannot be resolved must never silently broaden
      // into an unfiltered "all tasks" query.
      if (matchingEntityIds.size === 0) {
        return [];
      }
    }

    let q = supabase
      .from('tasks')
      .select('*, entities:entity_id(id, name, category)')
      .eq('user_id', userId)
      .limit(safeLimit);

    if (status && status !== 'all') {
      q = q.eq('status', status);
    }

    if (matchingEntityIds.size === 1) {
      q = q.eq('entity_id', Array.from(matchingEntityIds)[0]);
    } else if (matchingEntityIds.size > 1) {
      q = q.in('entity_id', Array.from(matchingEntityIds));
    }

    // Order by priority and due_date ASC
    q = q.order('due_date', { ascending: true, nullsFirst: false })
         .order('created_at', { ascending: false });

    const { data, error } = await q;
    if (error) {
      console.error('[tasks] getTasks failed:', error);
      return [];
    }

    return data || [];
  } catch (err) {
    console.error('[tasks] getTasks threw:', err);
    return [];
  }
}

import {
  isStrictUUID,
  UUID_REGEX,
  normalizeTextForMatching,
} from '../../shared/entity-resolution.js';

/**
 * Mark one or more tasks as completed.
 * Strictly requires taskId or completeAll / entity scope. Eliminates fuzzy NLP searching.
 *
 * @param {object} params
 * @param {string} params.userId
 * @param {string} [params.taskId]
 * @param {string} [params.entityName]
 * @param {string} [params.entityId]
 * @param {boolean} [params.completeAll]
 * @returns {Promise<{completedCount: number, tasks: Array<object>, error?: object}>}
 */
export async function completeTasks({
  userId,
  taskId = null,
  entityName = null,
  entityId = null,
  completeAll = false,
}) {
  if (!userId) {
    return { completedCount: 0, tasks: [], error: { code: 'INVALID_PARAMETERS', message: 'Missing userId' } };
  }

  if (!taskId && !completeAll && !entityName && !entityId) {
    return { completedCount: 0, tasks: [], error: { code: 'MISSING_TARGET_ID', message: 'Missing task ID to complete' } };
  }

  try {
    const nowIso = new Date().toISOString();
    let q = supabase
      .from('tasks')
      .select('id, title, entity_id, user_id')
      .eq('user_id', userId)
      .eq('status', 'pending');

    if (taskId) {
      if (isStrictUUID(taskId)) {
        q = q.eq('id', taskId);
      } else {
        const { data: userPending } = await supabase
          .from('tasks')
          .select('id, title')
          .eq('user_id', userId)
          .eq('status', 'pending');
        const normTarget = normalizeTextForMatching(taskId);
        const matched = (userPending || []).find(t =>
          t.id.toLowerCase().startsWith(taskId.toLowerCase()) ||
          normalizeTextForMatching(t.title) === normTarget
        );
        if (matched) {
          q = q.eq('id', matched.id);
        } else {
          // Check if taskId is a strict UUID belonging to another user to return ACCESS_DENIED
          if (isStrictUUID(taskId)) {
            const { data: otherUserTask } = await supabase
              .from('tasks')
              .select('id, user_id')
              .eq('id', taskId)
              .maybeSingle();
            if (otherUserTask && otherUserTask.user_id !== userId) {
              return { completedCount: 0, tasks: [], error: { code: 'ACCESS_DENIED', message: 'No tienes permisos sobre esta tarea.' } };
            }
          }
          return { completedCount: 0, tasks: [], error: { code: 'NOT_FOUND', message: 'Task not found or access denied.' } };
        }
      }
    } else if (entityId) {
      q = q.eq('entity_id', entityId);
    } else if (entityName) {
      const { data: allEntities } = await supabase
        .from('entities')
        .select('id, name')
        .eq('user_id', userId);

      const selection = selectEntityCandidate(allEntities || [], entityName);
      if (selection.status === 'RESOLVED') {
        q = q.eq('entity_id', selection.entity.id);
      } else {
        return { completedCount: 0, tasks: [] };
      }
    }

    const { data: candidates, error: selectErr } = await q;

    if (selectErr) {
      console.error('[tasks] completeTasks select failed:', selectErr);
      return { completedCount: 0, tasks: [], error: { code: 'DATABASE_ERROR', message: selectErr.message } };
    }

    if (!candidates || candidates.length === 0) {
      if (taskId && isStrictUUID(taskId)) {
        const { data: exists } = await supabase.from('tasks').select('id, user_id, status').eq('id', taskId).maybeSingle();
        if (exists && exists.user_id !== userId) {
          return { completedCount: 0, tasks: [], error: { code: 'ACCESS_DENIED', message: 'No tienes permisos sobre esta tarea.' } };
        }
      }
      return { completedCount: 0, tasks: [] };
    }

    const targetIds = candidates.map((t) => t.id);

    const { data: updatedTasks, error: updateErr } = await supabase
      .from('tasks')
      .update({
        status: 'completed',
        completed_at: nowIso,
        updated_at: nowIso,
      })
      .in('id', targetIds)
      .eq('user_id', userId)
      .select('*');

    if (updateErr) {
      console.error('[tasks] completeTasks update failed:', updateErr);
      return { completedCount: 0, tasks: [], error: { code: 'DATABASE_ERROR', message: updateErr.message } };
    }

    try {
      await supabase
        .from('reminders')
        .update({ acknowledged_at: nowIso, status: 'sent' })
        .in('task_id', targetIds)
        .is('acknowledged_at', null);
    } catch (remErr) {
      console.warn('[tasks] completeTasks reminder cascade warning:', remErr.message);
    }

    console.log(`[tasks] Completed ${updatedTasks?.length || 0} task(s) for user ${userId}`);
    return {
      completedCount: updatedTasks?.length || 0,
      tasks: updatedTasks || [],
      error: null,
    };
  } catch (err) {
    console.error('[tasks] completeTasks threw:', err);
    return { completedCount: 0, tasks: [], error: { code: 'DATABASE_ERROR', message: err.message } };
  }
}

// Backward compatibility alias for single task
export async function completeTask({ userId, taskId, entityName, entityId }) {
  const res = await completeTasks({ userId, taskId, entityName, entityId });
  return res.tasks[0] || null;
}

/**
 * Update an existing task.
 */
export async function updateTask(taskId, updates = {}, userId = null) {
  if (!taskId) {
    return { data: null, error: { code: 'MISSING_TARGET_ID', message: 'Missing task ID to update.', source: 'validation' } };
  }

  try {
    let resolvedId = taskId;
    if (!isStrictUUID(taskId)) {
      let q = supabase.from('tasks').select('id, title');
      if (userId) q = q.eq('user_id', userId);
      const { data: tasks, error: selectErr } = await q;
      if (selectErr) {
        return { data: null, error: { code: 'DATABASE_ERROR', message: selectErr.message, source: 'database' } };
      }
      const normTarget = normalizeTextForMatching(taskId);
      const matched = (tasks || []).find(t =>
        t.id.toLowerCase().startsWith(taskId.toLowerCase()) ||
        normalizeTextForMatching(t.title) === normTarget
      );
      if (matched) resolvedId = matched.id;
      else {
        return { data: null, error: { code: 'NOT_FOUND', message: 'Task not found.', source: 'domain' } };
      }
    }

    const payload = {
      ...updates,
      updated_at: new Date().toISOString(),
    };

    if (payload.status === 'completed' && !payload.completed_at) {
      payload.completed_at = new Date().toISOString();
    }

    if (payload.priority) {
      const norm = normalizeTaskPriority(payload.priority);
      if (!norm) {
        return {
          data: null,
          error: {
            code: 'INVALID_PARAMETERS',
            message: `Prioridad inválida '${payload.priority}'. Valores permitidos: 'low', 'medium', 'high', 'urgent'.`,
            source: 'validation',
          },
        };
      }
      payload.priority = norm;
    }

    let q = supabase
      .from('tasks')
      .update(payload)
      .eq('id', resolvedId);

    if (userId) {
      q = q.eq('user_id', userId);
    }

    const { data, error } = await q.select('*, entities:entity_id(name, category)').limit(1);

    if (error) {
      console.error('[tasks] updateTask failed:', error);
      const isConstraint = error.code === '23514' || error.message?.includes('check constraint');
      return {
        data: null,
        error: {
          code: isConstraint ? 'DATABASE_CONSTRAINT_ERROR' : (error.code || 'DATABASE_ERROR'),
          message: error.message || 'Error al actualizar tarea en base de datos',
          source: 'database',
        },
      };
    }

    if (!data || data.length === 0) {
      if (userId && isStrictUUID(resolvedId)) {
        const { data: exists } = await supabase.from('tasks').select('id, user_id').eq('id', resolvedId).maybeSingle();
        if (exists && exists.user_id !== userId) {
          return { data: null, error: { code: 'ACCESS_DENIED', message: 'No tienes permisos sobre esta tarea.', source: 'domain' } };
        }
      }
      return { data: null, error: { code: 'NOT_FOUND', message: 'Task not found.', source: 'domain' } };
    }

    if (payload.status === 'completed') {
      try {
        await supabase
          .from('reminders')
          .update({ acknowledged_at: new Date().toISOString(), status: 'sent' })
          .eq('task_id', resolvedId)
          .is('acknowledged_at', null);
      } catch (remErr) {
        console.warn('[tasks] updateTask complete reminder cascade warning:', remErr.message);
      }
    } else if (payload.due_date) {
      try {
        await supabase
          .from('reminders')
          .update({ send_at: new Date(payload.due_date).toISOString() })
          .eq('task_id', resolvedId)
          .eq('status', 'pending');
      } catch (remErr) {
        console.warn('[tasks] updateTask due_date reminder cascade warning:', remErr.message);
      }
    }

    return { ...data[0], data: data[0], error: null };
  } catch (err) {
    console.error('[tasks] updateTask threw:', err);
    return { data: null, error: { code: 'DATABASE_ERROR', message: err.message, source: 'database' } };
  }
}

/**
 * Soft or hard delete a task by ID.
 *
 * @param {string} taskId
 * @param {string} [userId]
 * @returns {Promise<{success: boolean, error?: object}>}
 */
export async function deleteTask(taskId, userId = null) {
  if (!taskId) {
    return { success: false, error: { code: 'MISSING_TARGET_ID', message: 'Missing task ID to delete.', source: 'validation' } };
  }

  try {
    let resolvedId = taskId;
    if (!isStrictUUID(taskId)) {
      let q = supabase.from('tasks').select('id, title');
      if (userId) q = q.eq('user_id', userId);
      const { data: tasks, error: selectErr } = await q;
      if (selectErr) {
        return { success: false, error: { code: 'DATABASE_ERROR', message: selectErr.message, source: 'database' } };
      }
      const normTarget = normalizeTextForMatching(taskId);
      const matched = (tasks || []).find(t =>
        t.id.toLowerCase().startsWith(taskId.toLowerCase()) ||
        normalizeTextForMatching(t.title) === normTarget
      );
      if (matched) resolvedId = matched.id;
      else {
        return { success: false, error: { code: 'NOT_FOUND', message: 'Task not found.', source: 'domain' } };
      }
    }

    let q = supabase
      .from('tasks')
      .delete()
      .eq('id', resolvedId);

    if (userId) {
      q = q.eq('user_id', userId);
    }

    const { data, error } = await q.select();

    if (error) {
      console.error('[tasks] deleteTask failed:', error);
      return { success: false, error: { code: 'DATABASE_ERROR', message: error.message, source: 'database' } };
    }

    if (!data || data.length === 0) {
      if (userId && isStrictUUID(resolvedId)) {
        const { data: exists } = await supabase.from('tasks').select('id, user_id').eq('id', resolvedId).maybeSingle();
        if (exists && exists.user_id !== userId) {
          return { success: false, error: { code: 'ACCESS_DENIED', message: 'No tienes permisos sobre esta tarea.', source: 'domain' } };
        }
      }
      return { success: false, error: { code: 'NOT_FOUND', message: 'Task not found.', source: 'domain' } };
    }

    try {
      await supabase
        .from('reminders')
        .update({ status: 'cancelled' })
        .eq('task_id', resolvedId)
        .eq('status', 'pending');
    } catch (remErr) {
      console.warn('[tasks] deleteTask reminder cascade warning:', remErr.message);
    }

    return { success: true, error: null };
  } catch (err) {
    console.error('[tasks] deleteTask threw:', err);
    return { success: false, error: { code: 'DATABASE_ERROR', message: err.message, source: 'database' } };
  }
}

export const completeTasksByQuery = completeTasks;
export const getTasksWithEntities = getTasks;
