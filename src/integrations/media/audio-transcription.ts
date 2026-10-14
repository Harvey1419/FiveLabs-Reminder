export type AudioInput = Blob | Buffer | ArrayBuffer | Uint8Array | string | null | undefined;
export interface TranscriptionDependencies { getEnv(): NodeJS.ProcessEnv; getNowMs(): number; fetch: typeof fetch; logger: Pick<Console, 'log' | 'warn'> }

export function createAudioTranscription({ getEnv, getNowMs, fetch, logger }: TranscriptionDependencies) {
/**
 * High-Speed Audio Transcription Service.
 * Supports:
 * 1. Groq Whisper (whisper-large-v3-turbo) -> ~150-250ms transcription speed!
 * 2. OpenRouter speech-to-text fallback
 */

async function transcribeAudio(audioInput: AudioInput, mimeType = 'audio/ogg', { language = 'es', prompt = null }: { language?: string | null; prompt?: string | null } = {}) {
  if (!audioInput) {
    logger.warn('[transcription] Empty audio input received.');
    return '';
  }

  const cleanMime = mimeType.split(';')[0]!.trim() || 'audio/ogg';
  const blob = (audioInput instanceof Blob) ? audioInput : new Blob([audioInput as NonNullable<ConstructorParameters<typeof Blob>[0]>[number]], { type: cleanMime });
  if (blob.size === 0) {
    logger.warn('[transcription] Empty audio blob received.');
    return '';
  }

  const groqKey = getEnv().GROQ_API_KEY
    || (getEnv().AI_API_KEY?.startsWith('gsk_') ? getEnv().AI_API_KEY : null);
  const openRouterKey = getEnv().OPENROUTER_API_KEY?.replace(/"/g, '').trim()
    || (getEnv().AI_API_KEY?.startsWith('sk-or-') ? (getEnv().AI_API_KEY as string).trim() : null);

  const startMs = getNowMs();
  const effectiveLang = language || 'es';
  const domainPrompt = prompt || (effectiveLang.startsWith('en')
    ? 'Hermes, reminder, schedule, calendar, tasks, appointments.'
    : 'Hermes, recordatorio, agenda, tareas, calendario, citas.');

  // 1. PRIMARY: Groq Whisper Turbo (Ultra-fast LPUs ~150-250ms)
  if (groqKey) {
    try {
      const endpoint = 'https://api.groq.com/openai/v1/audio/transcriptions';
      const formData = new FormData();
      formData.append('file', blob, 'audio.ogg');
      formData.append('model', getEnv().AI_AUDIO_MODEL || 'whisper-large-v3-turbo');
      if (effectiveLang && effectiveLang !== 'auto') {
        formData.append('language', effectiveLang.slice(0, 2));
      }
      formData.append('prompt', domainPrompt);
      formData.append('response_format', 'json');

      const res = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${groqKey}`,
        },
        body: formData,
        signal: AbortSignal.timeout(5000),
      });

      if (res.ok) {
        const data = await res.json() as { text?: string | null };
        const text = data.text?.trim() || '';
        if (text) {
          logger.log(`[transcription] Groq Whisper Turbo transcribed in ${getNowMs() - startMs}ms: "${text}"`);
          return text;
        }
      } else {
        const errText = await res.text();
        logger.warn('[transcription] Groq Whisper returned non-200, attempting fallback:', errText.slice(0, 100));
      }
    } catch (err) {
      logger.warn('[transcription] Groq Whisper failed, activating fallback:', (err as { message?: string }).message);
    }
  }

  // 2. FALLBACK: OpenRouter's dedicated speech-to-text endpoint.
  if (openRouterKey) {
    try {
      const arrayBuffer = await blob.arrayBuffer();
      const base64Data = Buffer.from(arrayBuffer).toString('base64');
      const format = cleanMime.split('/')[1]?.split('+')[0] || 'ogg';
      const model = 'openai/whisper-large-v3';
      const res = await fetch('https://openrouter.ai/api/v1/audio/transcriptions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${openRouterKey}`,
          'HTTP-Referer': 'https://fivelabs.co',
          'X-Title': 'Hermes Assistant',
        },
        body: JSON.stringify({
          model,
          input_audio: { data: base64Data, format },
          language: effectiveLang ? effectiveLang.slice(0, 2) : 'es',
          temperature: 0,
        }),
        signal: AbortSignal.timeout(6000),
      });

      if (res.ok) {
        const data = await res.json() as { text?: string | null };
        const text = data.text?.trim() || '';
        if (text) {
          logger.log(`[transcription] [OpenRouter] model=${model} transcribed in ${getNowMs() - startMs}ms: "${text}"`);
          return text;
        }
      } else {
        const errText = await res.text();
        logger.warn(`[transcription] [OpenRouter] model=${model} returned ${res.status}:`, errText.slice(0, 100));
      }
    } catch (err) {
      logger.warn('[transcription] OpenRouter audio fallback failed:', (err as { message?: string }).message);
    }
  }

  return '';
}

return { transcribeAudio };
}
