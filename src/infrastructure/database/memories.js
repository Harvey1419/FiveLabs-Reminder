import { compileDispatchPolicy, reduceDispatchRules } from '../../features/reminders/dispatch-policy.js';
import { supabase } from './index.js';
import { generateEmbedding } from '../../integrations/ai/embeddings.js';

/**
 * Save a new memory record, superseding any existing active memory with the same topicKey.
 * Exact repeats are idempotent; new versions receive a 768-dim search embedding.
 *
 * @param {object} params
 * @param {string} params.userId
 * @param {string} [params.topicKey]
 * @param {'fact'|'preference'|'decision'|'episode'|'observation'} [params.category='fact']
 * @param {string} params.content
 * @param {number} [params.confidence=1.0]
 * @param {string|Date} [params.validUntil]
 * @returns {Promise<object|null>}
 */
const VALID_MEM_CATEGORIES = new Set(['fact', 'preference', 'decision', 'episode', 'observation', 'project']);
const MEMORY_VECTOR_MATCH_THRESHOLD = 0.20;
const MEMORY_VECTOR_CANDIDATE_MULTIPLIER = 4;
const MEMORY_VECTOR_MIN_CANDIDATES = 12;
const MEMORY_VECTOR_MAX_CANDIDATES = 50;
const MEMORY_VECTOR_RELATIVE_WINDOW = 0.05;

/**
 * The topic is part of the retrieval document, not user-visible memory content.
 * Stable structured identity improves broad-query recall without interpreting
 * natural language in Node.
 */
export function buildMemoryEmbeddingDocument(topicKey, content) {
  const cleanContent = String(content || '').trim();
  const cleanTopic = topicKey ? String(topicKey).trim().toLowerCase() : '';
  return cleanTopic ? `${cleanTopic}\n${cleanContent}` : cleanContent;
}

/**
 * Deterministically preserve semantic rank while removing structural repeats.
 * Node only understands IDs, exact content, topic identities, and numeric
 * provider scores; it never reinterprets the user's language.
 */
export function selectMemorySearchResults({
  vectorResults = [],
  ftsResults = [],
  topicResults = [],
  limit = 5,
  category = null,
}) {
  const safeLimit = Math.min(Math.max(1, Number(limit) || 5), 20);
  const rankedVectors = vectorResults.filter((item) => (
    item?.is_active !== false && (!category || item?.category === category)
  )).sort(
    (a, b) => (Number(b?.similarity) || 0) - (Number(a?.similarity) || 0),
  );
  const topSimilarity = Number(rankedVectors[0]?.similarity);
  const relevantVectors = Number.isFinite(topSimilarity)
    ? rankedVectors.filter((item) => (
      Number.isFinite(Number(item?.similarity))
      && Number(item.similarity) >= topSimilarity - MEMORY_VECTOR_RELATIVE_WINDOW
    ))
    : rankedVectors;
  const seenIds = new Set();
  const seenTopics = new Set();
  const seenContents = new Set();
  const selected = [];

  const rankedSources = relevantVectors.length > 0
    ? [...relevantVectors, ...ftsResults, ...topicResults]
    : [...ftsResults, ...topicResults];

  for (const item of rankedSources) {
    if (!item?.id || item.is_active === false) continue;
    if (category && item.category !== category) continue;

    const topicIdentity = item.topic_key ? String(item.topic_key).trim().toLowerCase() : null;
    const contentIdentity = item.content ? String(item.content).trim().toLowerCase() : null;
    if (seenIds.has(item.id)) continue;
    if (topicIdentity && seenTopics.has(topicIdentity)) continue;
    if (contentIdentity && seenContents.has(contentIdentity)) continue;

    seenIds.add(item.id);
    if (topicIdentity) seenTopics.add(topicIdentity);
    if (contentIdentity) seenContents.add(contentIdentity);
    selected.push(item);
    if (selected.length >= safeLimit) break;
  }

  return selected;
}

