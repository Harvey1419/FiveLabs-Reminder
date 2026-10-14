import type { FeatureClient, FeatureRow } from '../../features/read-model-ports.js';
import type { TaskResolution, TaskReferenceInput, TaskReferenceItem } from './task-tool-ports.js';
export interface Dependencies { supabase: FeatureClient; getWorkingMemory(key: unknown): { items?: TaskReferenceItem[] } | null; parseStructuredOrdinal: typeof import('../core/context-reference.js').parseStructuredOrdinal; resolveContextReference(input: Record<string, unknown>): TaskResolution; isStrictUUID(value: unknown): boolean; normalizeTextForMatching: typeof import('../../shared/entity-resolution.js').normalizeTextForMatching; calculateMatchScore: typeof import('../../shared/entity-resolution.js').calculateMatchScore; selectEntityCandidate(rows: { id: string; name?: string | null | undefined }[], name: string): ReturnType<typeof import('../../infrastructure/database/entities.js').selectEntityCandidate>; logger: Pick<Console, 'warn' | 'error'>; getNowMs(): number }

export function createTaskTargetResolution({ supabase, getWorkingMemory, parseStructuredOrdinal, resolveContextReference, isStrictUUID, normalizeTextForMatching, calculateMatchScore, selectEntityCandidate, logger, getNowMs }: Dependencies) {

async function resolveUserContainer(query: string, normalizedQuery: string, userId: string | undefined) {
  if (!userId || !normalizedQuery) return null;
  const [{ data: userEntities }, { data: userProjects }] = await Promise.all([
    supabase
      .from('entities')
      .select('id, name, category')
      .eq('user_id', userId),
    supabase
      .from('projects')
      .select('id, name')
      .eq('user_id', userId)
      .eq('status', 'active'),
  ]);

  const allContainers = [
    ...(userEntities || []),
    ...(userProjects || []).map((p) => ({ id: p.id, name: p.name, category: 'project' })),
  ];
  const uniqueContainers = Array.from(new Map(allContainers.map((c) => [c.id, c])).values());

  if (uniqueContainers.length > 0) {
    const selection = selectEntityCandidate(uniqueContainers, query);
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

async function loadOwnedTask(taskId: string, userId: string | undefined, allowedStatuses: string[], scopedEntityId: string | null = null): Promise<TaskResolution> {
  if (!taskId || !userId) return { status: 'NOT_FOUND' };
  let query = supabase
    .from('tasks')
    .select('id, user_id, status, description, title, entity_id, project_id')
    .eq('id', taskId);
  if (scopedEntityId) {
    if (typeof query.or === 'function') query = query.or(`entity_id.eq.${scopedEntityId},project_id.eq.${scopedEntityId}`);
    else query = query.eq('entity_id', scopedEntityId);
  }
  const { data: task, error } = await query.maybeSingle();
  if (error || !task || task.user_id !== userId) return { status: 'NOT_FOUND' };
  if (!allowedStatuses.includes(task.status as string)) {
    return {
      status: 'NOT_FOUND',
      ...(task.status === 'completed' ? { reason: 'TASK_ALREADY_COMPLETED', taskId: task.id, task } : {}),
    };
  }
  return { status: 'RESOLVED', taskId: task.id, task };
}

/**
 * Canonical deterministic task reference resolver.
 * Receives a structured target from Hermes/Orchestrator and only resolves that
 * target against working memory and tenant-owned task/entity data. It does not
 * interpret conversational completion phrases or raw user intent.
 */
async function resolveTaskTarget({
  target,
  entityName = null,
  entityId = null,
  userId,
  userOrPhone,
  operation = 'complete',
  allowedStatuses = null,
}: TaskReferenceInput): Promise<TaskResolution> {
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
    scopedEntityId = container.entityId!;
  }

  if (isStrictUUID(rawStr)) {
    return loadOwnedTask(rawStr, userId, statuses, scopedEntityId);
  }

  const workingMemory = getWorkingMemory(userOrPhone);
  const ordinal = parseStructuredOrdinal(rawStr);
  const taskCount = Array.isArray(workingMemory?.items)
    ? workingMemory.items.filter((item) => item?.type === 'task').length
    : 0;
  if (ordinal! > taskCount && taskCount > 0) return { status: 'NOT_FOUND', reason: 'TASK_ORDINAL_OUT_OF_RANGE' };

  const refRes = resolveContextReference({
    reference: rawStr,
    preferredType: 'task',
    workingMemory,
  });

  const referenceEntityId = refRes.item?.raw?.entity_id || refRes.item?.raw?.entityId || refRes.item?.entityId || null;
  const referenceEntityName = refRes.item?.entityName || refRes.item?.raw?.entities?.name || null;
  const referenceMatchesScope = !scopedEntityId
    || referenceEntityId === scopedEntityId
    || (entityName && String(referenceEntityName || '').trim().toLowerCase() === String(entityName).trim().toLowerCase());
  if (refRes.status === 'RESOLVED' && refRes.item?.internalId && referenceMatchesScope) {
    const ownedTask = await loadOwnedTask(refRes.item.internalId, userId, statuses, scopedEntityId);
    if (ownedTask.status !== 'RESOLVED') return ownedTask;
    return { ...ownedTask, item: refRes.item };
  }
  if (refRes.status === 'AMBIGUOUS') return { status: 'AMBIGUOUS', candidates: refRes.candidates };

  if (!userId) return { status: 'NOT_FOUND' };

  const normalizedQuery = normalizeTextForMatching(rawStr);
  if (!normalizedQuery) return { status: 'NOT_FOUND' };

  let tasksQuery = supabase
    .from('tasks')
    .select('*, entities:entity_id(id, name, category), projects:project_id(id, name, status)')
    .eq('user_id', userId);

  if (scopedEntityId) {
    if (typeof tasksQuery.or === 'function') {
      tasksQuery = tasksQuery.or(`entity_id.eq.${scopedEntityId},project_id.eq.${scopedEntityId}`);
    } else {
      tasksQuery = tasksQuery.eq('entity_id', scopedEntityId);
    }
  }

  if (statuses.length === 1) tasksQuery = tasksQuery.eq('status', statuses[0]);
  else tasksQuery = tasksQuery.in('status', statuses);

  const { data: dbTasks, error: dbError } = await tasksQuery;
  if (dbError || !dbTasks || dbTasks.length === 0) {
    const containerResult = await resolveUserContainer(rawStr, normalizedQuery, userId);
    if (containerResult) return containerResult;
    return { status: 'NOT_FOUND' };
  }

  const eligibleTasks = dbTasks.filter((task) => task.user_id === userId && statuses.includes(task.status as string));
  if (rawStr.length >= 8 && /^[0-9a-fA-F-]+$/.test(rawStr)) {
    const prefixMatches = eligibleTasks.filter((task) => task.id.toLowerCase().startsWith(rawStr.toLowerCase()));
    if (prefixMatches.length === 1) return { status: 'RESOLVED', taskId: prefixMatches[0]!.id, task: prefixMatches[0]! };
    if (prefixMatches.length > 1) return { status: 'AMBIGUOUS', candidates: prefixMatches };
  }

  const exact = eligibleTasks.filter((task) => normalizeTextForMatching(task.title) === normalizedQuery);
  if (exact.length === 1) return { status: 'RESOLVED', taskId: exact[0]!.id, task: exact[0]! };
  if (exact.length > 1) return { status: 'AMBIGUOUS', candidates: exact };

  const substringMatches = eligibleTasks.filter((task) => {
    const normalizedTitle = normalizeTextForMatching(task.title);
    return normalizedTitle.includes(normalizedQuery) || normalizedQuery.includes(normalizedTitle);
  });
  if (substringMatches.length === 1) {
    return { status: 'RESOLVED', taskId: substringMatches[0]!.id, task: substringMatches[0]! };
  }
  if (substringMatches.length > 1) return { status: 'AMBIGUOUS', candidates: substringMatches };

  const scored = eligibleTasks
    .map((task) => ({ task, score: calculateMatchScore(rawStr, task.title) }))
    .filter(({ score }) => score >= 0.5)
    .sort((a, b) => b.score - a.score);

  if (scored.length === 1) return { status: 'RESOLVED', taskId: scored[0]!.task.id, task: scored[0]!.task };
  if (scored.length > 1) {
    const top = scored[0]!, runnerUp = scored[1]!;
    if (top.score >= 0.75 && (top.score - runnerUp.score) >= 0.20) {
      return { status: 'RESOLVED', taskId: top.task.id, task: top.task };
    }
    return { status: 'AMBIGUOUS', candidates: scored.map(({ task }) => task) };
  }

  const containerResult = await resolveUserContainer(rawStr, normalizedQuery, userId);
  if (containerResult) return containerResult;
  return { status: 'NOT_FOUND' };
}

return { resolveTaskTarget };
}
