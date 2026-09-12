import { supabase } from './index.js';
import {
  normalizeEntityName,
  entityMatchScore,
  mergeMetadata,
} from './entities.js';

export const normalizeProjectName = normalizeEntityName;
export const projectMatchScore = entityMatchScore;

/**
 * Select one user-visible project candidate without depending on database row order.
 */
export function selectProjectCandidate(projects, name, {
  threshold = 0.75,
  ambiguityMargin = 0.05,
} = {}) {
  const cleanName = String(name || '').trim();
  if (!cleanName) return { status: 'NOT_FOUND', candidates: [] };

  const candidates = Array.isArray(projects) ? projects : [];
  if (candidates.length === 0) return { status: 'NOT_FOUND', candidates: [] };

  const targetNorm = normalizeProjectName(cleanName);
  const exact = candidates.filter((p) => normalizeProjectName(p.name) === targetNorm);
  if (exact.length === 1) return { status: 'RESOLVED', project: exact[0], score: 1 };
  if (exact.length > 1) return { status: 'AMBIGUOUS', candidates: exact, score: 1 };

  const scored = candidates
    .map((project) => ({ project, score: projectMatchScore(cleanName, project.name) }))
    .filter((candidate) => candidate.score >= threshold)
    .sort((left, right) => right.score - left.score);

  if (scored.length === 0) return { status: 'NOT_FOUND', candidates: [] };

  const top = scored[0];
  const runnerUp = scored[1];
  if (runnerUp && top.score - runnerUp.score < ambiguityMargin) {
    return { status: 'AMBIGUOUS', candidates: scored.map((c) => c.project), score: top.score };
  }
  return { status: 'RESOLVED', project: top.project, score: top.score };
}

/**
 * Select projects for single or bulk deletion.
 */
export function selectProjectsForDeletion(projects, {
  targetName = null,
  targetNames = null,
  scope = 'single',
  preserveNames = [],
} = {}) {
  const candidates = (Array.isArray(projects) ? projects : []).filter((p) => p?.id);
  const preserved = new Set((preserveNames || []).map(normalizeProjectName).filter(Boolean));

  if (scope === 'all') {
    return {
      status: 'RESOLVED',
      projects: candidates.filter((p) => !preserved.has(normalizeProjectName(p.name))),
    };
  }

  const namesToMatch = Array.isArray(targetNames) && targetNames.length > 0
    ? targetNames
    : (targetName ? [targetName] : []);

  if (namesToMatch.length === 0) {
    return { status: 'NOT_FOUND', projects: [], candidates: [] };
  }

  const resolvedProjects = [];
  const ambiguousCandidates = [];

  for (const name of namesToMatch) {
    const selected = selectProjectCandidate(candidates, name);
    if (selected.status === 'AMBIGUOUS') {
      ambiguousCandidates.push(...(selected.candidates || []));
    } else if (selected.status === 'RESOLVED') {
      if (!preserved.has(normalizeProjectName(selected.project.name))) {
        if (!resolvedProjects.some((p) => p.id === selected.project.id)) {
          resolvedProjects.push(selected.project);
        }
      }
    }
  }

  if (ambiguousCandidates.length > 0 && resolvedProjects.length === 0) {
    return { status: 'AMBIGUOUS', candidates: ambiguousCandidates, projects: [] };
  }

  if (resolvedProjects.length === 0) {
    return { status: 'NOT_FOUND', projects: [], candidates: [] };
  }

  return { status: 'RESOLVED', projects: resolvedProjects };
}

/**
 * Find or lazily create a project using fuzzy matching.
 */