export async function saveMemory({
  userId,
  topicKey = null,
  category = 'fact',
  content,
  confidence = 1.0,
  validUntil = null,
}) {
  if (!userId || !content) return null;
  const cleanContent = String(content).trim();
  const cleanTopic = topicKey ? String(topicKey).trim().toLowerCase() : null;

  // Ensure category satisfies SQL constraint (fact, preference, decision, episode, observation)
  const rawCat = String(category || 'fact').trim().toLowerCase();
  const safeCategory = VALID_MEM_CATEGORIES.has(rawCat) ? rawCat : 'fact';

  try {
    let activeVersions = [];

    // 1. Load every active version for the structured identity. Avoid
    // maybeSingle(): legacy duplicates must not disable future reconciliation.
    if (cleanTopic) {
      const { data: existing, error: existingError } = await supabase
        .from('memories')
        .select('id, user_id, topic_key, category, content, confidence, is_active, valid_from, valid_until, superseded_by, last_accessed_at, created_at')
        .eq('user_id', userId)
        .eq('topic_key', cleanTopic)
        .eq('is_active', true)
        .order('created_at', { ascending: false })
        .limit(50);

      if (existingError) {
        console.warn('[memories] active identity lookup failed:', existingError.message);
        return null;
      } else {
        activeVersions = existing || [];
      }

      // Exact content under the same structured identity is idempotent. The
      // semantic extractor owns paraphrase equivalence; Node does not guess it.
      const identical = activeVersions.find((memory) => String(memory.content).trim() === cleanContent);
      if (identical) {
        const duplicateIds = activeVersions.filter((memory) => memory.id !== identical.id).map((memory) => memory.id);
        if (duplicateIds.length > 0) {
          const { error: reconcileError } = await supabase
            .from('memories')
            .update({ is_active: false, superseded_by: identical.id })
            .eq('user_id', userId)
            .eq('topic_key', cleanTopic)
            .eq('is_active', true)
            .in('id', duplicateIds);
          if (reconcileError) console.warn('[memories] duplicate identity reconciliation failed:', reconcileError.message);
        }
        if (isReminderPolicyMemory(identical)) {
          triggerEagerReminderReconciliation(userId);
        }
        return identical;
      }
    }

    // 2. Generate 768-dim semantic embedding in parallel
    const embedding = await generateEmbedding(buildMemoryEmbeddingDocument(cleanTopic, cleanContent));

    // 3. Insert new memory with embedding
    const insertPayload = {
      user_id: userId,
      topic_key: cleanTopic,
      category: safeCategory,
      content: cleanContent,
      confidence,
      is_active: true,
      valid_until: validUntil ? new Date(validUntil).toISOString() : null,
      embedding: embedding || null,
    };

    const { data: newMem, error: insertErr } = await supabase
      .from('memories')
      .insert(insertPayload)
      .select()
      .single();

    if (insertErr) {
      console.error('[memories] saveMemory insert failed:', insertErr);
      return null;
    }

    // 4. A material change creates one new active version and preserves every
    // previous version as history. Ownership and identity remain explicit.
    if (activeVersions.length > 0 && newMem?.id) {
      const previousIds = activeVersions.map((memory) => memory.id);
      const { error: supersedeError } = await supabase
        .from('memories')
        .update({
          is_active: false,
          superseded_by: newMem.id,
        })
        .eq('user_id', userId)
        .eq('topic_key', cleanTopic)
        .eq('is_active', true)
        .in('id', previousIds);
      if (supersedeError) {
        console.error('[memories] previous version supersede failed:', supersedeError);
        const { error: rollbackError } = await supabase
          .from('memories')
          .delete()
          .eq('user_id', userId)
          .eq('id', newMem.id);
        if (rollbackError) console.error('[memories] new version rollback failed:', rollbackError);
        return null;
      }
    }

    if (newMem && isReminderPolicyMemory(newMem)) {
      triggerEagerReminderReconciliation(userId);
    }

    return newMem;
  } catch (err) {
    console.error('[memories] saveMemory threw:', err);
    return null;
  }
}

