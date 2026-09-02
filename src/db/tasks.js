import { supabase } from './index.js';
import { findOrCreateEntityFuzzy, entityMatchScore } from './entities.js';

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
 * @returns {Promise<object|null>}
 */
export async function createTask({
  userId,
  title,
  description = null,
  priority = 'medium',
  dueDate = null,
  entityId = null,
}) {
  if (!userId || !title) return null;

  try {
    const cleanTitle = String(title).trim();

    // Deduplication check: return existing pending task with matching title, entity, and dueDate
    const isoDueDate = dueDate ? new Date(dueDate).toISOString() : null;
    let dedupQ = supabase
      .from('tasks')
      .select('*, entities:entity_id(name, category)')
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
      return existing[0];
    }

    const payload = {
      user_id: userId,
      title: cleanTitle,
      description: description ? String(description).trim() : null,
      priority,
      status: 'pending',
      entity_id: entityId || null,
      due_date: dueDate ? new Date(dueDate).toISOString() : null,
    };

    const { data, error } = await supabase
      .from('tasks')
      .insert(payload)
      .select('*, entities:entity_id(name, category)')
      .single();

    if (error) {
      console.error('[tasks] createTask failed:', error);
      return null;
    }

    return data;
  } catch (err) {
    console.error('[tasks] createTask threw:', err);
    return null;
  }
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
        for (const ent of allEntities) {
          if (
            ent.name.toLowerCase() === entityName.toLowerCase() ||
            entityMatchScore(ent.name, entityName) >= 0.70
          ) {
            matchingEntityIds.add(ent.id);
          }
        }
      }
    }

    let q = supabase
      .from('tasks')
      .select('*, entities:entity_id(name, category)')
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

/**
 * Mark one or more tasks as completed.
 * Supports:
 * 1. By exact taskId
 * 2. By entityName (completes ALL pending tasks of that project/entity across all fuzzy matches)
 * 3. By completeAll (completes all pending tasks)
 * 4. By titleQuery (fuzzy/substring match)
 *
 * @param {object} params
 * @param {string} params.userId
 * @param {string} [params.taskId]
 * @param {string} [params.titleQuery]
 * @param {string} [params.entityName]
 * @param {string} [params.entityId]
 * @param {boolean} [params.completeAll]
 * @returns {Promise<{completedCount: number, tasks: Array<object>}>}
 */
export async function completeTasks({
  userId,
  taskId = null,
  titleQuery = null,
  titles = null,
  items = null,
  entityName = null,
  entityId = null,
  completeAll = false,
}) {
  if (!userId) return { completedCount: 0, tasks: [] };

  try {
    const nowIso = new Date().toISOString();
    const targetTitles = [
      ...(Array.isArray(titles) ? titles : titles ? [titles] : []),
      ...(Array.isArray(items) ? items : items ? [items] : []),
      ...(Array.isArray(titleQuery) ? titleQuery : titleQuery ? [titleQuery] : []),
    ].map(t => String(t).trim()).filter(Boolean);

    // If multiple titles are provided, iterate and complete them all
    if (targetTitles.length > 1) {
      let totalCompleted = 0;
      const allUpdated = [];
      for (const singleTitle of targetTitles) {
        const subRes = await completeTasks({
          userId,
          titleQuery: singleTitle,
          entityName,
          entityId,
        });
        totalCompleted += subRes.completedCount;
        allUpdated.push(...subRes.tasks);
      }
      return { completedCount: totalCompleted, tasks: allUpdated };
    }

    const effectiveTitleQuery = targetTitles.length === 1 ? targetTitles[0] : null;
    const matchingEntityIds = new Set();

    if (entityId) {
      matchingEntityIds.add(entityId);
    }

    // 1. Resolve all entities matching entityName or titleQuery
    const searchEntityTerm = entityName || (!taskId && !completeAll ? effectiveTitleQuery : null);
    if (searchEntityTerm) {
      const { data: allEntities } = await supabase
        .from('entities')
        .select('id, name')
        .eq('user_id', userId);

      if (allEntities && allEntities.length > 0) {
        const cleanTerm = searchEntityTerm.toLowerCase();
        for (const ent of allEntities) {
          const entNameLower = ent.name.toLowerCase();
          if (
            entNameLower === cleanTerm ||
            entNameLower.includes(cleanTerm) ||
            cleanTerm.includes(entNameLower) ||
            entityMatchScore(ent.name, searchEntityTerm) >= 0.65
          ) {
            matchingEntityIds.add(ent.id);
          }
        }
      }
    }

    // 2. Fetch pending tasks for the user
    let q = supabase
      .from('tasks')
      .select('id, title, entity_id')
      .eq('user_id', userId)
      .eq('status', 'pending');

    if (taskId) {
      if (taskId.length === 36) {
        q = q.eq('id', taskId);
      } else {
        const { data: userPending } = await supabase
          .from('tasks')
          .select('id')
          .eq('user_id', userId)
          .eq('status', 'pending');
        const matched = (userPending || []).find(t => t.id.startsWith(taskId.toLowerCase()));
        if (matched) {
          q = q.eq('id', matched.id);
        } else {
          q = q.eq('id', '00000000-0000-0000-0000-000000000000');
        }
      }
    } else if (matchingEntityIds.size > 0) {
      q = q.in('entity_id', Array.from(matchingEntityIds));
    } else if (!completeAll && (effectiveTitleQuery || titleQuery)) {
      q = q.ilike('title', `%${String(effectiveTitleQuery || titleQuery).trim()}%`);
    }

    const { data: candidates, error: selectErr } = await q;

    if (selectErr || !candidates || candidates.length === 0) {
      // Fallback: If no tasks matched entity_id, check if task titles themselves contain the term
      if (searchEntityTerm) {
        const { data: titleMatches } = await supabase
          .from('tasks')
          .select('id, title, entity_id')
          .eq('user_id', userId)
          .eq('status', 'pending')
          .ilike('title', `%${searchEntityTerm}%`);

        if (titleMatches && titleMatches.length > 0) {
          const targetIds = titleMatches.map((t) => t.id);
          const { data: updated } = await supabase
            .from('tasks')
            .update({
              status: 'completed',
              completed_at: nowIso,
              updated_at: nowIso,
            })
            .in('id', targetIds)
            .eq('user_id', userId)
            .select('*, entities:entity_id(name, category)');

          return {
            completedCount: updated?.length || 0,
            tasks: updated || [],
          };
        }
      }

      return { completedCount: 0, tasks: [] };
    }

    const targetIds = candidates.map((t) => t.id);

    // 3. Mark all resolved candidates as completed
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
      return { completedCount: 0, tasks: [] };
    }

    console.log(`[tasks] Completed ${updatedTasks?.length || 0} task(s) for user ${userId}`);
    return {
      completedCount: updatedTasks?.length || 0,
      tasks: updatedTasks || [],
    };
  } catch (err) {
    console.error('[tasks] completeTasks threw:', err);
    return { completedCount: 0, tasks: [] };
  }
}

