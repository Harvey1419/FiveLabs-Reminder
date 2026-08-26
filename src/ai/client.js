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
      const geminiRes = await callGeminiChat(messages, fallbackModel, geminiKey, { temperature, max_tokens, timeoutMs: 4500 });
      if (geminiRes) return geminiRes;
    }
  } else {
    // 1. PRIMARY: Google Gemini Native API
    if (geminiKey) {
      const geminiRes = await callGeminiChat(messages, primaryModel, geminiKey, { temperature, max_tokens, timeoutMs: 4500 });
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

  // 3. FINAL RESILIENT NLP FALLBACK (0ms)
  return heuristicPlanner(messages);
}

async function callGroqChat(messages, model, apiKey, { temperature, max_tokens, timeoutMs = 4000 } = {}) {
  try {
    const isReasoningModel = model.includes('gpt-oss') || model.includes('r1');
    const payload = {
      model,
      messages,
      temperature,
      max_tokens: Math.max(max_tokens, 1500),
      ...(isReasoningModel ? { reasoning_effort: 'low' } : {}),
    };

    const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
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

async function callGeminiChat(messages, model, apiKey, { temperature, max_tokens, timeoutMs = 6000 } = {}) {
  const candidateModels = [model, 'gemini-3.1-flash-lite', 'gemini-2.5-flash'].filter(Boolean);
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

function heuristicPlanner(input) {
  const text = Array.isArray(input)
    ? input.filter(m => m.role === 'user').pop()?.content || ''
    : String(input || '');

  const recentHistory = Array.isArray(input) ? input.slice(-6) : [];
  const historyText = recentHistory.map(m => m.content).join(' ').toLowerCase();
  const isShoppingContext = historyText.includes('compras') || historyText.includes('mercado') || historyText.includes('supermercado');

  const t = text.toLowerCase().trim();

  // 0. Acknowledgment & Closure of Reminders ("Ok", "Listo", "OK", "Hecho", "Ya", "Terminado", "Done", "Got it")
  if (t === 'ok' || t === 'listo' || t === 'hecho' || t === 'ya' || t === 'terminado' || t === 'done' || t === 'got it' || t === 'listo gracias' || t === 'ok gracias') {
    return JSON.stringify({
      type: 'tool_call',
      tool: 'manage_reminder',
      params: { action: 'acknowledge' },
      intent: 'reminder',
      reply: '¡Excelente! Recordatorio completado y desactivados los avisos pendientes. 👍',
    });
  }

  // 1. Deletion / Cancellation of Reminders or Tasks
  if (t.includes('elimina') || t.includes('borra') || t.includes('cancela') || t.includes('quitar') || t.includes('eliminar') || t.includes('borrar') || t.includes('cancelar')) {
    if (t.includes('recordatorio') || t.includes('recordatorios') || t.includes('alarmas') || t.includes('aviso')) {
      const cancelAll = t.includes('todos') || t.includes('todo') || t.includes('todas');
      const keepLatest = t.includes('solo 1') || t.includes('solo uno') || t.includes('dejarme solo') || t.includes('dejar solo') || t.includes('deja solo') || t.includes('dejarme el último') || t.includes('dejar el ultimo');
      const cleanContent = text.replace(/^(?:por\s+fa(?:vor)?\s+)?(?:podr[ií]as\s+)?(?:eliminar|elimina|borrar|borra|cancelar|cancela)\s+(?:el\s+recordatorio\s+de\s+)?/i, '').trim();

      return JSON.stringify({
        type: 'tool_call',
        tool: 'manage_reminder',
        params: {
          action: 'cancel',
          content: cancelAll || keepLatest ? null : cleanContent,
          cancelAll,
          keepLatest,
        },
        intent: 'reminder',
        reply: keepLatest ? '¡Listo! Eliminé los recordatorios anteriores y te dejé solo el último 🗑️⏰' : '¡Listo! Eliminé los recordatorios solicitados 🗑️',
      });
    }

    if (t.includes('tarea') || t.includes('tareas')) {
      return JSON.stringify({
        type: 'tool_call',
        tool: 'manage_task',
        params: { action: 'complete', title: text },
        intent: 'task',
        reply: '¡Excelente! Marqué la tarea como completada ✅',
      });
    }
  }

  // 2. Queries about pending tasks, scheduled reminders, or questions asking WHEN
  if (
    t.includes('a qué hora') || t.includes('a que hora') || t.includes('a qué horas') || t.includes('a que horas') ||
    t.includes('cuándo') || t.includes('cuando') || t.includes('qué hora') || t.includes('que hora') ||
    t.includes('me vas a recordar') || t.includes('vas a recordar') ||
    t.includes('guardaste') || t.includes('mis recordatorios') || t.includes('qué recordatorios') ||
    t.includes('qué tengo pendiente') || t.includes('que tengo pendiente') || t.includes('mis tareas') || t.includes('ver tareas') ||
    t.includes('todas las tareas') || t.includes('priorízamelas') || t.includes('prioriza') ||
    t.includes('agenda de mañana') || t.includes('agenda de hoy') || t.includes('qué hay para hoy')
  ) {
    return JSON.stringify({
      type: 'chat',
      tool: null,
      params: {},
      intent: 'query',
      reply: 'Consultando tus pendientes y recordatorios activos...',
    });
  }

  // 3. Task / List item creation
  const taskMatch = t.match(/(?:añade|agrega|crea|nueva tarea|también|adem[aá]s)\s+(?:la tarea\s+)?(?:de\s+)?(.+)/i);
  if (taskMatch || isShoppingContext) {
    let rawItemsText = taskMatch ? taskMatch[1].trim() : text;
    let entityName = isShoppingContext ? 'Lista de compras' : null;

    if (rawItemsText.includes(' con ') && !isShoppingContext) {
      const parts = rawItemsText.split(' con ');
      rawItemsText = parts[0];
      entityName = parts[1]?.trim();
    }

    // Split multiple items if separated by "y", "y también", commas
    const rawTokens = rawItemsText.split(/,|\by\s+(?:tambi[eé]n\s+)?(?:agrega\s+)?/i).map(s => s.trim()).filter(Boolean);
    const items = rawTokens.map(title => ({
      title: title.replace(/^(?:tambi[eé]n|agrega|y|adem[aá]s)\s+/i, '').trim(),
      entityName,
      entityCategory: isShoppingContext ? 'compras' : 'general',
    })).filter(it => it.title.length > 0);

    const formattedTitles = items.map(it => `• ${it.title}`).join('\n');
    const entityLabel = entityName ? ` a tu ${entityName}` : '';

    return JSON.stringify({
      type: 'tool_call',
      tool: 'manage_task',
      params: {
        action: 'create',
        items: items.length > 0 ? items : [{ title: rawItemsText, entityName }],
      },
      intent: 'task',
      reply: `¡Anotado! Añadido${entityLabel}:\n\n${formattedTitles || rawItemsText} 📋`,
    });
  }

  // 4. Reminders creation
  if (t.includes('recuerda') || t.includes('recuérdame') || t.includes('recuerdame') || t.includes('recordar') || t.includes('programa')) {
    const { content, delayMs } = extractReminderDetails(text);
    return JSON.stringify({
      type: 'tool_call',
      tool: 'manage_reminder',
      params: {
        action: 'create',
        items: [{
          content,
          targetTime: new Date(Date.now() + delayMs).toISOString(),
        }],
      },
      intent: 'reminder',
      reply: `¡Listo! Te recordaré "${content}" ⏰`,
    });
  }

  // 5. Greetings
  if (t === 'hola' || t.startsWith('hola ') || t.startsWith('buenos')) {
    return JSON.stringify({
      type: 'chat',
      tool: null,
      params: {},
      intent: 'greeting',
      reply: '¡Hola! 👋 ¿En qué te puedo ayudar hoy?',
    });
  }

  return JSON.stringify({
    type: 'chat',
    tool: null,
    params: {},
    intent: 'chat',
    reply: '¡Entendido! Lo tengo presente en tus notas.',
  });
}

function extractReminderDetails(rawText) {
  let text = rawText.trim();
  let delayMs = 30 * 60 * 1000;

  const timeRegex = /\ben\s+(?:un[ao]?|media|\d+)\s*(?:hora|horas|minuto|minutos|segundo|segundos|d[ií]a|d[ií]as|semana|semanas)\b/i;
  const match = text.match(timeRegex);

  if (match) {
    const timePhrase = match[0].toLowerCase();
    text = text.replace(match[0], '').trim();

    if (timePhrase.includes('media hora')) {
      delayMs = 30 * 60 * 1000;
    } else if (timePhrase.includes('un hora') || timePhrase.includes('una hora') || timePhrase.includes('uno hora') || timePhrase.includes('1 hora')) {
      delayMs = 60 * 60 * 1000;
    } else {
      const numMatch = timePhrase.match(/\d+/);
      const num = numMatch ? parseInt(numMatch[0], 10) : 1;
      if (timePhrase.includes('minuto')) delayMs = num * 60 * 1000;
      else if (timePhrase.includes('hora')) delayMs = num * 60 * 60 * 1000;
      else if (timePhrase.includes('d')) delayMs = num * 24 * 60 * 60 * 1000;
      else if (timePhrase.includes('semana')) delayMs = num * 7 * 24 * 60 * 60 * 1000;
    }
  }

  let cleanContent = text
    .replace(/^(?:tambi[eé]n\s+)?(?:por\s+fa(?:vor)?\s+)?(?:recu[eé]rdame|recuerda|recordar|programa)\s+(?:que\s+)?(?:debo\s+)?(?:tengo\s+que\s+)?/i, '')
    .replace(/\s{2,}/g, ' ')
    .trim();

  if (!cleanContent) cleanContent = rawText;

  return { content: cleanContent, delayMs };
}
