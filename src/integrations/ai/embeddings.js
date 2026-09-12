/**
 * Semantic embeddings through the project's single AI gateway.
 * The database contract remains vector(768), so OpenRouter is asked to shorten
 * text-embedding-3-small to 768 dimensions instead of requiring a migration.
 * OPENROUTER_EMBEDDING_API_KEY can isolate this workload from the foreground
 * model key; the foreground key remains the fallback for compatibility.
 */

function getOpenRouterApiKey() {
  return process.env.OPENROUTER_EMBEDDING_API_KEY?.replace(/"/g, '').trim()
    || process.env.OPENROUTER_API_KEY?.replace(/"/g, '').trim()
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
        dimensions: 768,
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
      if (embeddings.length === input.length && embeddings.every((embedding) => Array.isArray(embedding) && embedding.length === 768)) {
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

export async function generateEmbedding(text) {
  if (!text || typeof text !== 'string' || text.trim().length === 0) return null;
  const cleanText = text.trim();
  const embeddings = await requestEmbeddings([cleanText], cleanText);
  return embeddings?.[0] || null;
}