export async function findOrCreateProjectFuzzy({
  userId,
  name,
  description = null,
  metadata = {},
  threshold = 0.75,
}) {
  if (!userId || !name) return null;
  const cleanName = String(name).trim();

  try {
    const { data: existingList, error: fetchErr } = await supabase
      .from('projects')
      .select('*')
      .eq('user_id', userId);

    if (!fetchErr && existingList && existingList.length > 0) {
      const selected = selectProjectCandidate(existingList, cleanName, { threshold });
      if (selected.status === 'RESOLVED') {
        const bestMatch = selected.project;
        const merged = mergeMetadata(bestMatch.metadata, metadata);
        if (metadata && Object.keys(metadata).length > 0) {
          const { data: updated } = await supabase
            .from('projects')
            .update({ metadata: merged, updated_at: new Date().toISOString() })
            .eq('id', bestMatch.id)
            .select('*')
            .single();
          return updated || bestMatch;
        }
        return bestMatch;
      }
    }

    const { data: created, error: createErr } = await supabase
      .from('projects')
      .insert({
        user_id: userId,
        name: cleanName,
        description,
        metadata: metadata || {},
        status: 'active',
      })
      .select('*')
      .single();

    if (createErr) {
      // Fallback in case of race condition conflict
      const { data: conflictMatch } = await supabase
        .from('projects')
        .select('*')
        .eq('user_id', userId)
        .ilike('name', cleanName)
        .limit(1);
      if (conflictMatch && conflictMatch[0]) return conflictMatch[0];
      console.error('[projects] create error:', createErr);
      return null;
    }

    // Sync to entities table for backward compatibility
    try {
      await supabase.from('entities').upsert({
        id: created.id,
        user_id: userId,
        name: created.name,
        category: 'project',
        metadata: created.metadata || {},
      }, { onConflict: 'user_id, name, category' });
    } catch {
      // Ignore non-fatal sync error
    }

    return created;
  } catch (err) {
    console.error('[projects] findOrCreateProjectFuzzy threw:', err);
    return null;
  }
}

/**
 * List active projects for a user.
 */
export async function findProjects({
  userId,
  query = null,
  status = 'active',
  limit = 50,
} = {}) {
  if (!userId) return [];

  try {
    let q = supabase
      .from('projects')
      .select('*')
      .eq('user_id', userId)
      .order('updated_at', { ascending: false })
      .limit(limit);

    if (status && status !== 'all') {
      q = q.eq('status', status);
    }
    if (query) {
      q = q.ilike('name', `%${query.trim()}%`);
    }

    const { data, error } = await q;
    if (error) {
      console.error('[projects] findProjects error:', error);
      return [];
    }
    return data || [];
  } catch (err) {
    console.error('[projects] findProjects threw:', err);
    return [];
  }
}

export const getProjectsByUser = findProjects;

/**
 * Get project by ID.
 */
export async function getProjectById(id, userId) {
  if (!id || !userId) return null;
  try {
    const { data, error } = await supabase
      .from('projects')
      .select('*')
      .eq('id', id)
      .eq('user_id', userId)
      .single();
    if (error) return null;
    return data;
  } catch {
    return null;
  }
}

/**
 * Rename a project and cascade across tasks.
 */
