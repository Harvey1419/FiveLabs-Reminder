/**
 * High-Speed Audio Transcription Service.
 * Supports:
 * 1. Groq Whisper (whisper-large-v3-turbo) -> ~150ms transcription speed!
 * 2. Google Gemini Native Multimodal Audio
 * 3. OpenAI / Generic Whisper API
 */

export async function transcribeAudio(audioBuffer, mimeType = 'audio/ogg') {
  if (!audioBuffer || audioBuffer.byteLength === 0) {
    console.warn('[transcription] Empty audio buffer received.');
    return '';
  }

  const groqKey = process.env.GROQ_API_KEY
    || (process.env.AI_API_KEY?.startsWith('gsk_') ? process.env.AI_API_KEY : null);
  const geminiKey = process.env.GEMINI_API_KEY
    || (process.env.AI_API_KEY?.startsWith('AIza') ? process.env.AI_API_KEY : null);

  const startMs = Date.now();

  // 1. PRIMARY: Groq Whisper Turbo (Ultra-fast LPUs ~150-200ms)
  if (groqKey) {
    try {
      const endpoint = 'https://api.groq.com/openai/v1/audio/transcriptions';
      const formData = new FormData();
      const cleanMime = mimeType.split(';')[0].trim() || 'audio/ogg';
      const blob = new Blob([audioBuffer], { type: cleanMime });
      formData.append('file', blob, 'audio.ogg');
      formData.append('model', process.env.AI_AUDIO_MODEL || 'whisper-large-v3-turbo');
      formData.append('language', 'es');
      formData.append('response_format', 'json');

      const res = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${groqKey}`,
        },
        body: formData,
        signal: AbortSignal.timeout(10000),
      });

      if (res.ok) {
        const data = await res.json();
        const text = data.text?.trim() || '';
        if (text) {
          console.log(`[transcription] Audio transcribed via Groq Whisper in ${Date.now() - startMs}ms: "${text}"`);
          return text;
        }
      } else {
        const errText = await res.text();
        console.warn('[transcription] Groq Whisper returned non-200, attempting fallback:', errText);
      }
    } catch (err) {
      console.warn('[transcription] Groq Whisper failed, activating fallback:', err.message);
    }
  }

  // 2. FALLBACK: Google Gemini Native Multimodal Audio (gemini-3.1-flash-lite)
  if (geminiKey) {
    try {
      const base64Data = Buffer.from(audioBuffer).toString('base64');
      const cleanMime = mimeType.split(';')[0].trim() || 'audio/ogg';

      const modelsToTry = ['gemini-3.1-flash-lite', 'gemini-2.5-flash'];
      for (const model of modelsToTry) {
        try {
          const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${geminiKey}`;
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
                      text: 'Transcribe exactamente todo lo que se dice en este audio en español. Devuelve ÚNICAMENTE el texto transcrito sin explicaciones ni etiquetas adicionales.',
                    },
                  ],
                },
              ],
            }),
            signal: AbortSignal.timeout(12000),
          });

          if (res.ok) {
            const data = await res.json();
            const text = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || '';
            if (text) {
              console.log(`[transcription] Audio transcribed via Gemini (${model}) in ${Date.now() - startMs}ms: "${text}"`);
              return text;
            }
          }
        } catch (err) {
          console.warn(`[transcription] Gemini ${model} fallback failed:`, err.message);
        }
      }
    } catch (err) {
      console.error('[transcription] Gemini audio fallback threw:', err);
    }
  }

  // 3. Standard OpenAI Whisper API
  const baseUrl = (process.env.AI_BASE_URL || 'https://api.openai.com/v1').replace(/\/+$/, '');
  try {
    const endpoint = baseUrl.endsWith('/audio/transcriptions')
      ? baseUrl
      : `${baseUrl}/audio/transcriptions`;

    const formData = new FormData();
    const blob = new Blob([audioBuffer], { type: mimeType });
    formData.append('file', blob, 'audio.ogg');
    formData.append('model', process.env.AI_AUDIO_MODEL || 'whisper-1');
    formData.append('language', 'es');

    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${apiKey}` },
      body: formData,
    });

    if (res.ok) {
      const data = await res.json();
      return data.text?.trim() || '';
    }
  } catch (err) {
    console.error('[transcription] Standard Whisper failed:', err);
  }

  return '';
}
