/**
 * High-performance vector embeddings service using Gemini embeddings (768 dimensions).
 */

const GEMINI_KEY = process.env.GEMINI_API_KEY || (process.env.AI_API_KEY?.startsWith('AIza') ? process.env.AI_API_KEY : null);

export async function generateEmbedding(text) {
  if (!text || typeof text !== 'string' || text.trim().length === 0) return null;
  const apiKey = GEMINI_KEY || process.env.GEMINI_API_KEY || (process.env.AI_API_KEY?.startsWith('AIza') ? process.env.AI_API_KEY : null);

  if (!apiKey) {
    console.warn('[embeddingService] GEMINI_API_KEY missing, skipping vector embedding.');
    return null;
  }

  try {
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-001:embedContent?key=${apiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'models/gemini-embedding-001',
        content: { parts: [{ text: text.trim() }] },
        outputDimensionality: 768,
      }),
      signal: AbortSignal.timeout(6000),
    });

    if (res.ok) {
      const data = await res.json();
      return data.embedding?.values || null;
    } else {
      const err = await res.text();
      console.warn('[embeddingService] embedding request failed:', err.slice(0, 100));
      return null;
    }
  } catch (err) {
    console.warn('[embeddingService] generateEmbedding failed:', err.message);
    return null;
  }
}