export async function renameProject({ userId, oldName, newName }) {
  if (!userId || !oldName || !newName) {
    return { success: false, error: 'Faltan parámetros para renombrar el proyecto.' };
  }

  const cleanOld = String(oldName).trim();
  const cleanNew = String(newName).trim();

  try {
    const { data: existing, error: findErr } = await supabase
      .from('projects')
      .select('*')
      .eq('user_id', userId);

    if (findErr || !existing?.length) {
      return { success: false, error: `No se encontró el proyecto '${cleanOld}'.` };
    }

    const match = selectProjectCandidate(existing, cleanOld);
    if (match.status !== 'RESOLVED') {
      return { success: false, error: `No se encontró un proyecto unívoco para '${cleanOld}'.` };
    }

    const project = match.project;
    const { data: updated, error: updateErr } = await supabase
      .from('projects')
      .update({ name: cleanNew, updated_at: new Date().toISOString() })
      .eq('id', project.id)
      .select('*')
      .single();

    if (updateErr) {
      return { success: false, error: updateErr.message };
    }

    // Sync rename to entities table for backward compatibility
    try {
      await supabase.from('entities')
        .update({ name: cleanNew, updated_at: new Date().toISOString() })
        .eq('id', project.id);
    } catch {}

    return { success: true, project: updated };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

/**
 * Delete projects and cascade to associated unfinished tasks and reminders.
 */
export async function deleteProjects({
  userId,
  targetName = null,
  targetNames = null,
  scope = 'single',
  preserveNames = [],
  dryRun = false,
  projectIds = null,
}) {
  const hasExactIds = Array.isArray(projectIds) && projectIds.length > 0;
  const hasNames = (Array.isArray(targetNames) && targetNames.length > 0) || Boolean(targetName);
  if (!userId || (!hasExactIds && scope !== 'all' && !hasNames)) {
    return { success: false, errorCode: 'INVALID_PARAMETERS', error: 'Missing deletion target.', deletedCount: 0 };
  }

  try {
    let query = supabase.from('projects').select('*').eq('user_id', userId);
    if (hasExactIds) {
      query = query.in('id', projectIds);
    }
    const { data: projects, error: fetchError } = await query;
    if (fetchError) return { success: false, errorCode: 'DATABASE_ERROR', error: fetchError.message, deletedCount: 0 };

    const selection = hasExactIds
      ? { status: 'RESOLVED', projects: projects || [], candidates: [] }
      : selectProjectsForDeletion(projects, { targetName, targetNames, scope, preserveNames });

    if (selection.status === 'AMBIGUOUS') {
      return { success: false, errorCode: 'AMBIGUOUS_TARGET', error: 'Multiple projects match.', candidates: selection.candidates, deletedCount: 0 };
    }
    if (selection.projects.length === 0) {
      return { success: false, errorCode: 'NOT_FOUND', error: 'No matching projects found.', deletedCount: 0 };
    }

    const ids = selection.projects.map((p) => p.id);

    // Linked tasks can be connected via project_id OR entity_id
    const { data: linkedTasks, error: linkedTasksError } = await supabase
      .from('tasks')
      .select('id, status')
      .eq('user_id', userId)
      .or(`project_id.in.(${ids.join(',')}),entity_id.in.(${ids.join(',')})`);

    if (linkedTasksError) {
      return { success: false, errorCode: 'DATABASE_ERROR', error: linkedTasksError.message, deletedCount: 0 };
    }

    const safeTasks = linkedTasks || [];
    const unfinishedTaskIds = safeTasks
      .filter((t) => t.status === 'pending' || t.status === 'in_progress')
      .map((t) => t.id);
    const preservedCompletedTaskCount = safeTasks.filter((t) => t.status === 'completed').length;

    let activeReminderIds = [];
    if (unfinishedTaskIds.length > 0) {
      const { data: activeReminders, error: activeRemindersError } = await supabase
        .from('reminders')
        .select('id')
        .eq('user_id', userId)
        .in('task_id', unfinishedTaskIds)
        .in('status', ['pending', 'processing']);
      if (activeRemindersError) {
        return { success: false, errorCode: 'DATABASE_ERROR', error: activeRemindersError.message, deletedCount: 0 };
      }
      activeReminderIds = (activeReminders || []).map((r) => r.id).filter(Boolean);
    }

    if (dryRun) {
      return {
        success: true,
        dryRun: true,
        projects: selection.projects,
        entities: selection.projects, // backward compatibility
        deletedCount: 0,
        pendingTaskCount: unfinishedTaskIds.length,
        activeReminderCount: activeReminderIds.length,
        preservedCompletedTaskCount,
      };
    }

    // Real deletion:
    // 1. Cancel active reminders
    if (activeReminderIds.length > 0) {
      await supabase
        .from('reminders')
        .update({ status: 'cancelled', updated_at: new Date().toISOString() })
        .eq('user_id', userId)
        .in('id', activeReminderIds);
    }

    // 2. Delete unfinished tasks
    if (unfinishedTaskIds.length > 0) {
      await supabase
        .from('tasks')
        .delete()
        .eq('user_id', userId)
        .in('id', unfinishedTaskIds);
    }

    // 3. Delete from projects table
    const { data: deleted, error: deleteError } = await supabase
      .from('projects')
      .delete()
      .eq('user_id', userId)
      .in('id', ids)
      .select('id, name');

    if (deleteError) {
      return { success: false, errorCode: 'DATABASE_ERROR', error: deleteError.message, deletedCount: 0 };
    }

    // 4. Sync delete from entities table for backward compatibility
    try {
      await supabase
        .from('entities')
        .delete()
        .eq('user_id', userId)
        .in('id', ids);
    } catch {}

    const deletedProjects = deleted || [];
    return {
      success: true,
      dryRun: false,
      projects: deletedProjects,
      entities: deletedProjects, // backward compatibility
      deletedCount: deletedProjects.length,
      deletedTaskCount: unfinishedTaskIds.length,
      cancelledReminderCount: activeReminderIds.length,
      preservedCompletedTaskCount,
    };
  } catch (err) {
    return { success: false, errorCode: 'DATABASE_ERROR', error: err.message, deletedCount: 0 };
  }
}