/**
 * Fetch all active durable memories for a user ordered by created_at DESC.
 *
 * @param {object} params
 * @param {string} params.userId
 * @param {string} [params.category]
 * @param {number} [params.limit=15]
 * @returns {Promise<Array<object>>}
 */
function isDatabaseConfigured() {
  const url = process.env.SUPABASE_URL || '';
  const secret = process.env.SUPABASE_SECRET || '';
  const isMock = Boolean(supabase?.from?._isMockFunction || supabase?.from?.mock);
  return Boolean(
    (isMock || (url && !url.includes('placeholder') && secret && !secret.includes('placeholder')))
    && typeof supabase?.from === 'function'
  );
}

export async function getActiveMemories({ userId, category = null, limit = 15 }) {
  if (!userId || !isDatabaseConfigured()) return [];
  const safeLimit = Math.min(Math.max(1, Number(limit) || 15), 50);

  try {
    let q = supabase
      .from('memories')
      .select('id, topic_key, category, content, confidence, created_at')
      .eq('user_id', userId)
      .eq('is_active', true)
      .order('created_at', { ascending: false })
      .limit(safeLimit);

    if (category) {
      q = q.eq('category', category);
    }

    const { data, error } = await q;
    if (error) {
      console.warn('[memories] getActiveMemories error:', error.message);
      return [];
    }
    return data || [];
  } catch (err) {
    console.error('[memories] getActiveMemories threw:', err);
    return [];
  }
}

/** Retrieves standing profile/preference candidates before applying the limit. */
export async function getStandingMemories({ userId, limit = 30, legacyFactAspects = [] }) {
  if (!userId) return { data: [], error: null };
  if (!isDatabaseConfigured()) return { data: null, error: new Error('Memory storage is unavailable.') };
  const safeLimit = Math.min(Math.max(1, Number(limit) || 30), 50);
  const legacyAspectFilters = [...new Set(legacyFactAspects)]
    .filter((aspect) => /^[a-z0-9_-]+$/i.test(aspect))
    .map((aspect) => `and(category.eq.fact,topic_key.like.%/${aspect})`);
  const standingMemoryFilter = [
    'category.eq.preference',
    'topic_key.like.profile/%',
    'topic_key.like.preference/%',
    ...legacyAspectFilters,
  ].join(',');
  try {
    const { data, error } = await supabase
      .from('memories')
      .select('id, topic_key, category, content, confidence, created_at')
      .eq('user_id', userId)
      .eq('is_active', true)
      .or(standingMemoryFilter)
      .order('created_at', { ascending: false })
      .limit(safeLimit);
    return error ? { data: null, error } : { data: data || [], error: null };
  } catch (error) {
    return { data: null, error };
  }
}

/**
 * Hybrid Semantic (pgvector) + Full-Text Search (tsvector with Spanish Snowball/Porter stemming) Memory Search:
 * Combines dense vector similarity with sparse stemmed keyword matching.
 *
 * @param {object} params
 * @param {string} params.userId
 * @param {string} [params.query]
 * @param {string} [params.topicKey]
 * @param {string} [params.category]
 * @param {number} [params.limit=5]
 * @returns {Promise<Array<object>>}
 */
