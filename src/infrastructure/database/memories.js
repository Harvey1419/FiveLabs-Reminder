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
export async function getActiveMemories({ userId, category = null, limit = 15 }) {
  if (!userId) return [];
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
}) {
  if (!userId) return [];
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
            if (queryEmbedding) {
              const { data: matched, error: rpcErr } = await supabase.rpc('match_memories', {
                p_user_id: userId,
                p_query_embedding: queryEmbedding,
                p_match_threshold: MEMORY_VECTOR_MATCH_THRESHOLD,
                p_match_count: vectorCandidateLimit,
              });
              if (!rpcErr && matched) return { type: 'vector', data: matched };
            }
          } catch (err) {
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
              if (!ftsErr && ftsData) return { type: 'fts', data: ftsData };
            }
          } catch (err) {
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

            const { data: tData } = await tQ;
            if (tData) return { type: 'topic', data: tData };
          } catch (err) {
            console.warn('[memories] topic search err:', err.message);
          }
          return { type: 'topic', data: [] };
        })()
      );
    }

    const taskResults = await Promise.all(searchTasks);
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

    return finalResults;
  } catch (err) {
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
export async function forgetMemories({ userId, topicKey = null, query = null }) {
  if (!userId) return { deletedCount: 0, deletedMemories: [] };

  try {
    let candidates = [];

    // 1. Direct topic match
    if (topicKey) {
      const { data } = await supabase
        .from('memories')
        .select('id, content, topic_key')
        .eq('user_id', userId)
        .ilike('topic_key', `%${topicKey.trim().toLowerCase()}%`);
      if (data) candidates.push(...data);
    }

    // 2. FTS & semantic search for target memories to delete
    if (query) {
      const cleanFtsQuery = String(query)
        .replace(/[¿?¡!.,:;()]/g, ' ')
        .replace(/^olvida(?:r)?\s+(?:todo\s+sobre\s+|que\s+|de\s+|lo\s+de\s+|la\s+|el\s+)?/i, '')
        .trim();

      if (cleanFtsQuery.length > 0) {
        // FTS textSearch with spanish stemming
        const { data: ftsMatches } = await supabase
          .from('memories')
          .select('id, content, topic_key')
          .eq('user_id', userId)
          .textSearch('content', cleanFtsQuery, {
            config: 'spanish',
            type: 'websearch',
          });

        if (ftsMatches) candidates.push(...ftsMatches);

        // Fallback ilike on topic_key
        const { data: topicMatches } = await supabase
          .from('memories')
          .select('id, content, topic_key')
          .eq('user_id', userId)
          .ilike('topic_key', `%${cleanFtsQuery}%`);

        if (topicMatches) candidates.push(...topicMatches);
      }

      // Also vector search
      const queryEmbedding = await generateEmbedding(query);
      if (queryEmbedding) {
        const { data: vecMatches } = await supabase.rpc('match_memories', {
          p_user_id: userId,
          p_query_embedding: queryEmbedding,
          p_match_threshold: 0.50,
          p_match_count: 5,
        });
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
      return { deletedCount: 0, deletedMemories: [] };
    }

    const ids = uniqueCandidates.map(c => c.id);
    const { error: delErr } = await supabase
      .from('memories')
      .delete()
      .in('id', ids);

    if (delErr) {
      console.error('[memories] forgetMemories delete error:', delErr);
      return { deletedCount: 0, deletedMemories: [] };
    }

    console.log(`[memories] Forgot/deleted ${ids.length} memories for user ${userId}`);
    return {
      deletedCount: ids.length,
      deletedMemories: uniqueCandidates,
    };
  } catch (err) {
    console.error('[memories] forgetMemories threw:', err);
    return { deletedCount: 0, deletedMemories: [] };
  }
}

export async function forgetMemoriesByTopic(userId, topicKey) {
  const res = await forgetMemories({ userId, topicKey });
  return res?.deletedCount || 0;
}
