import type { JsonObject } from '@templelabs/contracts';
import { domainErrorMessage,type DomainPersistenceClient } from './domain-persistence-client.js';
import { inspectEntityReferenceSnapshot,selectEntityCandidate,mergeMetadata,type EntityReference } from './entity-resolution.js';
export interface CreateEntityInput { userId: string; name: string; category?: string; metadata?: JsonObject | null; threshold?: number }
/** Creation, owner-scoped reads and mirrors; destructive entity workflows remain a separate migration. */
export function createEntityPersistence(getClient: () => DomainPersistenceClient) {
  async function inspectOwnedEntityReferences({ userId, references = [] }: { userId: string; references?: readonly EntityReference[] }) {
    if (!userId) {
      return { success: false, errorCode: 'INVALID_PARAMETERS', error: 'Missing userId.', resolutions: [] };
    }

    try {
      const { data, error } = await getClient()
        .from('entities')
        .select('id, name, category')
        .eq('user_id', userId);
      if (error) {
        return { success: false, errorCode: 'DATABASE_ERROR', error: domainErrorMessage(error), resolutions: [] };
      }

      const entities = data || [];
      return {
        success: true,
        resolutions: inspectEntityReferenceSnapshot(entities, references),
      };
    } catch (error) {
      return { success: false, errorCode: 'DATABASE_ERROR', error: domainErrorMessage(error), resolutions: [] };
    }
  }

  async function findOrCreateEntityFuzzy({
    userId,
    name,
    category = 'other',
    metadata = {},
    threshold = 0.75,
  }: CreateEntityInput) {
    if (!userId || !name) return null;
    const cleanName = String(name).trim();

    try {
      // 1. Fetch all user's existing entities to match across categories
      const { data: existingList, error: fetchErr } = await getClient()
        .from('entities')
        .select('*')
        .eq('user_id', userId);

      if (!fetchErr && existingList && existingList.length > 0) {
        const selected = selectEntityCandidate(existingList, cleanName, { category, threshold });
        if (selected.status === 'RESOLVED') {
          const bestMatch = selected.entity;
          const merged = mergeMetadata(bestMatch.metadata, metadata);
          const shouldRefineCategory = bestMatch.category === 'other' && category && category !== 'other';
          const shouldUpdateMetadata = metadata && Object.keys(metadata).length > 0;
          if (shouldRefineCategory || shouldUpdateMetadata) {
            const updates: JsonObject = { metadata: merged, updated_at: new Date().toISOString() };
            if (shouldRefineCategory) updates.category = category;
            const { data: updated } = await getClient()
              .from('entities')
              .update(updates)
              .eq('id', bestMatch.id)
              .eq('user_id', userId)
              .select()
              .single();
            const resEntity = updated || { ...bestMatch, ...updates };
            if (resEntity.category === 'project') {
              try {
                await getClient().from('projects').upsert({
                  id: resEntity.id,
                  user_id: userId,
                  name: resEntity.name,
                  metadata: resEntity.metadata || {},
                  status: 'active',
                }, { onConflict: 'user_id, name' });
              } catch {
                // Non-fatal
              }
            }
            return resEntity;
          }

          if (bestMatch.category === 'project') {
            try {
              await getClient().from('projects').upsert({
                id: bestMatch.id,
                user_id: userId,
                name: bestMatch.name,
                metadata: bestMatch.metadata || {},
                status: 'active',
              }, { onConflict: 'user_id, name' });
            } catch {
              // Non-fatal
            }
          }
          return bestMatch;
        }
      }

      // 2. If no fuzzy match found, create new entity
      const { data: created, error: insertErr } = await getClient()
        .from('entities')
        .insert({
          user_id: userId,
          name: cleanName,
          category: category || 'other',
          metadata: metadata || {},
        })
        .select()
        .single();

      if (insertErr) {
        // In case of unique constraint race, fallback to query
        const { data: fallback } = await getClient()
          .from('entities')
          .select('*')
          .eq('user_id', userId)
          .eq('name', cleanName)
          .maybeSingle();

        if (fallback?.id && fallback.category === 'project') {
          try {
            await getClient().from('projects').upsert({
              id: fallback.id,
              user_id: userId,
              name: fallback.name,
              metadata: fallback.metadata || {},
              status: 'active',
            }, { onConflict: 'user_id, name' });
          } catch {
            // Non-fatal
          }
        }

        return fallback || null;
      }

      if (created?.id && category === 'project') {
        try {
          await getClient().from('projects').upsert({
            id: created.id,
            user_id: userId,
            name: created.name,
            metadata: created.metadata || {},
            status: 'active',
          }, { onConflict: 'user_id, name' });
        } catch {
          // Non-fatal
        }
      }

      return created;
    } catch (err) {
      console.error('[entities] findOrCreateEntityFuzzy threw:', err);
      return null;
    }
  }

  /**
   * Backward compatibility alias for findOrCreateEntityFuzzy.
   */
  async function getOrCreateEntity(params: CreateEntityInput) {
    return findOrCreateEntityFuzzy(params);
  }

  async function findEntities({ userId, query, category, limit = 10 }: { userId: string; query?: string; category?: string; limit?: number }) {
    if (!userId) return [];

    try {
      let q = getClient()
        .from('entities')
        .select('*')
        .eq('user_id', userId)
        .order('updated_at', { ascending: false })
        .limit(limit);

      if (query) {
        q = q.ilike('name', `%${query.trim()}%`);
      }

      if (category) {
        q = q.eq('category', category);
      }

      const { data, error } = await q;
      if (error) {
        console.error('[entities] findEntities error:', error);
        return [];
      }

      const entityItems = (data || []).slice();

      if (!category || category === 'project') {
        try {
          let pq = getClient()
            .from('projects')
            .select('*')
            .eq('user_id', userId)
            .eq('status', 'active')
            .limit(limit);
          if (query) {
            pq = pq.ilike('name', `%${query.trim()}%`);
          }
          const { data: activeProjects } = await pq;
          if (activeProjects && activeProjects.length > 0) {
            const knownIds = new Set(entityItems.map((e) => e.id));
            const knownNames = new Set(entityItems.map((e) => e.name.toLowerCase().trim()));
            for (const proj of activeProjects) {
              if (!knownIds.has(proj.id) && !knownNames.has(proj.name.toLowerCase().trim())) {
                entityItems.push({
                  id: proj.id,
                  user_id: proj.user_id,
                  name: proj.name,
                  category: 'project',
                  metadata: proj.metadata || {},
                  created_at: proj.created_at,
                  updated_at: proj.updated_at,
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
          for (const e of entityItems) {
            if (e.category === 'project' || !e.category) {
              e.taskCount = countsById.get(e.id) || 0;
            }
          }
        } catch {
          for (const e of entityItems) {
            if (e.category === 'project' && e.taskCount === undefined) {
              e.taskCount = 0;
            }
          }
        }
      }

      return entityItems;
    } catch (err) {
      console.error('[entities] findEntities threw:', err);
      return [];
    }
  }

  const getEntitiesByUser = findEntities;

  /**
   * Get entity by ID for a specific user.
   *
   * @param {string} id
   * @param {string} userId
   * @returns {Promise<object|null>}
   */
  async function getEntityById(id: string, userId: string) {
    if (!id || !userId) return null;

    try {
      const { data, error } = await getClient()
        .from('entities')
        .select('*')
        .eq('id', id)
        .eq('user_id', userId)
        .maybeSingle();

      if (error) {
        console.error('[entities] getEntityById error:', error);
        return null;
      }

      return data;
    } catch (err) {
      console.error('[entities] getEntityById threw:', err);
      return null;
    }
  }

  return { inspectOwnedEntityReferences, findOrCreateEntityFuzzy, getOrCreateEntity, findEntities, getEntitiesByUser, getEntityById };
}