export async function searchMemories({
  userId,
  query = null,
  topicKey = null,
  category = null,
  limit = 5,
  throwOnError = false,
  withStatus = false,
}) {
  if (!userId) return [];
  if (throwOnError && !isDatabaseConfigured()) throw new Error('Memory storage is unavailable.');
  const safeLimit = Math.min(Math.max(1, Number(limit) || 5), 20);
  const vectorCandidateLimit = Math.min(
    Math.max(safeLimit * MEMORY_VECTOR_CANDIDATE_MULTIPLIER, MEMORY_VECTOR_MIN_CANDIDATES),
    MEMORY_VECTOR_MAX_CANDIDATES,
  );

  // If no specific query and no topicKey provided, return all active memories
  if (!query && !topicKey) {
    return getActiveMemories({ userId, category, limit: safeLimit });
  }

  try {
    let vectorResults = [];
    let ftsResults = [];
    let topicResults = [];

    // Execute Vector Search, Full-Text Search, and Topic Search in parallel
    const searchTasks = [];

    // 1. Semantic Vector Search via pgvector
    if (query) {
      searchTasks.push(
        (async () => {
          try {
            const queryEmbedding = await generateEmbedding(query);
            if (!queryEmbedding && throwOnError) throw new Error('Memory embedding is unavailable.');
            if (queryEmbedding) {
              const { data: matched, error: rpcErr } = await supabase.rpc('match_memories', {
                p_user_id: userId,
                p_query_embedding: queryEmbedding,
                p_match_threshold: MEMORY_VECTOR_MATCH_THRESHOLD,
                p_match_count: vectorCandidateLimit,
              });
              if (rpcErr && throwOnError) throw rpcErr;
              if (!rpcErr && matched) return { type: 'vector', data: matched };
            }
          } catch (err) {
            if (throwOnError) throw err;
            console.warn('[memories] vector search err:', err.message);
          }
          return { type: 'vector', data: [] };
        })()
      );
    }

    // 2. Full-Text Search (tsvector + Spanish Porter/Snowball stemming via PostgREST textSearch)
    if (query) {
      searchTasks.push(
        (async () => {
          try {
            const cleanFtsQuery = String(query).replace(/[¿?¡!.,:;()]/g, ' ').trim();
            if (cleanFtsQuery.length > 0) {
              let ftsQ = supabase
                .from('memories')
                .select('id, topic_key, category, content, confidence, created_at')
                .eq('user_id', userId)
                .eq('is_active', true)
                .textSearch('content', cleanFtsQuery, {
                  config: 'spanish',
                  type: 'websearch',
                })
                .order('last_accessed_at', { ascending: false })
                .limit(safeLimit);

              if (category) {
                ftsQ = ftsQ.eq('category', category);
              }

              const { data: ftsData, error: ftsErr } = await ftsQ;
              if (ftsErr && throwOnError) throw ftsErr;
              if (!ftsErr && ftsData) return { type: 'fts', data: ftsData };
            }
          } catch (err) {
            if (throwOnError) throw err;
            console.warn('[memories] FTS search err:', err.message);
          }
          return { type: 'fts', data: [] };
        })()
      );
    }

    // 3. Topic Key match
    if (topicKey) {
      searchTasks.push(
        (async () => {
          try {
            let tQ = supabase
              .from('memories')
              .select('id, topic_key, category, content, confidence, created_at')
              .eq('user_id', userId)
              .eq('is_active', true)
              .ilike('topic_key', `%${topicKey.trim()}%`)
              .order('last_accessed_at', { ascending: false })
              .limit(safeLimit);

            if (category) {
              tQ = tQ.eq('category', category);
            }

            const { data: tData, error: tErr } = await tQ;
            if (tErr && throwOnError) throw tErr;
            if (tData) return { type: 'topic', data: tData };
          } catch (err) {
            if (throwOnError) throw err;
            console.warn('[memories] topic search err:', err.message);
          }
          return { type: 'topic', data: [] };
        })()
      );
    }

    const settled = await Promise.allSettled(searchTasks);
    const taskResults = settled.filter(result => result.status === 'fulfilled').map(result => result.value);
    if (!taskResults.length && throwOnError) throw new Error('All memory retrieval channels are unavailable.');
    const retrievalStatus = taskResults.length === settled.length ? 'available' : 'partial';
    for (const res of taskResults) {
      if (res.type === 'vector') vectorResults = res.data;
      else if (res.type === 'fts') ftsResults = res.data;
      else if (res.type === 'topic') topicResults = res.data;
    }

    // 4. Semantic similarity remains authoritative for rank. Sparse and topic
    // matches are fallbacks, while exact structural identities are diversified.
    const finalResults = selectMemorySearchResults({
      vectorResults,
      ftsResults,
      topicResults,
      category,
      limit: safeLimit,
    });

    // Update last_accessed_at asynchronously
    if (finalResults.length > 0) {
      const ids = finalResults.map(m => m.id);
      supabase.from('memories')
        .update({ last_accessed_at: new Date().toISOString() })
        .in('id', ids)
        .then(() => {})
        .catch(() => {});
    }

    return withStatus ? { status: retrievalStatus, memories: finalResults } : finalResults;
  } catch (err) {
    if (throwOnError) throw err;
    console.error('[memories] searchMemories threw:', err);
    return [];
  }
}

