/**
 * High-Speed Multi-Provider AI Client.
 * Routes dynamically based on AI_MODEL (Groq LPUs vs Gemini Native) with seamless fallback.
 */

export const MODEL_CONFIG = Object.freeze({
  groq: {
    primary: process.env.GROQ_MODEL || 'openai/gpt-oss-20b',
    reasoning: 'openai/gpt-oss-120b',
    fallbackLadder: [
      'openai/gpt-oss-20b',
      'openai/gpt-oss-120b',
    ],
  },
  gemini: {
    primary: process.env.GEMINI_MODEL || 'gemini-2.5-flash',
    fallbackLadder: ['gemini-2.5-flash', 'gemini-2.5-flash-lite', 'gemini-flash-latest'],
  },
});

export async function callChatCompletion(messages, { temperature = 0.0, max_tokens = 1200, correlationId = null } = {}) {
  const geminiKey = process.env.GEMINI_API_KEY || (process.env.AI_API_KEY?.startsWith('AIza') ? process.env.AI_API_KEY : null);
  const groqKey = process.env.GROQ_API_KEY || (process.env.AI_API_KEY?.startsWith('gsk_') ? process.env.AI_API_KEY : null);

  const primaryModel = process.env.AI_MODEL || (groqKey ? MODEL_CONFIG.groq.primary : MODEL_CONFIG.gemini.primary);
  const fallbackModel = MODEL_CONFIG.gemini.primary;

  const logPrefix = correlationId ? `[ai-client req=${correlationId}]` : '[ai-client]';

  // Determine if primary target is a Groq-hosted model
  const isGroqPrimary = Boolean(
    groqKey && (
      primaryModel.includes('/') ||
      primaryModel.includes('gpt-oss') ||
      primaryModel.includes('llama') ||
      primaryModel.includes('qwen') ||
      primaryModel.includes('compound')
    )
  );

  if (isGroqPrimary) {
    // 1. PRIMARY: Groq Ultra-Fast LPUs (~0.1s - 0.5s)
    const groqRes = await callGroqChat(messages, primaryModel, groqKey, { temperature, max_tokens, timeoutMs: 4000, logPrefix });
    if (groqRes) return groqRes;

    // 2. RESILIENT FALLBACK: Google Gemini Native API (High Quota)
    if (geminiKey) {
      console.log(`${logPrefix} Groq primary (${primaryModel}) unavailable, executing fallback to Gemini (${fallbackModel})...`);
      const geminiRes = await callGeminiChat(messages, fallbackModel, geminiKey, { temperature, max_tokens, timeoutMs: 12000, logPrefix });
      if (geminiRes) return geminiRes;
    }
  } else {
    // 1. PRIMARY: Google Gemini Native API
    if (geminiKey) {
      const geminiRes = await callGeminiChat(messages, primaryModel, geminiKey, { temperature, max_tokens, timeoutMs: 12000, logPrefix });
      if (geminiRes) return geminiRes;
    }

    // 2. RESILIENT FALLBACK: Groq LPUs
    if (groqKey) {
      console.log(`${logPrefix} Gemini primary (${primaryModel}) unavailable, executing fallback to Groq...`);
      const backupGroqModel = MODEL_CONFIG.groq.primary;
      const groqRes = await callGroqChat(messages, backupGroqModel, groqKey, { temperature, max_tokens, timeoutMs: 6000, logPrefix });
      if (groqRes) return groqRes;
    }
  }

  // 3. Graceful fallback when all providers are unavailable
  return JSON.stringify({
    type: 'chat',
    tool: null,
    params: {},
    intent: 'chat',
    reply: 'Tuve una pequeña intermitencia de conexión en este momento. Por favor, envíame tu mensaje de nuevo.',
  });
}

async function callGroqChat(messages, model, apiKey, { temperature, max_tokens, timeoutMs = 4000, logPrefix = '[ai-client]' } = {}) {
  const candidateModels = Array.from(new Set([model, ...MODEL_CONFIG.groq.fallbackLadder])).filter(Boolean);

  for (const targetModel of candidateModels) {
    try {
      const isReasoningModel = targetModel.includes('gpt-oss') || targetModel.includes('r1');
      const payload = {
        model: targetModel,
        messages,
        temperature,
        max_tokens: isReasoningModel ? undefined : max_tokens,
        max_completion_tokens: isReasoningModel ? max_tokens : undefined,
        response_format: { type: 'json_object' },
      };

      const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(timeoutMs),
      });

      if (res.ok) {
        const data = await res.json();
        const raw = data.choices?.[0]?.message?.content;
        if (raw) {
          return raw.replace(/<\/?think>[\s\S]*?<\/?think>/g, '').replace(/<\/?think>/g, '').trim();
        }
      } else {
        const errBody = await res.text().catch(() => '');
        console.warn(`${logPrefix} Groq (${targetModel}) returned ${res.status}:`, errBody.slice(0, 90));
      }
    } catch (err) {
      console.warn(`${logPrefix} Groq (${targetModel}) failed:`, err.message);
    }
  }
  return null;
}

async function callGeminiChat(messages, model, apiKey, { temperature, max_tokens, timeoutMs = 7000, logPrefix = '[ai-client]' } = {}) {
  const candidateModels = Array.from(new Set([model, ...MODEL_CONFIG.gemini.fallbackLadder])).filter(Boolean);
  const tried = new Set();

  for (const targetModel of candidateModels) {
    if (tried.has(targetModel)) continue;
    tried.add(targetModel);

    try {
      let systemInstruction = null;
      const contents = [];

      for (const m of messages) {
        if (m.role === 'system') {
          systemInstruction = { parts: [{ text: m.content }] };
        } else if (m.role === 'user') {
          contents.push({ role: 'user', parts: [{ text: m.content }] });
        } else if (m.role === 'assistant') {
          contents.push({ role: 'model', parts: [{ text: m.content }] });
        }
      }

      const payload = {
        contents,
        generationConfig: {
          temperature,
          maxOutputTokens: max_tokens,
          responseMimeType: 'application/json',
        },
      };

      if (systemInstruction) {
        payload.systemInstruction = systemInstruction;
      }

      const cleanModel = targetModel.replace(/^models\//, '');
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${cleanModel}:generateContent?key=${apiKey}`;

      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(timeoutMs),
      });

      if (res.ok) {
        const data = await res.json();
        const candidate = data.candidates?.[0];
        const raw = candidate?.content?.parts?.[0]?.text;
        if (raw) {
          return raw.trim();
        }
      } else {
        const errBody = await res.text().catch(() => '');
        console.warn(`${logPrefix} Gemini (${targetModel}) returned ${res.status}:`, errBody.slice(0, 90));
      }
    } catch (err) {
      console.warn(`${logPrefix} Gemini (${targetModel}) failed:`, err.message);
    }
  }

  return null;
}

export async function callGeminiDirect(messages, { temperature = 0.1, max_tokens = 800, timeoutMs = 8000 } = {}) {
  const geminiKey = process.env.GEMINI_API_KEY || (process.env.AI_API_KEY?.startsWith('AIza') ? process.env.AI_API_KEY : null);
  if (!geminiKey) {
    console.warn('[ai-client] Gemini API key not configured for direct call.');
    return null;
  }
  const defaultModel = MODEL_CONFIG.gemini.primary || 'gemini-2.5-flash';
  return callGeminiChat(messages, defaultModel, geminiKey, {
    temperature,
    max_tokens,
    timeoutMs,
    logPrefix: '[gemini-direct]',
  });
}
