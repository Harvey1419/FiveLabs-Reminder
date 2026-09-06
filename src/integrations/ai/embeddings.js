/**
 * Semantic embeddings through the project's single AI gateway.
 * The database contract remains vector(768), so OpenRouter is asked to shorten
 * text-embedding-3-small to 768 dimensions instead of requiring a migration.
 */

function getOpenRouterApiKey() {
  return process.env.OPENROUTER_API_KEY?.replace(/"/g, '').trim()
    || (process.env.AI_API_KEY?.startsWith('sk-or-') ? process.env.AI_API_KEY.trim() : null);
}

export async function generateEmbedding(text) {
  if (!text || typeof text !== 'string' || text.trim().length === 0) return null;
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
        model: 'openai/text-embedding-3-small',
        input: text.trim(),
        dimensions: 768,
        encoding_format: 'float',
      }),
      signal: AbortSignal.timeout(6000),
    });

    if (res.ok) {
      const data = await res.json();
      const embedding = data.data?.[0]?.embedding;
      if (Array.isArray(embedding) && embedding.length === 768) return embedding;
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
