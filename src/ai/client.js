/**
 * High-Speed Multi-Provider AI Client.
 * Routes dynamically based on AI_MODEL (Groq LPUs vs Gemini Native) with seamless fallback.
 */

export async function callChatCompletion(messages, { temperature = 0.0, max_tokens = 1200 } = {}) {
  const geminiKey = process.env.GEMINI_API_KEY || (process.env.AI_API_KEY?.startsWith('AIza') ? process.env.AI_API_KEY : null);
  const groqKey = process.env.GROQ_API_KEY || (process.env.AI_API_KEY?.startsWith('gsk_') ? process.env.AI_API_KEY : null);

  const primaryModel = process.env.AI_MODEL || (groqKey ? 'qwen/qwen3.8-27b' : 'gemini-3.1-flash-lite');
  const fallbackModel = process.env.GEMINI_MODEL || 'gemini-3.1-flash-lite';

  // Determine if primary target is a Groq-hosted model
  const isGroqPrimary = Boolean(
    groqKey && (
      primaryModel.includes('/') ||
      primaryModel.includes('gpt-oss') ||
      primaryModel.includes('llama') ||
      primaryModel.includes('qwen')
    )
  );

  if (isGroqPrimary) {
    // 1. PRIMARY: Groq Ultra-Fast LPUs (~0.4s - 0.8s)
    const groqRes = await callGroqChat(messages, primaryModel, groqKey, { temperature, max_tokens, timeoutMs: 3500 });
    if (groqRes) return groqRes;

    // 2. RESILIENT FALLBACK: Google Gemini Native API (High Quota)
    if (geminiKey) {
      console.log(`[ai-client] Groq primary (${primaryModel}) unavailable, executing fallback to Gemini (${fallbackModel})...`);
      const geminiRes = await callGeminiChat(messages, fallbackModel, geminiKey, { temperature, max_tokens, timeoutMs: 7000 });
      if (geminiRes) return geminiRes;
    }
  } else {
    // 1. PRIMARY: Google Gemini Native API
    if (geminiKey) {
      const geminiRes = await callGeminiChat(messages, primaryModel, geminiKey, { temperature, max_tokens, timeoutMs: 7000 });
      if (geminiRes) return geminiRes;
    }

    // 2. RESILIENT FALLBACK: Groq LPUs
    if (groqKey) {
      console.log(`[ai-client] Gemini primary (${primaryModel}) unavailable, executing fallback to Groq...`);
      const backupGroqModel = process.env.GROQ_MODEL || 'llama-3.3-70b-versatile';
      const groqRes = await callGroqChat(messages, backupGroqModel, groqKey, { temperature, max_tokens, timeoutMs: 3500 });
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

async function callGroqChat(messages, model, apiKey, { temperature, max_tokens, timeoutMs = 4000 } = {}) {
  try {
    const isReasoningModel = model.includes('gpt-oss') || model.includes('r1');
    const payload = {
      model,
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
      console.warn(`[ai-client] Groq (${model}) returned ${res.status}:`, errBody.slice(0, 90));
    }
  } catch (err) {
    console.warn(`[ai-client] Groq (${model}) failed:`, err.message);
  }
  return null;
}

async function callGeminiChat(messages, model, apiKey, { temperature, max_tokens, timeoutMs = 7000 } = {}) {
  const candidateModels = [model, 'gemini-2.5-flash', 'gemini-2.5-flash-lite', 'gemini-flash-latest'].filter(Boolean);
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

      if (contents.length === 0) {
        contents.push({ role: 'user', parts: [{ text: 'Hola' }] });
      }

      const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${targetModel}:generateContent?key=${apiKey}`;
      const payload = {
        ...(systemInstruction ? { systemInstruction } : {}),
        contents,
        generationConfig: {
          responseMimeType: 'application/json',
          temperature,
          maxOutputTokens: max_tokens,
        },
      };

      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(timeoutMs),
      });

      if (res.ok) {
        const data = await res.json();
        const raw = data.candidates?.[0]?.content?.parts?.[0]?.text;
        if (raw) {
          return raw.replace(/<\/?think>[\s\S]*?<\/?think>/g, '').replace(/<\/?think>/g, '').trim();
        }
      } else {
        const errBody = await res.text().catch(() => '');
        console.warn(`[ai-client] Gemini (${targetModel}) returned ${res.status}:`, errBody.slice(0, 100));
      }
    } catch (err) {
      console.warn(`[ai-client] Gemini (${targetModel}) failed:`, err.message);
    }
  }
  return null;
}

export async function callGeminiDirect(messages, { temperature = 0.1, max_tokens = 800, timeoutMs = 5000 } = {}) {
  const geminiKey = process.env.GEMINI_API_KEY || (process.env.AI_API_KEY?.startsWith('AIza') ? process.env.AI_API_KEY : null);
  const model = process.env.GEMINI_MODEL || 'gemini-3.1-flash-lite';
  if (!geminiKey) return null;
  return callGeminiChat(messages, model, geminiKey, { temperature, max_tokens, timeoutMs });
}