/**
 * Permanently delete or invalidate memories for Right to Forget compliance.
 *
 * @param {object} params
 * @param {string} params.userId
 * @param {string} [params.topicKey]
 * @param {string} [params.query]
 * @returns {Promise<{deletedCount: number, deletedMemories: Array<object>}>}
 */
export async function forgetMemories({ userId, topicKey = null, query = null, selectCandidates = null, correlationId = null }) {
  const empty = { deletedCount: 0, deletedMemories: [] };
  if (!userId || (!topicKey?.trim() && !query?.trim())) return { ...empty, success: false, errorCode: 'INVALID_PARAMETERS' };
  let writeStarted = false;

  try {
    let candidates = [];

    // 1. Direct topic match
    if (topicKey) {
      const { data, error } = await supabase
        .from('memories')
        .select('id, content, topic_key, category')
        .eq('user_id', userId)
        .eq('topic_key', topicKey.trim().toLowerCase());
      if (error) throw error;
      if (data) candidates.push(...data);
    }

    // 2. FTS & semantic search for target memories to delete
    if (query) {
      const cleanFtsQuery = String(query).trim();

      if (cleanFtsQuery.length > 0) {
        // FTS textSearch with spanish stemming
        const { data: ftsMatches, error: ftsError } = await supabase
          .from('memories')
          .select('id, content, topic_key, category')
          .eq('user_id', userId)
          .textSearch('content', cleanFtsQuery, {
            config: 'spanish',
            type: 'websearch',
          });

        if (ftsError) throw ftsError;
        if (ftsMatches) candidates.push(...ftsMatches);

        // Fallback ilike on topic_key
        const { data: topicMatches, error: topicError } = await supabase
          .from('memories')
          .select('id, content, topic_key, category')
          .eq('user_id', userId)
          .ilike('topic_key', `%${cleanFtsQuery}%`);

        if (topicError) throw topicError;
        if (topicMatches) candidates.push(...topicMatches);
      }

      // Also vector search
      const queryEmbedding = await generateEmbedding(query);
      if (queryEmbedding) {
        const { data: vecMatches, error: vectorError } = await supabase.rpc('match_memories', {
          p_user_id: userId,
          p_query_embedding: queryEmbedding,
          p_match_threshold: 0.50,
          p_match_count: 5,
        });
        if (vectorError) throw vectorError;
        if (vecMatches) candidates.push(...vecMatches);
      }
    }

    // Deduplicate candidate IDs
    const uniqueMap = new Map();
    for (const c of candidates) {
      uniqueMap.set(c.id, c);
    }
    const uniqueCandidates = Array.from(uniqueMap.values());

    if (uniqueCandidates.length === 0) {
      return { ...empty, success: true };
    }

    const ownedIds = new Set(uniqueCandidates.map(c => c.id));
    const ids = query ? await selectCandidates?.(uniqueCandidates) : [...ownedIds];
    if (!Array.isArray(ids) || new Set(ids).size !== ids.length || ids.some(id => !ownedIds.has(id))) {
      return { ...empty, success: false, errorCode: 'MEMORY_SELECTION_UNAVAILABLE' };
    }
    if (!ids.length) return { ...empty, success: true };
    writeStarted = true;
    const { data: deleted, error: delErr } = await supabase
      .from('memories')
      .delete()
      .eq('user_id', userId)
      .in('id', ids)
      .select('id, content, topic_key, category');

    if (delErr) {
      console.error('[memories] forgetMemories delete error:', delErr);
      return { ...empty, success: false, errorCode: 'DATABASE_ERROR', outcome: 'unknown' };
    }
    if (!Array.isArray(deleted)) throw new Error('Missing deletion receipt');
    console.log(`[memory-delete] ${JSON.stringify({ correlationId, userId, deletedCount: deleted.length, deletedMemories: deleted })}`);

    if (deleted.some((m) => isReminderPolicyMemory(m))) {
      triggerEagerReminderReconciliation(userId);
    }

    return {
      success: true,
      deletedCount: deleted.length,
      deletedMemories: deleted,
    };
  } catch (err) {
    console.error('[memories] forgetMemories threw:', err);
    return { ...empty, success: false, errorCode: 'DATABASE_ERROR', ...(writeStarted ? { outcome: 'unknown' } : {}) };
  }
}

