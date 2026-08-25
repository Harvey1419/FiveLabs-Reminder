/**
 * Multimodal Document & Image Processing Service.
 * Analyzes photos, receipts, screenshots, itineraries, and PDF documents.
 */

const GEMINI_KEY = process.env.GEMINI_API_KEY
  || process.env.AI_API_KEY;

export async function processDocumentOrImage(buffer, mimeType = 'image/jpeg', caption = '') {
  if (!buffer || buffer.byteLength === 0) return '';

  const apiKey = GEMINI_KEY && GEMINI_KEY.startsWith('AIza')
    ? GEMINI_KEY
    : (process.env.GEMINI_API_KEY || process.env.AI_API_KEY);

  if (!apiKey || !apiKey.startsWith('AIza')) {
    console.warn('[documentService] Gemini API key required for vision/PDF extraction.');
    return caption || '';
  }

  const cleanMime = mimeType.split(';')[0].trim() || 'image/jpeg';
  const base64Data = Buffer.from(buffer).toString('base64');

  const systemInstruction = `Eres un extractor de información visual y documental para un asistente personal en WhatsApp.
Analiza la imagen o documento adjunto y extrae de forma estructurada y detallada en español:
1. Fechas, horas y eventos mencionados.
2. Tareas, compromisos, citas médicas, vuelos o vuelos/itinerarios.
3. Personas, nombres, importes o datos clave.
4. Si el usuario incluyó una instrucción (${caption ? `"${caption}"` : 'ninguna'}), intégrala.

Devuelve un resumen claro del contenido visual/documental para que el asistente pueda agendar y responder.`;

  const primaryModel = process.env.AI_MODEL || 'gemini-3.1-flash-lite';
  const modelsToTry = [primaryModel, 'gemini-2.5-flash'];

  for (const model of modelsToTry) {
    try {
      const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [
            {
              parts: [
                {
                  inlineData: {
                    mimeType: cleanMime,
                    data: base64Data,
                  },
                },
                {
                  text: caption
                    ? `Instrucción del usuario: "${caption}". ${systemInstruction}`
                    : systemInstruction,
                },
              ],
            },
          ],
        }),
      });

      if (res.ok) {
        const data = await res.json();
        const extracted = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
        if (extracted) {
          return extracted;
        }
      }
    } catch (err) {
      console.warn(`[documentService] Model ${model} failed:`, err.message);
    }
  }

  return caption || '';
}
