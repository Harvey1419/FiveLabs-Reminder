import { supabase } from '../../infrastructure/database/index.js';
import { resolveEntityReference } from '../core/working-memory.js';
import {
  isStrictUUID,
  normalizeTextForMatching,
  stripConversationalWrappers,
  isStandaloneAffirmative,
  calculateMatchScore,
} from '../../shared/entity-resolution.js';
import { selectEntityCandidate } from '../../infrastructure/database/entities.js';

async function resolveUserContainer(cleanQuery, normClean, userId) {
  if (!userId || !normClean) return null;
  const { data: userEntities } = await supabase
    .from('entities')
    .select('id, name, category')
    .eq('user_id', userId);

  if (userEntities && userEntities.length > 0) {
    const selection = selectEntityCandidate(userEntities, cleanQuery);
    if (selection.status === 'RESOLVED') {
      const matchedEntity = selection.entity;
      return {
        status: 'RESOLVED_CONTAINER',
        entityId: matchedEntity.id,
        entityName: matchedEntity.name,
        entity: matchedEntity,
      };
    }
    if (selection.status === 'AMBIGUOUS') {
      return { status: 'AMBIGUOUS', candidates: selection.candidates };
    }
  }
  return null;
}

/**
 * Canonical deterministic task reference resolver.
 * Operation-specific callers decide which task statuses are eligible and how
 * each resolution status is presented to the user.
 */
export async function resolveTaskTarget({
  target,
  userId,
  userOrPhone,
  userMessage = '',
  operation = 'complete',
  allowedStatuses = null,
}) {
  if (!target && !userMessage) return { status: 'MISSING' };
  const rawStr = String(target || userMessage || '').trim();
  if (!rawStr) return { status: 'MISSING' };

  const statuses = allowedStatuses || (operation === 'complete' ? ['pending'] : ['pending', 'completed']);

  if (isStrictUUID(rawStr)) {
    if (operation === 'complete') {
      const { data: directTask } = await supabase
        .from('tasks')
        .select('id, user_id, status')
        .eq('id', rawStr)
        .maybeSingle();
      if (!directTask || (userId && directTask.user_id !== userId)) return { status: 'NOT_FOUND' };
      if (directTask.status !== 'pending') return { status: 'NOT_FOUND', reason: 'TASK_ALREADY_COMPLETED' };
      return { status: 'RESOLVED', taskId: directTask.id, task: directTask };
    }
    return { status: 'RESOLVED', taskId: rawStr };
  }

  const refRes = resolveEntityReference({
    userOrPhone,
    reference: rawStr,
    preferredType: 'task',
  });

  if (refRes.status === 'RESOLVED' && refRes.item?.internalId) {
    if (operation === 'complete') {
      const { data: directTask } = await supabase
        .from('tasks')
        .select('id, user_id, status')
        .eq('id', refRes.item.internalId)
        .maybeSingle();
      if (directTask && directTask.status !== 'pending') {
        return { status: 'NOT_FOUND', reason: 'TASK_ALREADY_COMPLETED' };
      }
    }
    return {
      status: 'RESOLVED',
      taskId: refRes.item.internalId,
      item: refRes.item,
      task: refRes.item.raw || refRes.item,
    };
  }
  if (refRes.status === 'RESOLVED_CONTAINER') return refRes;
  if (refRes.status === 'AMBIGUOUS') return { status: 'AMBIGUOUS', candidates: refRes.candidates };

  if (!userId) return { status: 'NOT_FOUND' };

  const cleanQuery = stripConversationalWrappers(rawStr);
  const normClean = normalizeTextForMatching(cleanQuery);
  if (!normClean) {
    if (isStandaloneAffirmative(rawStr)) {
      return { status: 'MISSING_CONTEXT', reason: 'STANDALONE_AFFIRMATIVE_WITHOUT_CONTEXT' };
    }
    return { status: 'NOT_FOUND' };
  }

  let tasksQuery = supabase
    .from('tasks')
    .select('*, entities:entity_id(id, name, category)')
    .eq('user_id', userId);

  if (statuses.length === 1) tasksQuery = tasksQuery.eq('status', statuses[0]);
  else tasksQuery = tasksQuery.in('status', statuses);

  const { data: dbTasks, error: dbError } = await tasksQuery;
  if (dbError || !dbTasks || dbTasks.length === 0) {
    const containerResult = await resolveUserContainer(cleanQuery, normClean, userId);
    if (containerResult) return containerResult;
    return { status: 'NOT_FOUND' };
  }

  if (rawStr.length >= 8 && /^[0-9a-fA-F-]+$/.test(rawStr)) {
    const prefixMatches = dbTasks.filter((task) => task.id.toLowerCase().startsWith(rawStr.toLowerCase()));
    if (prefixMatches.length === 1) return { status: 'RESOLVED', taskId: prefixMatches[0].id, task: prefixMatches[0] };
    if (prefixMatches.length > 1) return { status: 'AMBIGUOUS', candidates: prefixMatches };
  }

  const exact = dbTasks.filter((task) => normalizeTextForMatching(task.title) === normClean);
  if (exact.length === 1) return { status: 'RESOLVED', taskId: exact[0].id, task: exact[0] };
  if (exact.length > 1) return { status: 'AMBIGUOUS', candidates: exact };

  const substringMatches = dbTasks.filter((task) => {
    const normalizedTitle = normalizeTextForMatching(task.title);
    return normalizedTitle.includes(normClean) || normClean.includes(normalizedTitle);
  });
  if (substringMatches.length === 1) {
    return { status: 'RESOLVED', taskId: substringMatches[0].id, task: substringMatches[0] };
  }
  if (substringMatches.length > 1) return { status: 'AMBIGUOUS', candidates: substringMatches };

  const scored = dbTasks
    .map((task) => ({ task, score: calculateMatchScore(cleanQuery, task.title) }))
    .filter(({ score }) => score >= 0.5)
    .sort((a, b) => b.score - a.score);

  if (scored.length === 1) return { status: 'RESOLVED', taskId: scored[0].task.id, task: scored[0].task };
  if (scored.length > 1) {
    const [top, runnerUp] = scored;
    if (top.score >= 0.75 && (top.score - runnerUp.score) >= 0.20) {
      return { status: 'RESOLVED', taskId: top.task.id, task: top.task };
    }
    return { status: 'AMBIGUOUS', candidates: scored.map(({ task }) => task) };
  }

  const containerResult = await resolveUserContainer(cleanQuery, normClean, userId);
  if (containerResult) return containerResult;
  return { status: 'NOT_FOUND' };
}
