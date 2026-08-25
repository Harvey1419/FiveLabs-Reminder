import { supabase } from './index.js';
import { generateEmbedding } from '../services/embeddingService.js';

/**
 * Save a new memory record, superseding any existing active memory with the same topicKey,
 * and generating a 768-dim vector embedding for semantic search.
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

  try {
    let oldMemoryId = null;

    // 1. If topicKey provided, look for existing active memory to supersede
    if (cleanTopic) {
      const { data: existing } = await supabase
        .from('memories')
        .select('id')
        .eq('user_id', userId)
        .eq('topic_key', cleanTopic)
        .eq('is_active', true)
        .maybeSingle();

      if (existing) {
        oldMemoryId = existing.id;
      }
    }

    // 2. Generate 768-dim semantic embedding in parallel
    const embedding = await generateEmbedding(cleanContent);

    // 3. Insert new memory with embedding
    const insertPayload = {
      user_id: userId,
      topic_key: cleanTopic,
      category,
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

    // 4. Mark old memory as superseded
    if (oldMemoryId && newMem?.id) {
      await supabase
        .from('memories')
        .update({
          is_active: false,
          superseded_by: newMem.id,
        })
        .eq('id', oldMemoryId);
    }

    return newMem;
  } catch (err) {
    console.error('[memories] saveMemory threw:', err);
    return null;
  }
}

/**
 * Hybrid Semantic + Keyword Memory Search:
 * Uses pgvector cosine similarity search combined with keyword matching.
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

  try {
    let vectorResults = [];

    // 1. Semantic Vector Search via pgvector
    if (query) {
      const queryEmbedding = await generateEmbedding(query);
      if (queryEmbedding) {
        const { data: matched, error: rpcErr } = await supabase.rpc('match_memories', {
          p_user_id: userId,
          p_query_embedding: queryEmbedding,
          p_match_threshold: 0.60,
          p_match_count: safeLimit,
        });

        if (!rpcErr && matched) {
          vectorResults = matched;
        }
      }
    }

    // 2. Keyword & Topic search
    let q = supabase
      .from('memories')
      .select('id, topic_key, category, content, confidence, created_at')
      .eq('user_id', userId)
      .eq('is_active', true)
      .limit(safeLimit);

    if (topicKey) {
      q = q.ilike('topic_key', `%${topicKey.trim()}%`);
    }

    if (category) {
      q = q.eq('category', category);
    }

    if (query) {
      const cleanWords = query
        .toLowerCase()
        .replace(/[¿?¡!.,:;()]/g, '')
        .split(/\s+/)
        .filter(w => w.length >= 3 && !['cómo', 'como', 'cuándo', 'cuando', 'dónde', 'donde', 'quién', 'quien', 'para', 'este', 'esta', 'sobre', 'todo'].includes(w));

      if (cleanWords.length > 0) {
        const orClauses = cleanWords.flatMap(w => [
          `content.ilike.%${w}%`,
          `topic_key.ilike.%${w}%`,
        ]).join(',');
        q = q.or(orClauses);
      }
    }

    q = q.order('last_accessed_at', { ascending: false });
    const { data: keywordResults } = await q;

    // 3. Deduplicate and merge results (vector results take precedence for relevance)
    const combinedMap = new Map();
    for (const item of vectorResults) {
      combinedMap.set(item.id, item);
    }
    for (const item of (keywordResults || [])) {
      if (!combinedMap.has(item.id)) {
        combinedMap.set(item.id, item);
      }
    }

    const finalResults = Array.from(combinedMap.values()).slice(0, safeLimit);

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

    // 2. Keyword & semantic search for target memories to delete
    if (query) {
      const cleanWords = query
        .toLowerCase()
        .replace(/[¿?¡!.,:;()]/g, '')
        .replace(/^olvida(?:r)?\s+(?:todo\s+sobre\s+|que\s+|de\s+|lo\s+de\s+|la\s+|el\s+)?/i, '')
        .split(/\s+/)
        .filter(w => w.length >= 3 && !['todo', 'sobre', 'este', 'esta', 'para', 'doctora', 'doctor'].includes(w));

      if (cleanWords.length > 0) {
        const orClauses = cleanWords.flatMap(w => [
          `content.ilike.%${w}%`,
          `topic_key.ilike.%${w}%`,
        ]).join(',');

        const { data: kwMatches } = await supabase
          .from('memories')
          .select('id, content, topic_key')
          .eq('user_id', userId)
          .or(orClauses);

        if (kwMatches) candidates.push(...kwMatches);
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
