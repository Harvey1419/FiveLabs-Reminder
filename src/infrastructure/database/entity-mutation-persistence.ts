import type { JsonObject } from '@templelabs/contracts';
import { domainErrorMessage,type DomainPersistenceClient,type DomainStorageError,type TaskContainerRow } from './domain-persistence-client.js';
import { normalizeEntityName,entityMatchScore,selectEntitiesForDeletion,partitionLinkedTasksForEntityDeletion,mergeMetadata,type EntityDeletionOptions } from './entity-resolution.js';
import type { CreateEntityInput } from './entity-persistence.js';
export interface EntityMutationClient extends DomainPersistenceClient {
  rpc?(name: 'rename_entity_cascade' | 'merge_entities',args: JsonObject): PromiseLike<{ data: JsonObject | null; error: DomainStorageError | null }>;
}
export interface EntityDeleteInput extends EntityDeletionOptions { userId: string; dryRun?: boolean; entityIds?: readonly string[] | null }
export interface EntityRenameInput { userId: string; oldName: string; newName: string; category?: string | undefined }
export interface EntityMergeInput { userId: string; sourceName: string; targetName: string; category?: string | undefined }
function object(value: unknown): value is JsonObject { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function count(value: unknown): value is number { return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0; }
function uncertain() { return { success: false as const,complete: false,outcome: 'unknown',errorCode: 'ENTITY_MUTATION_RECONCILIATION_REQUIRED',error: 'Entity mutation outcome requires reconciliation' }; }
/** Legacy mutation semantics over typed host ports; never replay an uncertain RPC through the compatibility path. */
export function createEntityMutationPersistence(getClient: () => EntityMutationClient,
  findOrCreateEntityFuzzy: (input: CreateEntityInput) => Promise<TaskContainerRow | null>) {
  async function atomic(name: 'rename_entity_cascade' | 'merge_entities',args: JsonObject): Promise<
    { kind: 'unavailable' } | { kind: 'uncertain' } | { kind: 'observed'; data: JsonObject }> {
    const client = getClient();
    if (!client.rpc) return { kind: 'unavailable' };
    try {
      const result = await client.rpc(name,args);
      if (result.error?.code === 'PGRST202' || result.error?.code === '42883') return { kind: 'unavailable' };
      if (result.error || !object(result.data)) return { kind: 'uncertain' };
      return { kind: 'observed',data: result.data };
    } catch { return { kind: 'uncertain' }; }
  }
  async function deleteEntities({
    userId,
    targetName = null,
    targetNames = null,
    category = null,
    scope = 'single',
    preserveNames = [],
    dryRun = false,
    entityIds = null,
  }: EntityDeleteInput) {
    const hasExactIds = Array.isArray(entityIds) && entityIds.length > 0;
    const hasNames = (Array.isArray(targetNames) && targetNames.length > 0) || Boolean(targetName);
    if (!userId || (!hasExactIds && scope !== 'all' && !hasNames)) {
      return { success: false, errorCode: 'INVALID_PARAMETERS', error: 'Missing deletion target.', deletedCount: 0 };
    }

    let mutationStarted = false;
    let entityReceipts: TaskContainerRow[] = [];
    let cancelledReminderCount = 0, deletedTaskCount = 0;
    const unconfirmedDelete = () => ({ ...uncertain(),entities: entityReceipts,deletedCount: entityReceipts.length,
      cancelledReminderCount,deletedTaskCount,partialSuccess: entityReceipts.length > 0 || cancelledReminderCount > 0 || deletedTaskCount > 0 });
    try {
      let query = getClient().from('entities').select('*').eq('user_id', userId);
      if (hasExactIds) {
        query = query.in('id', entityIds!);
      } else if (category) {
        query = query.eq('category', category);
      }
      const { data: entities, error: fetchError } = await query;
      if (fetchError) return { success: false, errorCode: 'DATABASE_ERROR', error: fetchError.message, deletedCount: 0 };

      const selection = hasExactIds
        ? { status: 'RESOLVED' as const, entities: entities || [], candidates: [] }
        : selectEntitiesForDeletion(entities ?? [], { targetName, targetNames, category, scope, preserveNames });
      if (selection.status === 'AMBIGUOUS') {
        return { success: false, errorCode: 'AMBIGUOUS_TARGET', error: 'Multiple entities match.', candidates: selection.candidates, deletedCount: 0 };
      }
      if (selection.entities.length === 0) {
        return { success: false, errorCode: 'NOT_FOUND', error: 'No matching entities found.', deletedCount: 0 };
      }

      const ids = selection.entities.map((entity) => entity.id);
      let tasksQ = getClient()
        .from('tasks')
        .select('id, status')
        .eq('user_id', userId);

      if (typeof tasksQ.or === 'function') {
        tasksQ = tasksQ.or(`entity_id.in.(${ids.join(',')}),project_id.in.(${ids.join(',')})`);
      } else {
        tasksQ = tasksQ.in('entity_id', ids);
      }
      const { data: linkedTasks, error: linkedTasksError } = await tasksQ;
      if (linkedTasksError) {
        return { success: false, errorCode: 'DATABASE_ERROR', error: linkedTasksError.message, deletedCount: 0 };
      }

      const { unfinishedTaskIds, preservedCompletedTaskCount } =
        partitionLinkedTasksForEntityDeletion(linkedTasks ?? []);
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
        activeReminderIds = (activeReminders || []).map((reminder) => reminder.id).filter(Boolean);
      }

      if (dryRun) {
        return {
          success: true,
          dryRun: true,
          entities: selection.entities,
          deletedCount: 0,
          pendingTaskCount: unfinishedTaskIds.length,
          activeReminderCount: activeReminderIds.length,
          preservedCompletedTaskCount,
        };
      }

      mutationStarted = true;
      const { data: deleted, error: deleteError } = await getClient()
        .from('entities')
        .delete()
        .eq('user_id', userId)
        .in('id', ids)
        .select('id, name, category');
      if (deleteError || !Array.isArray(deleted)) return unconfirmedDelete();
      entityReceipts = deleted;
      if (deleted.length !== ids.length || deleted.some(row => !ids.includes(row.id)) || new Set(deleted.map(row => row.id)).size !== ids.length) return unconfirmedDelete();

      // Sync delete to projects table for matching project containers
      try {
        await getClient()
          .from('projects')
          .delete()
          .eq('user_id', userId)
          .in('id', ids);
      } catch {}

      let reminderCleanupError: string | null = null;
      if (activeReminderIds.length > 0) {
        const { data: cancelledReminders, error: cancelRemindersError } = await getClient()
          .from('reminders')
          .update({ status: 'cancelled', acknowledged_at: new Date().toISOString() })
          .eq('user_id', userId)
          .in('id', activeReminderIds)
          .in('status', ['pending', 'processing'])
          .select('id');
        cancelledReminderCount = cancelledReminders?.length || 0;
        reminderCleanupError = cancelRemindersError?.message || (!Array.isArray(cancelledReminders) || cancelledReminders.length !== activeReminderIds.length ? 'Reminder cleanup requires reconciliation' : null);
      }

      let taskCleanupError: string | null = null;
      if (!reminderCleanupError && unfinishedTaskIds.length > 0) {
        const { data: deletedTasks, error: deleteTasksError } = await getClient()
          .from('tasks')
          .delete()
          .eq('user_id', userId)
          .in('id', unfinishedTaskIds)
          .in('status', ['pending', 'in_progress'])
          .select('id');
        deletedTaskCount = deletedTasks?.length || 0;
        taskCleanupError = deleteTasksError?.message || (!Array.isArray(deletedTasks) || deletedTasks.length !== unfinishedTaskIds.length ? 'Task cleanup requires reconciliation' : null);
      }

      const cleanupError = reminderCleanupError || taskCleanupError;

      return {
        success: true,
        complete: !cleanupError,
        partialSuccess: Boolean(cleanupError),
        entities: deleted || [],
        deletedCount: deleted?.length || 0,
        pendingTaskCount: unfinishedTaskIds.length,
        deletedTaskCount,
        activeReminderCount: activeReminderIds.length,
        cancelledReminderCount,
        preservedCompletedTaskCount,
        reminderCleanupError,
        taskCleanupError,
      };
    } catch (error) {
      if (mutationStarted) return unconfirmedDelete();
      return { success: false, errorCode: 'DATABASE_ERROR', error: domainErrorMessage(error), deletedCount: 0 };
    }
  }

  /**
   * Rename an entity, updating its name and preserving linked tasks and reminders.
   * If target entity with newName already exists, merges them automatically.
   *
   * @param {object|string} paramsOrUserId
   * @param {string} [oldNameArg]
   * @param {string} [newNameArg]
   * @param {string} [categoryArg]
   * @returns {Promise<{success: boolean, action: string, entity?: object, oldName?: string, newName?: string, error?: string}>}
   */
  async function renameEntity(paramsOrUserId: string | EntityRenameInput, oldNameArg?: string, newNameArg?: string, categoryArg?: string) {
    const userId = typeof paramsOrUserId === 'object' ? paramsOrUserId.userId : paramsOrUserId;
    const oldName = typeof paramsOrUserId === 'object' ? paramsOrUserId.oldName : oldNameArg;
    const newName = typeof paramsOrUserId === 'object' ? paramsOrUserId.newName : newNameArg;
    const category = typeof paramsOrUserId === 'object' ? paramsOrUserId.category : categoryArg;

    if (!userId || !oldName || !newName) {
      return { success: false, error: 'Missing userId, oldName, or newName' };
    }

    const cleanOld = String(oldName).trim();
    const cleanNew = String(newName).trim();

    const renamed = await atomic('rename_entity_cascade', { p_user_id: userId,p_old_name: cleanOld,p_new_name: cleanNew,p_category: category || 'other' });
    if (renamed.kind === 'uncertain') return uncertain();
    if (renamed.kind === 'observed') {
      const rpcResult = renamed.data;
      if (rpcResult.success !== true || typeof rpcResult.entity_id !== 'string' || !rpcResult.entity_id
        || !count(rpcResult.tasks_updated) || !count(rpcResult.reminders_updated) || !count(rpcResult.memories_updated)) return uncertain();
      return { success: true,action: 'renamed_atomic_rpc',entity: { id: rpcResult.entity_id,name: cleanNew,category: category || 'other' },
        oldName: cleanOld,newName: cleanNew,tasksUpdated: rpcResult.tasks_updated,remindersUpdated: rpcResult.reminders_updated,memoriesUpdated: rpcResult.memories_updated };
    }

    try {
      // 1. Resolve source and target entities
      const { data: entities, error: fetchErr } = await getClient()
        .from('entities')
        .select('*')
        .eq('user_id', userId);

      if (fetchErr || !entities || entities.length === 0) {
        return { success: false, error: 'No entities found for user' };
      }

      let source: TaskContainerRow | null = null;
      let maxScore = 0;
      for (const ent of entities) {
        if (ent.name.toLowerCase() === cleanOld.toLowerCase()) {
          source = ent;
          maxScore = 1.0;
          break;
        }
        if (category && ent.category !== category) continue;
        const score = entityMatchScore(cleanOld, ent.name);
        if (score > maxScore) {
          maxScore = score;
          source = ent;
        }
      }

      if (!source) {
        for (const ent of entities) {
          const score = entityMatchScore(cleanOld, ent.name);
          if (score > maxScore) {
            maxScore = score;
            source = ent;
          }
        }
      }

      if (!source || maxScore < 0.60) {
        source = null;
      }

      // 2. Check if an entity with newName already exists
      let target: TaskContainerRow | null = null;
      if (entities) {
        for (const ent of entities) {
          if (source && ent.id === source.id) continue;
          if (category && ent.category !== category) continue;
          if (normalizeEntityName(ent.name) === normalizeEntityName(cleanNew)) {
            target = ent;
            break;
          }
        }
      }

      let updatedEntity: TaskContainerRow | null = null;

      if (source && target) {
        // Merge source into target
        const mergeRes = await mergeEntities({ userId, sourceName: source.name, targetName: target.name, category });
        if (!mergeRes.success) return mergeRes;
        updatedEntity = mergeRes.targetEntity || target;
      } else if (source) {
        // Rename source
        const { data: updated, error: updateErr } = await getClient()
          .from('entities')
          .update({
            name: cleanNew,
            updated_at: new Date().toISOString(),
          })
          .eq('id', source.id)
          .eq('user_id', userId)
          .select()
          .single();

        if (!updateErr && updated) {
          updatedEntity = updated;
          if (updated.category === 'project') {
            try {
              await getClient()
                .from('projects')
                .update({ name: cleanNew, updated_at: new Date().toISOString() })
                .eq('id', updated.id)
                .eq('user_id', userId);
            } catch {
              // Non-fatal sync
            }
          }
        }
      } else {
        // Source wasn't pre-registered in entities table; ensure target entity exists
        updatedEntity = await findOrCreateEntityFuzzy({
          userId,
          name: cleanNew,
          category: category || 'other',
        });
      }

      // 4. Universal cascade rename across pending reminders, active tasks, and active memories
      let remindersUpdated = 0;
      let tasksUpdated = 0;
      let memoriesUpdated = 0;

      try {
        const escapedOld = cleanOld.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const nameRegex = new RegExp(`\\b${escapedOld}\\b`, 'gi');

        // Cascade to pending reminders
        const { data: userReminders } = await getClient()
          .from('reminders')
          .select('id, content')
          .eq('user_id', userId)
          .in('status', ['pending', 'processing']);

        for (const rem of (userReminders || [])) {
          if (nameRegex.test(rem.content ?? '')) {
            const newContent = (rem.content ?? '').replace(nameRegex, cleanNew);
            await getClient().from('reminders').update({ content: newContent }).eq('id', rem.id).eq('user_id', userId);
            remindersUpdated++;
          }
        }

        // Cascade to active tasks
        const { data: userTasks } = await getClient()
          .from('tasks')
          .select('id, title, description, entity_id')
          .eq('user_id', userId)
          .in('status', ['pending', 'in_progress']);

        for (const t of (userTasks || [])) {
          let changed = false;
          const updates: JsonObject = {};
          if (t.title && nameRegex.test(t.title)) {
            updates.title = t.title.replace(nameRegex, cleanNew);
            changed = true;
          }
          if (t.description && nameRegex.test(t.description)) {
            updates.description = t.description.replace(nameRegex, cleanNew);
            changed = true;
          }
          if (updatedEntity?.id && (!t.entity_id || (source && t.entity_id === source.id))) {
            if (changed) {
              updates.entity_id = updatedEntity.id;
            }
          }
          if (changed) {
            await getClient().from('tasks').update(updates).eq('id', t.id).eq('user_id', userId);
            tasksUpdated++;
          }
        }

        // Cascade to active memories
        const { data: userMemories } = await getClient()
          .from('memories')
          .select('id, content, topic_key')
          .eq('user_id', userId)
          .eq('is_active', true);

        for (const mem of (userMemories || [])) {
          let changed = false;
          const updates: JsonObject = {};
          if (nameRegex.test(mem.content)) {
            updates.content = mem.content.replace(nameRegex, cleanNew);
            changed = true;
          }
          if (nameRegex.test(mem.topic_key)) {
            updates.topic_key = mem.topic_key.replace(nameRegex, cleanNew.toLowerCase());
            changed = true;
          }
          if (changed) {
            await getClient().from('memories').update(updates).eq('id', mem.id).eq('user_id', userId);
            memoriesUpdated++;
          }
        }
      } catch (cascadeErr) {
        console.warn('[entities] renameEntity cascade warning:', domainErrorMessage(cascadeErr));
      }

      console.log(`[entities] Renamed "${cleanOld}" -> "${cleanNew}" with cascade (tasks: ${tasksUpdated}, reminders: ${remindersUpdated}, memories: ${memoriesUpdated})`);
      return {
        success: true,
        action: 'renamed',
        entity: updatedEntity,
        oldName: cleanOld,
        newName: cleanNew,
        tasksUpdated,
        remindersUpdated,
        memoriesUpdated,
      };
    } catch (err) {
      console.error('[entities] renameEntity error:', err);
      return { success: false, error: domainErrorMessage(err) };
    }
  }

  /**
   * Merge source entity into target entity, reassigning all tasks and deleting source.
   *
   * @param {object|string} paramsOrUserId
   * @param {string} [sourceNameArg]
   * @param {string} [targetNameArg]
   * @param {string} [categoryArg]
   * @returns {Promise<{success: boolean, action: string, targetEntity?: object, tasksMovedCount: number, error?: string}>}
   */
  async function mergeEntities(paramsOrUserId: string | EntityMergeInput, sourceNameArg?: string, targetNameArg?: string, categoryArg?: string) {
    const userId = typeof paramsOrUserId === 'object' ? paramsOrUserId.userId : paramsOrUserId;
    const sourceName = typeof paramsOrUserId === 'object' ? paramsOrUserId.sourceName : sourceNameArg;
    const targetName = typeof paramsOrUserId === 'object' ? paramsOrUserId.targetName : targetNameArg;
    const category = typeof paramsOrUserId === 'object' ? paramsOrUserId.category : categoryArg;

    if (!userId || !sourceName || !targetName) {
      return { success: false, tasksMovedCount: 0, error: 'Missing userId, sourceName, or targetName' };
    }

    const cleanSource = String(sourceName).trim();
    const cleanTarget = String(targetName).trim();

    try {
      const { data: entities, error: fetchErr } = await getClient()
        .from('entities')
        .select('*')
        .eq('user_id', userId);

      if (fetchErr || !entities || entities.length === 0) {
        return { success: false, tasksMovedCount: 0, error: 'No entities found' };
      }

      let source: TaskContainerRow | null = null;
      let target: TaskContainerRow | null = null;
      let bestSourceScore = 0;
      let bestTargetScore = 0;

      for (const ent of entities) {
        if (category && ent.category !== category) continue;
        const sScore = entityMatchScore(cleanSource, ent.name);
        if (sScore > bestSourceScore) {
          bestSourceScore = sScore;
          source = ent;
        }
        const tScore = entityMatchScore(cleanTarget, ent.name);
        if (tScore > bestTargetScore) {
          bestTargetScore = tScore;
          target = ent;
        }
      }

      if (!source || bestSourceScore < 0.60) {
        return { success: false, tasksMovedCount: 0, error: `Source entity "${cleanSource}" not found` };
      }

      // If target doesn't exist, create it or rename source
      if (!target || bestTargetScore < 0.60) {
        const { data: renamed, error: rErr } = await getClient()
          .from('entities')
          .update({ name: cleanTarget, updated_at: new Date().toISOString() })
          .eq('id', source.id)
          .eq('user_id', userId)
          .select()
          .single();

        if (rErr) return { success: false, tasksMovedCount: 0, error: rErr.message };
        return { success: true, action: 'renamed_to_target', targetEntity: renamed, tasksMovedCount: 0 };
      }

      if (source.id === target.id) {
        return { success: true, action: 'noop', targetEntity: target, tasksMovedCount: 0 };
      }

      const merged = await atomic('merge_entities', { p_user_id: userId,p_source_id: source.id,p_target_id: target.id });
      if (merged.kind === 'uncertain') return { ...uncertain(),tasksMovedCount: 0 };
      if (merged.kind === 'observed') {
        const rpcRes = merged.data;
        if (rpcRes.success !== true || rpcRes.source_id !== source.id || rpcRes.target_id !== target.id || !count(rpcRes.tasks_reassigned)
          || !object(rpcRes.merged_metadata)) return { ...uncertain(),tasksMovedCount: 0 };
        try {
          await getClient().from('tasks').update({ project_id: target.id }).or(`entity_id.eq.${source.id},project_id.eq.${source.id}`).eq('user_id', userId);
          await getClient().from('projects').delete().eq('id', source.id).eq('user_id', userId);
          await getClient().from('projects').delete().ilike('name', cleanSource).eq('user_id', userId);
          await getClient().from('projects').upsert({ id: target.id,user_id: userId,name: target.name,metadata: rpcRes.merged_metadata,
            status: 'active',updated_at: new Date().toISOString() },{ onConflict: 'user_id, name' });
        } catch { /* Existing best-effort project mirror is not part of the atomic RPC receipt. */ }
        return { success: true,action: 'merged_atomic_rpc',targetEntity: { ...target,metadata: rpcRes.merged_metadata },tasksMovedCount: rpcRes.tasks_reassigned };
      }

      // 1. Move all tasks from source to target
      const { data: movedTasks, error: moveErr } = await getClient()
        .from('tasks')
        .update({ entity_id: target.id, project_id: target.id, updated_at: new Date().toISOString() })
        .or(`entity_id.eq.${source.id},project_id.eq.${source.id}`)
        .eq('user_id', userId)
        .select();

      if (moveErr || !Array.isArray(movedTasks)) return { ...uncertain(),tasksMovedCount: 0,error: moveErr?.message || 'Task reassignment returned no receipt' };
      const tasksMovedCount = movedTasks.length;

      // 2. Merge metadata
      const mergedMetadata = mergeMetadata(source.metadata, target.metadata);

      const { data: updatedTarget,error: metadataError } = await getClient()
        .from('entities')
        .update({
          metadata: mergedMetadata,
          updated_at: new Date().toISOString(),
        })
        .eq('id', target.id)
        .eq('user_id', userId)
        .select()
        .single();

      if (metadataError || !updatedTarget) return { ...uncertain(),tasksMovedCount,error: metadataError?.message || 'Target update returned no receipt' };

      // 3. Delete source entity
      const { data: deletedSource,error: sourceError } = await getClient().from('entities').delete().eq('id', source.id).eq('user_id', userId).select('id');
      if (sourceError || !deletedSource || deletedSource.length !== 1 || deletedSource[0]?.id !== source.id) return { ...uncertain(),tasksMovedCount,error: sourceError?.message || 'Source deletion returned no matching receipt' };

      // 4. Sync projects table
      try {
        await getClient().from('projects').delete().eq('id', source.id).eq('user_id', userId);
        await getClient().from('projects').delete().ilike('name', cleanSource).eq('user_id', userId);
        await getClient().from('projects').upsert({
          id: target.id,
          user_id: userId,
          name: target.name,
          metadata: mergedMetadata,
          status: 'active',
          updated_at: new Date().toISOString(),
        }, { onConflict: 'user_id, name' });
      } catch {}

      console.log(`[entities] Merged entity "${source.name}" (${source.id}) into "${target.name}" (${target.id}). Tasks moved: ${tasksMovedCount}`);

      return {
        success: true,
        action: 'merged',
        targetEntity: updatedTarget || target,
        tasksMovedCount,
      };
    } catch (err) {
      console.error('[entities] mergeEntities error:', err);
      return { success: false, tasksMovedCount: 0, error: domainErrorMessage(err) };
    }
  }

  /**
   * Maintenance deduplication utility: scans all entities for a user and merges near duplicates.
   *
   * @param {object|string} paramsOrUserId
   * @param {string} [categoryArg]
   * @returns {Promise<{mergedCount: number, details: Array<object>}>}
   */
  async function deduplicateEntities(paramsOrUserId: string | { userId: string; category?: string | undefined }, categoryArg?: string) {
    const userId = typeof paramsOrUserId === 'object' ? paramsOrUserId.userId : paramsOrUserId;
    const category = typeof paramsOrUserId === 'object' ? paramsOrUserId.category : categoryArg;

    if (!userId) return { mergedCount: 0, details: [] };

    try {
      let q = getClient().from('entities').select('*').eq('user_id', userId);
      if (category) q = q.eq('category', category);

      const { data: entities, error } = await q;
      if (error || !entities || entities.length < 2) {
        return { mergedCount: 0, details: [] };
      }

      const details: { source: string; target: string; tasksMoved: number | undefined }[] = [];
      let mergedCount = 0;
      const eliminatedIds = new Set<string>();

      for (let i = 0; i < entities.length; i++) {
        const e1 = entities[i]!;
        if (eliminatedIds.has(e1.id)) continue;

        for (let j = i + 1; j < entities.length; j++) {
          const e2 = entities[j]!;
          if (eliminatedIds.has(e2.id)) continue;

          const score = entityMatchScore(e1.name, e2.name);
          if (score >= 0.88) {
            // Merge e2 into e1 (or whichever has shorter/cleaner name)
            const target = normalizeEntityName(e1.name).length <= normalizeEntityName(e2.name).length ? e1 : e2;
            const source = target.id === e1.id ? e2 : e1;

            const res = await mergeEntities({
              userId,
              sourceName: source.name,
              targetName: target.name,
              category: target.category,
            });

            if (!res.success) return { mergedCount,details,complete: false,errorCode: 'ENTITY_MUTATION_RECONCILIATION_REQUIRED' };
            if (res.success) {
              eliminatedIds.add(source.id);
              mergedCount++;
              details.push({
                source: source.name,
                target: target.name,
                tasksMoved: res.tasksMovedCount,
              });
            }
          }
        }
      }

      return { mergedCount, details };
    } catch (err) {
      console.error('[entities] deduplicateEntities error:', err);
      return { mergedCount: 0, details: [] };
    }
  }

  const renameEntityCascade = renameEntity;
  return { deleteEntities, renameEntity, mergeEntities, deduplicateEntities, renameEntityCascade };
}