export async function forgetMemoriesByTopic(userId, topicKey) {
  const res = await forgetMemories({ userId, topicKey });
  return res?.deletedCount || 0;
}

/**
 * Retrieve the active reminder dispatch policy for a user based on their stored preferences/memories.
 * Adapts deterministic behavior dynamically:
 * - disableButtonsForRecurring: suppresses interactive buttons on recurring reminders if user requested it.
 * - requiresConfirmation: whether standard reminders require persistent confirmation nudges.
 * - nudgeIntervalMinutes: interval for confirmation nudges.
 *
 * @param {string} userId
 * @returns {Promise<{ global: object, recurring: object, disableButtonsForRecurring: boolean, disableNudgesForRecurring: boolean, requiresConfirmation: boolean, nudgeIntervalMinutes: number, preferenceText?: string }>}
 */
export async function getReminderDispatchPolicy(userId) {
  if (!userId) return reduceDispatchRules();
  const { data, error } = await supabase.from('memories').select('id, content, created_at, valid_until')
    .eq('user_id', userId).eq('is_active', true).eq('category', 'preference')
    .order('created_at', { ascending: false }).limit(101);
  if (error || !Array.isArray(data)) throw new Error(error?.message || 'Preference read unavailable');
  if (data.length > 100) throw new Error('Incomplete preference snapshot');
  const preferences = data.filter(item => !item.valid_until || new Date(item.valid_until).getTime() > Date.now());
  return compileDispatchPolicy({ userId, preferences });
}

/**
 * Check if the user has an active preference for persistent confirmation reminders.
 *
 * @param {string} userId
 * @param {object} [options]
 * @param {boolean} [options.isRecurring=false]
 * @returns {Promise<{ requiresConfirmation: boolean, nudgeIntervalMinutes?: number, preferenceText?: string }|null>}
 */
export async function getReminderConfirmationPreference(userId, { isRecurring = false } = {}) {
  if (!userId) return null;
  const policy = await getReminderDispatchPolicy(userId);
  const targetScope = isRecurring ? policy.recurring : policy.global;
  if (!targetScope?.requiresConfirmation) return null;
  return {
    requiresConfirmation: true,
    nudgeIntervalMinutes: targetScope.nudgeIntervalMinutes,
    preferenceText: policy.preferenceText,
  };
}

/**
 * Fast domain gate: determines if a memory object or candidate affects reminder dispatch policies.
 *
 * @param {object} memory
 * @returns {boolean}
 */