// Backward compatibility alias for single task
export async function completeTask({ userId, taskId, titleQuery, entityName }) {
  const res = await completeTasks({ userId, taskId, titleQuery, entityName });
  return res.tasks[0] || null;
}

/**
 * Update an existing task.
 */
export async function updateTask(taskId, updates, userId = null) {
  if (!taskId) return null;
  try {
    let resolvedId = taskId;
    if (taskId.length < 36) {
      let q = supabase.from('tasks').select('id');
      if (userId) q = q.eq('user_id', userId);
      const { data: tasks } = await q;
      const matched = (tasks || []).find(t => t.id.startsWith(taskId.toLowerCase()));
      if (matched) resolvedId = matched.id;
      else return null;
    }

    let q = supabase
      .from('tasks')
      .update({
        ...updates,
        updated_at: new Date().toISOString(),
      })
      .eq('id', resolvedId);

    if (userId) {
      q = q.eq('user_id', userId);
    }

    const { data, error } = await q.select().limit(1);

    if (error) {
      console.error('[tasks] updateTask failed:', error);
      return null;
    }

    return data && data.length > 0 ? data[0] : null;
  } catch (err) {
    console.error('[tasks] updateTask threw:', err);
    return null;
  }
}

/**
 * Soft or hard delete a task by ID.
 *
 * @param {string} taskId
 * @param {string} [userId]
 * @returns {Promise<boolean>}
 */
export async function deleteTask(taskId, userId = null) {
  if (!taskId) return false;
  try {
    let resolvedId = taskId;
    if (taskId.length < 36) {
      let q = supabase.from('tasks').select('id');
      if (userId) q = q.eq('user_id', userId);
      const { data: tasks } = await q;
      const matched = (tasks || []).find(t => t.id.startsWith(taskId.toLowerCase()));
      if (matched) resolvedId = matched.id;
      else return false;
    }

    let q = supabase
      .from('tasks')
      .delete()
      .eq('id', resolvedId);

    if (userId) {
      q = q.eq('user_id', userId);
    }

    const { error } = await q;

    if (error) {
      console.error('[tasks] deleteTask failed:', error);
      return false;
    }

    return true;
  } catch (err) {
    console.error('[tasks] deleteTask threw:', err);
    return false;
  }
}

export const completeTasksByQuery = completeTasks;
export const getTasksWithEntities = getTasks;
