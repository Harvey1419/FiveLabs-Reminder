import { supabase } from './index.js';

/**
 * Clean and normalize entity name by removing accents, lowercasing,
 * and stripping common stop words/noise prefixes (e.g. "proyecto", "de", "el").
 */
export function normalizeEntityName(name) {
  if (!name || typeof name !== 'string') return '';
  let s = name
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();

  // Strip periods in abbreviations/acronyms (e.g. S.A. -> SA)
  s = s.replace(/\./g, '');

  // Replace punctuation/symbols with spaces
  s = s.replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();

  // Remove common noise prefixes
  const noisePrefixes = /^(el\s+proyecto|proyecto|la\s+empresa|empresa|la\s+compania|compania|el|la|los|las|un|una|mi|mis|de|del)\s+/i;
  while (noisePrefixes.test(s)) {
    s = s.replace(noisePrefixes, '').trim();
  }

  return s;
}

/**
 * Levenshtein distance between two strings.
 */
export function levenshteinDistance(s1, s2) {
  const m = s1.length;
  const n = s2.length;
  const dp = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = s1[i - 1] === s2[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + cost
      );
    }
  }
  return dp[m][n];
}

/**
 * Levenshtein similarity ratio between 0.0 and 1.0.
 */
export function levenshteinSimilarity(s1, s2) {
  if (s1 === s2) return 1.0;
  const maxLen = Math.max(s1.length, s2.length);
  if (maxLen === 0) return 1.0;
  const dist = levenshteinDistance(s1, s2);
  return 1.0 - dist / maxLen;
}

/**
 * Jaccard token overlap similarity between 0.0 and 1.0.
 */
export function jaccardSimilarity(s1, s2) {
  const tokens1 = new Set(s1.split(/\s+/).filter(Boolean));
  const tokens2 = new Set(s2.split(/\s+/).filter(Boolean));
  if (tokens1.size === 0 && tokens2.size === 0) return 1.0;
  if (tokens1.size === 0 || tokens2.size === 0) return 0.0;

  let intersection = 0;
  for (const t of tokens1) {
    if (tokens2.has(t)) intersection++;
  }
  const union = new Set([...tokens1, ...tokens2]).size;
  return intersection / union;
}

/**
 * Composite fuzzy match score combining Levenshtein and Jaccard token similarity.
 */
export function entityMatchScore(nameA, nameB) {
  const normA = normalizeEntityName(nameA);
  const normB = normalizeEntityName(nameB);

  if (!normA || !normB) return 0.0;
  if (normA === normB) return 1.0;

  // Substring containment check for prefixes or root words (e.g. "remindersim" & "reminder")
  if (normA.length >= 3 && normB.length >= 3) {
    if (normA.startsWith(normB) || normB.startsWith(normA) || normA.includes(normB) || normB.includes(normA)) {
      const lev = levenshteinSimilarity(normA, normB);
      return Math.max(0.80, lev);
    }
  }

  const lev = levenshteinSimilarity(normA, normB);
  const jac = jaccardSimilarity(normA, normB);
  return Math.max(lev, jac, lev * 0.6 + jac * 0.4);
}

/**
 * Non-aggressive JSONB merge helper: preserves existing values unless new values are non-empty.
 */
export function mergeMetadata(existingMeta = {}, newMeta = {}) {
  const result = { ...(existingMeta || {}) };
  if (!newMeta || typeof newMeta !== 'object') return result;

  for (const [key, value] of Object.entries(newMeta)) {
    if (value !== undefined && value !== null && value !== '') {
      if (
        typeof value === 'object' &&
        !Array.isArray(value) &&
        typeof result[key] === 'object' &&
        !Array.isArray(result[key]) &&
        result[key] !== null
      ) {
        result[key] = mergeMetadata(result[key], value);
      } else {
        result[key] = value;
      }
    }
  }
  return result;
}

/**
 * Find or lazily create an entity using fuzzy matching, normalization, and non-aggressive metadata merge.
 *
 * @param {object} params
 * @param {string} params.userId
 * @param {string} params.name
 * @param {'person'|'company'|'project'|'asset'|'place'|'other'} [params.category='other']
 * @param {object} [params.metadata={}]
 * @param {number} [params.threshold=0.75]
 * @returns {Promise<object|null>}
 */