export function isReminderPolicyMemory(memory) {
  // Structural invalidation only. The compiler decides relevance semantically.
  return memory?.category === 'preference';
}

/**
 * Reconcile pending reminders for a user against their current hierarchical dispatch policy.
 * Scoped strictly to pending reminders belonging to `userId`.
 *
 * @param {string} userId
 * @returns {Promise<{ updatedCount: number, policy: object }>}
 */
export async function reconcileRemindersWithPolicy(userId) {
  if (!userId) return { updatedCount: 0, policy: null };

  try {
    const policy = await getReminderDispatchPolicy(userId);
    let updatedCount = 0;

    // 1. RECURRING REMINDERS:
    // If recurring nudges are disabled, heal pending recurring reminders to requires_confirmation: false
    if (policy?.recurring?.disableNudges || policy?.disableNudgesForRecurring) {
      const { data, error } = await supabase
        .from('reminders')
        .update({
          requires_confirmation: false,
          nudge_count: 0,
          last_nudged_at: null,
        })
        .eq('user_id', userId)
        .eq('status', 'pending')
        .not('recurrence_rule', 'is', null)
        .eq('requires_confirmation', true)
        .select('id');

      if (error) {
        console.warn(`[memories] failed to reconcile recurring reminders for user ${userId}:`, error.message);
      } else if (data?.length > 0) {
        updatedCount += data.length;
        console.log(`[memories] eagerly healed ${data.length} recurring reminder(s) (requires_confirmation -> false) for user ${userId}`);
      }
    }

    // 2. GLOBAL / NON-RECURRING REMINDERS:
    // If global confirmation is explicitly disabled, heal pending non-recurring reminders
    if (policy?.explicit?.global?.requiresConfirmation === false || policy?.explicit?.global?.disableNudges === true) {
      const { data, error } = await supabase
        .from('reminders')
        .update({
          requires_confirmation: false,
          nudge_count: 0,
          last_nudged_at: null,
        })
        .eq('user_id', userId)
        .eq('status', 'pending')
        .is('recurrence_rule', null)
        .eq('requires_confirmation', true)
        .select('id');

      if (error) {
        console.warn(`[memories] failed to reconcile non-recurring reminders for user ${userId}:`, error.message);
      } else if (data?.length > 0) {
        updatedCount += data.length;
        console.log(`[memories] eagerly healed ${data.length} non-recurring reminder(s) (requires_confirmation -> false) for user ${userId}`);
      }
    } else if (policy?.explicit?.global?.nudgeIntervalMinutes && policy.global.requiresConfirmation) {
      // If global confirmation is enabled and interval was adjusted
      const { data, error } = await supabase
        .from('reminders')
        .update({
          nudge_interval_minutes: policy.global.nudgeIntervalMinutes,
        })
        .eq('user_id', userId)
        .eq('status', 'pending')
        .is('recurrence_rule', null)
        .eq('requires_confirmation', true)
        .neq('nudge_interval_minutes', policy.global.nudgeIntervalMinutes)
        .select('id');

      if (!error && data?.length > 0) {
        updatedCount += data.length;
        console.log(`[memories] updated nudge interval on ${data.length} non-recurring reminder(s) for user ${userId}`);
      }
    }

    return { updatedCount, policy };
  } catch (err) {
    console.warn(`[memories] reconcileRemindersWithPolicy threw for user ${userId}:`, err.message);
    return { updatedCount: 0, policy: null };
  }
}

/**
 * Non-blocking eager trigger that schedules reconciliation in Node's background loop.
 *
 * @param {string} userId
 */
export function triggerEagerReminderReconciliation(userId) {
  if (!userId) return;
  setImmediate(async () => {
    try {
      await reconcileRemindersWithPolicy(userId);
    } catch (err) {
      console.warn('[memories] triggerEagerReminderReconciliation background error:', err?.message || err);
    }
  });
}
