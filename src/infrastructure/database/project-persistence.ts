import type { JsonObject } from '@templelabs/contracts';
import { normalizeEntityName,entityMatchScore,mergeMetadata } from './entity-resolution.js';
import { domainErrorMessage,type DomainPersistenceClient,type TaskContainerRow,type TaskRow,type ReminderPersistenceRow } from './domain-persistence-client.js';
export type ProjectSelection<T> = { status: 'RESOLVED'; project: T; score: number }
  | { status: 'AMBIGUOUS' | 'NOT_FOUND'; candidates: T[]; score?: number };
export interface ProjectDeletionOptions { targetName?: string | null; targetNames?: readonly string[] | null;
  scope?: string; preserveNames?: readonly string[] }
export type ProjectDeletionSelection<T> = { status: 'RESOLVED'; projects: T[] }
  | { status: 'AMBIGUOUS' | 'NOT_FOUND'; projects: T[]; candidates: T[] };
export interface CreateProjectInput { userId: string; name: string; description?: string | null; metadata?: JsonObject | null; threshold?: number }
export interface ProjectReadInput { userId?: string; query?: string | null; status?: string; limit?: number }
export interface ProjectDeleteInput extends ProjectDeletionOptions { userId: string; dryRun?: boolean; projectIds?: readonly string[] | null }
interface ProjectDeletionReceipts { projects: TaskContainerRow[]; entities: TaskContainerRow[]; tasks: TaskRow[]; reminders: ReminderPersistenceRow[] }
/** Per-owner project persistence. Sequential cascades expose their observed partial receipts. */
export function createProjectPersistence(getClient: () => DomainPersistenceClient) {
  const normalizeProjectName = normalizeEntityName;
  const projectMatchScore = entityMatchScore;

  /**
   * Select one user-visible project candidate without depending on database row order.
   */
  function selectProjectCandidate<T extends TaskContainerRow>(projects: readonly T[], name: string, {
    threshold = 0.75,
    ambiguityMargin = 0.05,
  }: { threshold?: number; ambiguityMargin?: number } = {}): ProjectSelection<T> {
    const cleanName = String(name || '').trim();
    if (!cleanName) return { status: 'NOT_FOUND', candidates: [] };

    const candidates = Array.isArray(projects) ? projects : [];
    if (candidates.length === 0) return { status: 'NOT_FOUND', candidates: [] };

    const targetNorm = normalizeProjectName(cleanName);
    const exact = candidates.filter((p) => normalizeProjectName(p.name) === targetNorm);
    if (exact.length === 1) return { status: 'RESOLVED', project: exact[0]!, score: 1 };
    if (exact.length > 1) return { status: 'AMBIGUOUS', candidates: exact, score: 1 };

    const scored = candidates
      .map((project) => ({ project, score: projectMatchScore(cleanName, project.name) }))
      .filter((candidate) => candidate.score >= threshold)
      .sort((left, right) => right.score - left.score);

    if (scored.length === 0) return { status: 'NOT_FOUND', candidates: [] };

    const top = scored[0]!;
    const runnerUp = scored[1];
    if (runnerUp && top.score - runnerUp.score < ambiguityMargin) {
      return { status: 'AMBIGUOUS', candidates: scored.map((c) => c.project), score: top.score };
    }
    return { status: 'RESOLVED', project: top.project, score: top.score };
  }

  /**
   * Select projects for single or bulk deletion.
   */
  function selectProjectsForDeletion<T extends TaskContainerRow>(projects: readonly T[], {
    targetName = null,
    targetNames = null,
    scope = 'single',
    preserveNames = [],
  }: ProjectDeletionOptions = {}): ProjectDeletionSelection<T> {
    const candidates = (Array.isArray(projects) ? projects : []).filter((p) => p?.id);
    const preserved = new Set((preserveNames || []).map(normalizeProjectName).filter(Boolean));

    if (scope === 'all') {
      return {
        status: 'RESOLVED',
        projects: candidates.filter((p) => !preserved.has(normalizeProjectName(p.name))),
      };
    }

    if (scope === 'no_tasks' || scope === 'empty') {
      const emptyProjects = candidates.filter((p) => (p.taskCount === 0 || !p.taskCount) && !preserved.has(normalizeProjectName(p.name)));
      if (emptyProjects.length === 0) {
        return { status: 'NOT_FOUND', projects: [], candidates: [] };
      }
      return {
        status: 'RESOLVED',
        projects: emptyProjects,
      };
    }

    const namesToMatch = Array.isArray(targetNames) && targetNames.length > 0
      ? targetNames
      : (targetName ? [targetName] : []);

    if (namesToMatch.length === 0) {
      return { status: 'NOT_FOUND', projects: [], candidates: [] };
    }

    const resolvedProjects: T[] = [];
    const ambiguousCandidates: T[] = [];

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
  async function findOrCreateProjectFuzzy({
    userId,
    name,
    description = null,
    metadata = {},
    threshold = 0.75,
  }: CreateProjectInput) {
    if (!userId || !name) return null;
    const cleanName = String(name).trim();

    try {
      const { data: existingList, error: fetchErr } = await getClient()
        .from('projects')
        .select('*')
        .eq('user_id', userId);

      if (!fetchErr && existingList && existingList.length > 0) {
        const selected = selectProjectCandidate(existingList, cleanName, { threshold });
        if (selected.status === 'RESOLVED') {
          const bestMatch = selected.project;
          let projectRecord = bestMatch;
          if (metadata && Object.keys(metadata).length > 0) {
            const merged = mergeMetadata(bestMatch.metadata,metadata);
            const { data: updated } = await getClient()
              .from('projects')
              .update({ metadata: merged, updated_at: new Date().toISOString() })
              .eq('id', bestMatch.id)
              .eq('user_id', userId)
              .select('*')
              .single();
            projectRecord = updated || bestMatch;
          }

          // Sync to entities table for backward compatibility
          try {
            await getClient().from('entities').upsert({
              id: projectRecord.id,
              user_id: userId,
              name: projectRecord.name,
              category: 'project',
              metadata: projectRecord.metadata || {},
            }, { onConflict: 'user_id, name, category' });
          } catch {
            // Ignore
          }

          return projectRecord;
        }
      }

      // Check if an existing entity with category 'project' already has this name
      // so we can preserve its UUID when creating the project record!
      let preferredId = null;
      try {
        const { data: existingEntity } = await getClient()
          .from('entities')
          .select('id')
          .eq('user_id', userId)
          .eq('category', 'project')
          .ilike('name', cleanName)
          .limit(1);
        if (existingEntity && existingEntity[0]?.id) {
          preferredId = existingEntity[0].id;
        }
      } catch {
        // Non-fatal fallback
      }

      const { data: created, error: createErr } = await getClient()
        .from('projects')
        .insert({
          ...(preferredId ? { id: preferredId } : {}),
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
        const { data: conflictMatch } = await getClient()
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
        await getClient().from('entities').upsert({
          id: created!.id,
          user_id: userId,
          name: created!.name,
          category: 'project',
          metadata: created!.metadata || {},
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
  async function findProjects({
    userId,
    query = null,
    status = 'active',
    limit = 50,
  }: ProjectReadInput = {}) {
    if (!userId) return [];

    try {
      let q = getClient()
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

      const projectItems = (data || []).slice();

      try {
        let eq = getClient()
          .from('entities')
          .select('*')
          .eq('user_id', userId)
          .eq('category', 'project')
          .limit(limit);
        if (query) {
          eq = eq.ilike('name', `%${query.trim()}%`);
        }
        const { data: legacyEntities } = await eq;
        if (legacyEntities && legacyEntities.length > 0) {
          const knownIds = new Set(projectItems.map((p) => p.id));
          const knownNames = new Set(projectItems.map((p) => p.name.toLowerCase().trim()));
          for (const leg of legacyEntities) {
            if (!knownIds.has(leg.id) && !knownNames.has(leg.name.toLowerCase().trim())) {
              projectItems.push({
                id: leg.id,
                user_id: leg.user_id,
                name: leg.name,
                description: leg.description || null,
                status: 'active',
                metadata: leg.metadata || {},
                created_at: leg.created_at,
                updated_at: leg.updated_at,
              });
            }
          }
        }
      } catch {
        // Non-fatal fallback
      }

      try {
        const { data: pendingTasks } = await getClient()
          .from('tasks')
          .select('project_id, entity_id')
          .eq('user_id', userId)
          .eq('status', 'pending');

        const countsById = new Map<string,number>();
        if (pendingTasks && Array.isArray(pendingTasks)) {
          for (const t of pendingTasks) {
            const containerId = t.project_id || t.entity_id;
            if (containerId) {
              countsById.set(containerId, (countsById.get(containerId) || 0) + 1);
            }
          }
        }
        for (const p of projectItems) {
          p.taskCount = countsById.get(p.id) || 0;
        }
      } catch {
        for (const p of projectItems) {
          if (p.taskCount === undefined) p.taskCount = 0;
        }
      }

      return projectItems;
    } catch (err) {
      console.error('[projects] findProjects threw:', err);
      return [];
    }
  }

  const getProjectsByUser = findProjects;

  /**
   * Get project by ID.
   */
  async function getProjectById(id: string,userId: string) {
    if (!id || !userId) return null;
    try {
      const { data, error } = await getClient()
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
  async function renameProject({ userId, oldName, newName }: { userId: string; oldName: string; newName: string }) {
    if (!userId || !oldName || !newName) {
      return { success: false, error: 'Faltan parámetros para renombrar el proyecto.' };
    }

    const cleanOld = String(oldName).trim();
    const cleanNew = String(newName).trim();

    try {
      const { data: existing, error: findErr } = await getClient()
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
      const { data: updated, error: updateErr } = await getClient()
        .from('projects')
        .update({ name: cleanNew, updated_at: new Date().toISOString() })
        .eq('id', project.id)
        .eq('user_id', userId)
        .select('*')
        .single();

      if (updateErr) {
        return { success: false, error: updateErr.message };
      }

      // Sync rename to entities table for backward compatibility
      try {
        await getClient().from('entities')
          .update({ name: cleanNew, updated_at: new Date().toISOString() })
          .eq('id', project.id).eq('user_id', userId);
      } catch {}

      return { success: true, project: updated };
    } catch (err) {
      return { success: false, error: domainErrorMessage(err) };
    }
  }

  /**
   * Delete projects and cascade to associated unfinished tasks and reminders.
   */
  async function deleteProjects({
    userId,
    targetName = null,
    targetNames = null,
    scope = 'single',
    preserveNames = [],
    dryRun = false,
    projectIds = null,
  }: ProjectDeleteInput) {
    const hasExactIds = Array.isArray(projectIds) && projectIds.length > 0;
    const hasNames = (Array.isArray(targetNames) && targetNames.length > 0) || Boolean(targetName);
    const isSpecialScope = scope === 'all' || scope === 'no_tasks' || scope === 'empty';
    if (!userId || (!hasExactIds && !isSpecialScope && !hasNames)) {
      return { success: false, errorCode: 'INVALID_PARAMETERS', error: 'Missing deletion target.', deletedCount: 0 };
    }

    const receipts: ProjectDeletionReceipts = { projects: [], tasks: [], reminders: [], entities: [] };
    let mutationStarted = false;
    const failure = (errorCode: string,error: string | undefined,outcome = 'failure') => ({
      success: false, complete: false, errorCode, error, outcome,
      partialSuccess: Object.values(receipts).some(rows => rows.length > 0), receipts,
      projects: receipts.projects, entities: receipts.projects,
      deletedCount: receipts.projects.length, deletedTaskCount: receipts.tasks.length,
      cancelledReminderCount: receipts.reminders.length,
    });
    try {
      let projects: TaskContainerRow[] = [];
      if (hasExactIds) {
        const { data, error: fetchError } = await getClient().from('projects').select('*').eq('user_id', userId).in('id', projectIds!);
        if (fetchError) return { success: false, errorCode: 'DATABASE_ERROR', error: fetchError.message, deletedCount: 0 };
        projects = data || [];
      } else if (isSpecialScope) {
        projects = await findProjects({ userId, status: 'active' });
      } else {
        const { data, error: fetchError } = await getClient().from('projects').select('*').eq('user_id', userId);
        if (fetchError) return { success: false, errorCode: 'DATABASE_ERROR', error: fetchError.message, deletedCount: 0 };
        projects = data || [];
      }

      const selection = hasExactIds
        ? { status: 'RESOLVED' as const, projects: projects || [], candidates: [] }
        : selectProjectsForDeletion(projects, { targetName, targetNames, scope, preserveNames });

      if (selection.status === 'AMBIGUOUS') {
        return { success: false, errorCode: 'AMBIGUOUS_TARGET', error: 'Multiple projects match.', candidates: selection.candidates, deletedCount: 0 };
      }
      if (selection.projects.length === 0) {
        return { success: false, errorCode: 'NOT_FOUND', error: 'No matching projects found.', deletedCount: 0 };
      }

      const ids = selection.projects.map((p) => p.id);

      // Linked tasks can be connected via project_id OR entity_id
      const { data: linkedTasks, error: linkedTasksError } = await getClient()
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

      let activeReminderIds: string[] = [];
      if (unfinishedTaskIds.length > 0) {
        const { data: activeReminders, error: activeRemindersError } = await getClient()
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

      // Each dependent write requires an observed receipt before proceeding.
      // This is deliberately not presented as atomic: failures expose partial progress.
      if (activeReminderIds.length > 0) {
        mutationStarted = true;
        const { data, error } = await getClient().from('reminders')
          .update({ status: 'cancelled', updated_at: new Date().toISOString() })
          .eq('user_id', userId).in('id', activeReminderIds).in('status', ['pending', 'processing'])
          .select('id, content, send_at, status, task_id');
        if (error) return failure('DATABASE_ERROR', error.message, 'unknown');
        if (!Array.isArray(data)) return failure('UNOBSERVABLE_RESULT', 'Reminder cancellation returned no receipt', 'unknown');
        receipts.reminders = data;
        if (data.length !== activeReminderIds.length) return failure('CONCURRENT_CHANGE', 'Reminder state changed during deletion');
      }

      if (unfinishedTaskIds.length > 0) {
        mutationStarted = true;
        const { data, error } = await getClient().from('tasks').delete()
          .eq('user_id', userId).in('id', unfinishedTaskIds).in('status', ['pending', 'in_progress'])
          .select('id, title, status, project_id, entity_id');
        if (error) return failure('DATABASE_ERROR', error.message, 'unknown');
        if (!Array.isArray(data)) return failure('UNOBSERVABLE_RESULT', 'Task deletion returned no receipt', 'unknown');
        receipts.tasks = data;
        if (data.length !== unfinishedTaskIds.length) return failure('CONCURRENT_CHANGE', 'Task state changed during deletion');
      }

      mutationStarted = true;
      const { data: deleted, error: deleteError } = await getClient().from('projects').delete()
        .eq('user_id', userId).in('id', ids).select('id, name, description');
      if (deleteError) return failure('DATABASE_ERROR', deleteError.message, 'unknown');
      if (!Array.isArray(deleted)) return failure('UNOBSERVABLE_RESULT', 'Project deletion returned no receipt', 'unknown');
      receipts.projects = deleted;
      if (deleted.length !== ids.length) return failure('CONCURRENT_CHANGE', 'Project state changed during deletion');

      // Legacy mirrors are independently owned records; only delete observed project IDs.
      const { data: mirrors, error: mirrorError } = await getClient().from('entities').delete()
        .eq('user_id', userId).in('id', deleted.map(project => project.id)).select('id, name, category');
      if (mirrorError) return failure('DATABASE_ERROR', mirrorError.message, 'unknown');
      if (!Array.isArray(mirrors)) return failure('UNOBSERVABLE_RESULT', 'Mirror deletion returned no receipt', 'unknown');
      receipts.entities = mirrors;
      return {
        success: true, complete: true, dryRun: false, receipts,
        projects: deleted, entities: deleted,
        deletedCount: deleted.length, deletedTaskCount: receipts.tasks.length,
        cancelledReminderCount: receipts.reminders.length, preservedCompletedTaskCount,
      };
    } catch (err) {
      return failure('DATABASE_ERROR', domainErrorMessage(err), mutationStarted ? 'unknown' : 'failure');
    }
  }
  return { normalizeProjectName, projectMatchScore, selectProjectCandidate, selectProjectsForDeletion, findOrCreateProjectFuzzy, findProjects, getProjectsByUser, getProjectById, renameProject, deleteProjects };
}