export async function findOrCreateEntityFuzzy({
  userId,
  name,
  category = 'other',
  metadata = {},
  threshold = 0.75,
}) {
  if (!userId || !name) return null;
  const cleanName = String(name).trim();

  try {
    // 1. Fetch all user's existing entities to match across categories
    const { data: existingList, error: fetchErr } = await supabase
      .from('entities')
      .select('*')
      .eq('user_id', userId);

    if (!fetchErr && existingList && existingList.length > 0) {
      let bestMatch = null;
      let highestScore = 0;

      for (const ent of existingList) {
        // Direct exact or case-insensitive match
        if (ent.name.toLowerCase() === cleanName.toLowerCase()) {
          bestMatch = ent;
          highestScore = 1.0;
          break;
        }

        const score = entityMatchScore(cleanName, ent.name);
        if (score > highestScore) {
          highestScore = score;
          bestMatch = ent;
        }
      }

      if (bestMatch && highestScore >= threshold) {
        // Merge metadata non-aggressively
        if (metadata && Object.keys(metadata).length > 0) {
          const merged = mergeMetadata(bestMatch.metadata, metadata);
          const { data: updated } = await supabase
            .from('entities')
            .update({ metadata: merged, updated_at: new Date().toISOString() })
            .eq('id', bestMatch.id)
            .eq('user_id', userId)
            .select()
            .single();
          return updated || { ...bestMatch, metadata: merged };
        }
        return bestMatch;
      }
    }

    // 2. If no fuzzy match found, create new entity
    const { data: created, error: insertErr } = await supabase
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
      const { data: fallback } = await supabase
        .from('entities')
        .select('*')
        .eq('user_id', userId)
        .eq('name', cleanName)
        .maybeSingle();

      return fallback || null;
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
export async function getOrCreateEntity(params) {
  return findOrCreateEntityFuzzy(params);
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
export async function renameEntity(paramsOrUserId, oldNameArg, newNameArg, categoryArg) {
  const userId = typeof paramsOrUserId === 'object' ? paramsOrUserId.userId : paramsOrUserId;
  const oldName = typeof paramsOrUserId === 'object' ? paramsOrUserId.oldName : oldNameArg;
  const newName = typeof paramsOrUserId === 'object' ? paramsOrUserId.newName : newNameArg;
  const category = typeof paramsOrUserId === 'object' ? paramsOrUserId.category : categoryArg;

  if (!userId || !oldName || !newName) {
    return { success: false, error: 'Missing userId, oldName, or newName' };
  }

  const cleanOld = String(oldName).trim();
  const cleanNew = String(newName).trim();

  try {
    // 1. Find existing entity matching oldName
    const { data: entities, error: fetchErr } = await supabase
      .from('entities')
      .select('*')
      .eq('user_id', userId);

    if (fetchErr || !entities || entities.length === 0) {
      return { success: false, error: 'No entities found for user' };
    }

    let source = null;
    let maxScore = 0;
    for (const ent of entities) {
      if (category && ent.category !== category) continue;
      const score = entityMatchScore(cleanOld, ent.name);
      if (score > maxScore) {
        maxScore = score;
        source = ent;
      }
    }

    if (!source || maxScore < 0.60) {
      return { success: false, error: `Entity "${cleanOld}" not found` };
    }

    // 2. Check if an entity with newName already exists
    let target = null;
    for (const ent of entities) {
      if (ent.id === source.id) continue;
      if (category && ent.category !== category) continue;
      if (normalizeEntityName(ent.name) === normalizeEntityName(cleanNew)) {
        target = ent;
        break;
      }
    }

    if (target) {
      // Merge source into target
      return await mergeEntities({ userId, sourceName: source.name, targetName: target.name, category });
    }

    // 3. Perform rename
    const { data: updated, error: updateErr } = await supabase
      .from('entities')
      .update({
        name: cleanNew,
        updated_at: new Date().toISOString(),
      })
      .eq('id', source.id)
      .eq('user_id', userId)
      .select()
      .single();

    if (updateErr) {
      console.error('[entities] renameEntity update failed:', updateErr);
      return { success: false, error: updateErr.message };
    }

    console.log(`[entities] Renamed entity "${cleanOld}" (id: ${source.id}) -> "${cleanNew}"`);
    return {
      success: true,
      action: 'renamed',
      entity: updated,
      oldName: cleanOld,
      newName: cleanNew,
    };
  } catch (err) {
    console.error('[entities] renameEntity error:', err);
    return { success: false, error: err.message };
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
export async function mergeEntities(paramsOrUserId, sourceNameArg, targetNameArg, categoryArg) {
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
    const { data: entities, error: fetchErr } = await supabase
      .from('entities')
      .select('*')
      .eq('user_id', userId);

    if (fetchErr || !entities || entities.length === 0) {
      return { success: false, tasksMovedCount: 0, error: 'No entities found' };
    }

    let source = null;
    let target = null;
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
      const { data: renamed, error: rErr } = await supabase
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

    // 1. Move all tasks from source to target
    const { data: movedTasks, error: moveErr } = await supabase
      .from('tasks')
      .update({ entity_id: target.id, updated_at: new Date().toISOString() })
      .eq('entity_id', source.id)
      .eq('user_id', userId)
      .select();

    const tasksMovedCount = (movedTasks && movedTasks.length) || 0;

    // 2. Merge metadata
    const mergedMetadata = mergeMetadata(source.metadata, target.metadata);

    const { data: updatedTarget } = await supabase
      .from('entities')
      .update({
        metadata: mergedMetadata,
        updated_at: new Date().toISOString(),
      })
      .eq('id', target.id)
      .eq('user_id', userId)
      .select()
      .single();

    // 3. Delete source entity
    await supabase.from('entities').delete().eq('id', source.id).eq('user_id', userId);

    console.log(`[entities] Merged entity "${source.name}" (${source.id}) into "${target.name}" (${target.id}). Tasks moved: ${tasksMovedCount}`);

    return {
      success: true,
      action: 'merged',
      targetEntity: updatedTarget || target,
      tasksMovedCount,
    };
  } catch (err) {
    console.error('[entities] mergeEntities error:', err);
    return { success: false, tasksMovedCount: 0, error: err.message };
  }
}

/**
 * Maintenance deduplication utility: scans all entities for a user and merges near duplicates.
 *
 * @param {object|string} paramsOrUserId
 * @param {string} [categoryArg]
 * @returns {Promise<{mergedCount: number, details: Array<object>}>}
 */
export async function deduplicateEntities(paramsOrUserId, categoryArg) {
  const userId = typeof paramsOrUserId === 'object' ? paramsOrUserId.userId : paramsOrUserId;
  const category = typeof paramsOrUserId === 'object' ? paramsOrUserId.category : categoryArg;

  if (!userId) return { mergedCount: 0, details: [] };

  try {
    let q = supabase.from('entities').select('*').eq('user_id', userId);
    if (category) q = q.eq('category', category);

    const { data: entities, error } = await q;
    if (error || !entities || entities.length < 2) {
      return { mergedCount: 0, details: [] };
    }

    const details = [];
    let mergedCount = 0;
    const eliminatedIds = new Set();

    for (let i = 0; i < entities.length; i++) {
      const e1 = entities[i];
      if (eliminatedIds.has(e1.id)) continue;

      for (let j = i + 1; j < entities.length; j++) {
        const e2 = entities[j];
        if (eliminatedIds.has(e2.id)) continue;

        const score = entityMatchScore(e1.name, e2.name);
        if (score >= 0.80) {
          // Merge e2 into e1 (or whichever has shorter/cleaner name)
          const target = normalizeEntityName(e1.name).length <= normalizeEntityName(e2.name).length ? e1 : e2;
          const source = target.id === e1.id ? e2 : e1;

          const res = await mergeEntities({
            userId,
            sourceName: source.name,
            targetName: target.name,
            category: target.category,
          });

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

/**
 * Find entities matching user and optional search term.
 *
 * @param {object} params
 * @param {string} params.userId
 * @param {string} [params.query]
 * @param {string} [params.category]
 * @param {number} [params.limit=10]
 * @returns {Promise<Array<object>>}
 */
export async function findEntities({ userId, query, category, limit = 10 }) {
  if (!userId) return [];

  try {
    let q = supabase
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

    return data || [];
  } catch (err) {
    console.error('[entities] findEntities threw:', err);
    return [];
  }
}

/**
 * Get entity by ID for a specific user.
 *
 * @param {string} id
 * @param {string} userId
 * @returns {Promise<object|null>}
 */
export async function getEntityById(id, userId) {
  if (!id || !userId) return null;

  try {
    const { data, error } = await supabase
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
