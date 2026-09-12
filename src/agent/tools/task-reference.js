import { supabase } from '../../infrastructure/database/index.js';
import { getWorkingMemory } from '../core/working-memory.js';
import { resolveContextReference } from '../core/context-reference.js';
import {
  isStrictUUID,
  normalizeTextForMatching,
  calculateMatchScore,
} from '../../shared/entity-resolution.js';
import { selectEntityCandidate } from '../../infrastructure/database/entities.js';

async function resolveUserContainer(query, normalizedQuery, userId) {
  if (!userId || !normalizedQuery) return null;
  const { data: userEntities } = await supabase
    .from('entities')
    .select('id, name, category')
    .eq('user_id', userId);

  if (userEntities && userEntities.length > 0) {
    const selection = selectEntityCandidate(userEntities, query);
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
 * Receives a structured target from Hermes/Orchestrator and only resolves that
 * target against working memory and tenant-owned task/entity data. It does not
 * interpret conversational completion phrases or raw user intent.
 */
export async function resolveTaskTarget({
  target,
  entityName = null,
  entityId = null,
  userId,
  userOrPhone,
  operation = 'complete',
  allowedStatuses = null,
}) {
  if (!target) return { status: 'MISSING' };
  const rawStr = String(target).trim();
  if (!rawStr) return { status: 'MISSING' };

  const statuses = allowedStatuses || (operation === 'complete' ? ['pending'] : ['pending', 'completed']);

  // Scope is already interpreted by Hermes. Resolve it structurally before
  // matching the task so duplicate titles in other containers cannot compete.
  let scopedEntityId = entityId || null;
  if (!scopedEntityId && entityName) {
    const container = await resolveUserContainer(String(entityName).trim(), normalizeTextForMatching(entityName), userId);
    if (!container) return { status: 'NOT_FOUND' };
    if (container.status === 'AMBIGUOUS') return container;
    scopedEntityId = container.entityId;
  }

  if (isStrictUUID(rawStr)) {
    const directTaskQuery = supabase
        .from('tasks')
        .select('id, user_id, status')
        .eq('id', rawStr);
    if (scopedEntityId) directTaskQuery.eq('entity_id', scopedEntityId);
    const { data: directTask } = await directTaskQuery.maybeSingle();
    if (operation === 'complete') {
      if (!directTask || (userId && directTask.user_id !== userId)) return { status: 'NOT_FOUND' };
      if (directTask.status !== 'pending') return { status: 'NOT_FOUND', reason: 'TASK_ALREADY_COMPLETED' };
      return { status: 'RESOLVED', taskId: directTask.id, task: directTask };
    }
    return { status: 'RESOLVED', taskId: rawStr };
  }

  const refRes = resolveContextReference({
    reference: rawStr,
    preferredType: 'task',
    workingMemory: getWorkingMemory(userOrPhone),
  });

  const referenceEntityId = refRes.item?.raw?.entity_id || refRes.item?.raw?.entityId || refRes.item?.entityId || null;
  const referenceEntityName = refRes.item?.entityName || refRes.item?.raw?.entities?.name || null;
  const referenceMatchesScope = !scopedEntityId
    || referenceEntityId === scopedEntityId
    || (entityName && String(referenceEntityName || '').trim().toLowerCase() === String(entityName).trim().toLowerCase());
  if (refRes.status === 'RESOLVED' && refRes.item?.internalId && referenceMatchesScope) {
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
  if (refRes.status === 'AMBIGUOUS') return { status: 'AMBIGUOUS', candidates: refRes.candidates };

  if (!userId) return { status: 'NOT_FOUND' };

  const normalizedQuery = normalizeTextForMatching(rawStr);
  if (!normalizedQuery) return { status: 'NOT_FOUND' };

  let tasksQuery = supabase
    .from('tasks')
    .select('*, entities:entity_id(id, name, category)')
    .eq('user_id', userId);

  if (scopedEntityId) tasksQuery = tasksQuery.eq('entity_id', scopedEntityId);

  if (statuses.length === 1) tasksQuery = tasksQuery.eq('status', statuses[0]);
  else tasksQuery = tasksQuery.in('status', statuses);

  const { data: dbTasks, error: dbError } = await tasksQuery;
  if (dbError || !dbTasks || dbTasks.length === 0) {
    const containerResult = await resolveUserContainer(rawStr, normalizedQuery, userId);
    if (containerResult) return containerResult;
    return { status: 'NOT_FOUND' };
  }

  if (rawStr.length >= 8 && /^[0-9a-fA-F-]+$/.test(rawStr)) {
    const prefixMatches = dbTasks.filter((task) => task.id.toLowerCase().startsWith(rawStr.toLowerCase()));
    if (prefixMatches.length === 1) return { status: 'RESOLVED', taskId: prefixMatches[0].id, task: prefixMatches[0] };
    if (prefixMatches.length > 1) return { status: 'AMBIGUOUS', candidates: prefixMatches };
  }

  const exact = dbTasks.filter((task) => normalizeTextForMatching(task.title) === normalizedQuery);
  if (exact.length === 1) return { status: 'RESOLVED', taskId: exact[0].id, task: exact[0] };
  if (exact.length > 1) return { status: 'AMBIGUOUS', candidates: exact };

  const substringMatches = dbTasks.filter((task) => {
    const normalizedTitle = normalizeTextForMatching(task.title);
    return normalizedTitle.includes(normalizedQuery) || normalizedQuery.includes(normalizedTitle);
  });
  if (substringMatches.length === 1) {
    return { status: 'RESOLVED', taskId: substringMatches[0].id, task: substringMatches[0] };
  }
  if (substringMatches.length > 1) return { status: 'AMBIGUOUS', candidates: substringMatches };

  const scored = dbTasks
    .map((task) => ({ task, score: calculateMatchScore(rawStr, task.title) }))
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

  const containerResult = await resolveUserContainer(rawStr, normalizedQuery, userId);
  if (containerResult) return containerResult;
  return { status: 'NOT_FOUND' };
}
