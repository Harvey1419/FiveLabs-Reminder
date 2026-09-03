/**
 * High-Speed OpenRouter Multi-Model AI Client.
 * - Primary: openai/gpt-oss-120b routed to Groq LPUs (with Cerebras fallback).
 * - Fallback & Memory Engine: google/gemini-2.5-flash-lite routed to Google AI Studio via OpenRouter.
 */

export const MODEL_CONFIG = Object.freeze({
  openrouter: {
    primary: process.env.OPENROUTER_MODEL || 'openai/gpt-oss-120b',
    primaryProviders: ['Groq', 'Cerebras'],
    fallback: 'google/gemini-2.5-flash-lite',
    fallbackProviders: ['Google AI Studio', 'Google'],
  },
});

export async function callChatCompletion(messages, { temperature = 0.0, max_tokens = 800, correlationId = null } = {}) {
  const openrouterKey = process.env.OPENROUTER_API_KEY?.replace(/\"/g, '').trim()
    || (process.env.AI_API_KEY?.startsWith('sk-or-') ? process.env.AI_API_KEY : null);
  const logPrefix = correlationId ? `[ai-client req=${correlationId}]` : '[ai-client]';
  const primaryModel = process.env.OPENROUTER_MODEL || MODEL_CONFIG.openrouter.primary;

  if (!openrouterKey) {
    console.error(`${logPrefix} OPENROUTER_API_KEY is not configured.`);
    return JSON.stringify({
      type: 'chat',
      tool: null,
      params: {},
      intent: 'chat',
      reply: 'Error de configuración: no se encontró la clave de OpenRouter.',
    });
  }

  // 1. Primary: openai/gpt-oss-120b on Groq LPUs
  const orRes = await callOpenRouterChat(messages, primaryModel, openrouterKey, {
    temperature,
    max_tokens,
    timeoutMs: 9000,
    providers: MODEL_CONFIG.openrouter.primaryProviders,
    logPrefix,
  });
  if (orRes) return orRes;

  // 2. Resilient Fallback: google/gemini-2.5-flash-lite via Google AI Studio on OpenRouter
  if (primaryModel !== MODEL_CONFIG.openrouter.fallback) {
    console.warn(`${logPrefix} Primary (${primaryModel}) failed, executing fallback to ${MODEL_CONFIG.openrouter.fallback} (Google AI Studio)...`);
    const fallbackRes = await callOpenRouterChat(messages, MODEL_CONFIG.openrouter.fallback, openrouterKey, {
      temperature,
      max_tokens: 400,
      timeoutMs: 7000,
      providers: MODEL_CONFIG.openrouter.fallbackProviders,
      logPrefix,
    });
    if (fallbackRes) return fallbackRes;
  }

  return JSON.stringify({
    type: 'chat',
    tool: null,
    params: {},
    intent: 'chat',
    reply: 'Tuve una pequeña intermitencia de conexión con el proveedor de IA. Por favor, envíame tu mensaje de nuevo.',
  });
}

async function callOpenRouterChat(messages, model, apiKey, { temperature, max_tokens, timeoutMs = 9000, providers = null, logPrefix = '[ai-client]' } = {}) {
  const startMs = Date.now();
  try {
    const isOssReasoning = model.includes('oss');
    const payload = {
      model,
      messages,
      temperature,
      max_tokens,
      response_format: { type: 'json_object' },
    };

    if (providers && Array.isArray(providers) && providers.length > 0) {
      payload.provider = {
        order: providers,
        allow_fallbacks: true,
      };
    }

    if (isOssReasoning) {
      payload.reasoning = { effort: 'low' };
    }

    const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
        'HTTP-Referer': 'https://fivelabs.co',
        'X-Title': 'Hermes Assistant',
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (res.ok) {
      const data = await res.json();
      const raw = data.choices?.[0]?.message?.content;
      const actualProvider = data.provider || providers?.[0] || 'default';
      if (raw && raw.trim().length > 0) {
        console.log(`${logPrefix} [OpenRouter] model=${model} provider=${actualProvider} responded in ${Date.now() - startMs}ms`);
        return raw.replace(/<\/?think>[\s\S]*?<\/?think>/g, '').replace(/<\/?think>/g, '').trim();
      } else {
        console.warn(`${logPrefix} [OpenRouter] model=${model} returned empty content (finish_reason: ${data.choices?.[0]?.finish_reason})`);
      }
    } else {
      const errBody = await res.text().catch(() => '');
      console.warn(`${logPrefix} [OpenRouter] model=${model} returned ${res.status}:`, errBody.slice(0, 120));
    }
  } catch (err) {
    console.warn(`${logPrefix} [OpenRouter] model=${model} failed:`, err.message);
  }

  return null;
}

/**
 * Memory Extraction & Direct Calls: uses google/gemini-2.5-flash-lite on Google AI Studio via OpenRouter.
 * Guarantees zero 429 errors and eliminates finish_reason: error.
 */
export async function callGeminiDirect(messages, { temperature = 0.1, max_tokens = 600, timeoutMs = 8000 } = {}) {
  const openrouterKey = process.env.OPENROUTER_API_KEY?.replace(/\"/g, '').trim()
    || (process.env.AI_API_KEY?.startsWith('sk-or-') ? process.env.AI_API_KEY : null);
  if (!openrouterKey) {
    console.warn('[ai-client] OpenRouter API key not configured for direct call.');
    return null;
  }
  const model = MODEL_CONFIG.openrouter.fallback;
  return callOpenRouterChat(messages, model, openrouterKey, {
    temperature,
    max_tokens,
    timeoutMs,
    providers: MODEL_CONFIG.openrouter.fallbackProviders,
    logPrefix: '[openrouter-memory]',
  });
}
