/**
 * Semantic embeddings through the project's single AI gateway.
 * The database contract remains vector(768), so OpenRouter is asked to shorten
 * text-embedding-3-small to 768 dimensions instead of requiring a migration.
 */

import { AsyncLocalStorage } from 'node:async_hooks';

const queryEmbeddingContext = new AsyncLocalStorage();
const QUERY_EMBEDDING_CAPACITY = 32;
const MEMORY_EMBEDDING_DIMENSIONS = 768;

/** Ephemeral vector reuse only; database reads and memory writes are never cached. */
export function withQueryEmbeddingScope(userId, work) {
  return queryEmbeddingContext.run({ userId, entries: new Map() }, work);
}

/** Capture only this store, never execution leases or other ambient authority. */
export function captureQueryEmbeddingScope(work) {
  const context = queryEmbeddingContext.getStore();
  return (...args) => queryEmbeddingContext.run(context, () => work(...args));
}

function getOpenRouterApiKey() {
  return process.env.OPENROUTER_API_KEY?.replace(/"/g, '').trim()
    || (process.env.AI_API_KEY?.startsWith('sk-or-') ? process.env.AI_API_KEY.trim() : null);
}

export const MEMORY_EMBEDDING_MODEL = 'openai/text-embedding-3-small';

async function requestEmbeddings(input, requestInput = input) {
  const apiKey = getOpenRouterApiKey();

  if (!apiKey) {
    console.warn('[embeddingService] OPENROUTER_API_KEY missing, skipping vector embedding.');
    return null;
  }

  try {
    const res = await fetch('https://openrouter.ai/api/v1/embeddings', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
        'HTTP-Referer': 'https://fivelabs.co',
        'X-Title': 'Hermes Assistant',
      },
      body: JSON.stringify({
        model: MEMORY_EMBEDDING_MODEL,
        input: requestInput,
        dimensions: MEMORY_EMBEDDING_DIMENSIONS,
        encoding_format: 'float',
      }),
      signal: AbortSignal.timeout(6000),
    });

    if (res.ok) {
      const data = await res.json();
      const embeddings = (data.data || [])
        .slice()
        .sort((a, b) => a.index - b.index)
        .map((item) => item.embedding);
      if (embeddings.length === input.length && embeddings.every((embedding) => Array.isArray(embedding) && embedding.length === MEMORY_EMBEDDING_DIMENSIONS)) {
        return embeddings;
      }
      console.warn('[embeddingService] OpenRouter returned an invalid embedding shape.');
      return null;
    } else {
      const err = await res.text();
      console.warn(`[embeddingService] OpenRouter embedding request returned ${res.status}:`, err.slice(0, 100));
      return null;
    }
  } catch (err) {
    console.warn('[embeddingService] generateEmbedding failed:', err.message);
    return null;
  }
}

export async function generateEmbeddings(texts) {
  const input = (Array.isArray(texts) ? texts : [])
    .map((text) => (typeof text === 'string' ? text.trim() : ''));
  if (input.length === 0 || input.some((text) => text.length === 0)) return null;
  return requestEmbeddings(input);
}

export async function generateEmbedding(text, { queryOwner } = {}) {
  if (!text || typeof text !== 'string' || text.trim().length === 0) return null;
  const cleanText = text.trim();
  const context = queryEmbeddingContext.getStore();
  const requestVector = async () => (await requestEmbeddings([cleanText], cleanText))?.[0] || null;
  // Legacy calls, including save embeddings, bypass query reuse even for equal text.
  if (!queryOwner || context?.userId !== queryOwner) return requestVector();

  const key = JSON.stringify([queryOwner, MEMORY_EMBEDDING_MODEL, MEMORY_EMBEDDING_DIMENSIONS, cleanText]);
  let pending = context.entries.get(key);
  if (!pending) {
    if (context.entries.size >= QUERY_EMBEDDING_CAPACITY) {
      context.entries.delete(context.entries.keys().next().value);
    }
    pending = requestVector().then(vector => {
      if (!vector && context.entries.get(key) === pending) context.entries.delete(key);
      return vector;
    }, error => {
      if (context.entries.get(key) === pending) context.entries.delete(key);
      throw error;
    });
    context.entries.set(key, pending);
  }
  const vector = await pending;
  return vector ? vector.slice() : null;
}
