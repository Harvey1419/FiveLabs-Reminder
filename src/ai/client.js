/**
 * High-Speed Multi-Provider AI Client.
 * Uses unified AI_MODEL (default: gemini-3.1-flash-lite) with resilient fallbacks.
 */

const REQUEST_TIMEOUT_MS = 20000;

export async function callChatCompletion(messages, { temperature = 0.0, max_tokens = 2500 } = {}) {
  const geminiKey = process.env.GEMINI_API_KEY || (process.env.AI_API_KEY?.startsWith('AIza') ? process.env.AI_API_KEY : null);
  const groqKey = process.env.GROQ_API_KEY || (process.env.AI_API_KEY?.startsWith('gsk_') ? process.env.AI_API_KEY : null);

  const unifiedModel = process.env.AI_MODEL || process.env.GEMINI_MODEL || 'gemini-3.1-flash-lite';
  const providers = [];

  // 1. PRIMARY: Google Gemini with unified AI_MODEL
  if (geminiKey) {
    providers.push({
      name: `Gemini (${unifiedModel})`,
      url: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
      key: geminiKey,
      model: unifiedModel,
      jsonMode: true,
    });

    // Gemini fallback if primary encounters temporary issues
    if (unifiedModel !== 'gemini-2.5-flash') {
      providers.push({
        name: 'Gemini (gemini-2.5-flash)',
        url: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
        key: geminiKey,
        model: 'gemini-2.5-flash',
        jsonMode: true,
      });
    }
  }

  // 2. BACKUP: Groq LPUs
  if (groqKey) {
    providers.push({
      name: 'Groq (openai/gpt-oss-20b)',
      url: 'https://api.groq.com/openai/v1/chat/completions',
      key: groqKey,
      model: 'openai/gpt-oss-20b',
      jsonMode: false,
    });
  }

  // Execute providers in prioritized order
  for (const p of providers) {
    try {
      const payload = {
        model: p.model,
        messages,
        temperature,
        max_tokens,
      };

      if (p.jsonMode) {
        payload.response_format = { type: 'json_object' };
      }

      const res = await fetch(p.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${p.key}`,
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });

      if (res.ok) {
        const data = await res.json();
        const raw = data.choices?.[0]?.message?.content;
        if (raw) {
          return raw.replace(/<\/?think>[\s\S]*?<\/?think>/g, '').replace(/<\/?think>/g, '').trim();
        }
      } else {
        const errBody = await res.text();
        console.warn(`[ai-client] ${p.name} returned ${res.status}:`, errBody.slice(0, 80));
      }
    } catch (err) {
      console.warn(`[ai-client] ${p.name} failed:`, err.message);
    }
  }

  // 3. FINAL RESILIENT NLP FALLBACK (0ms)
  const lastUserMsg = messages.filter(m => m.role === 'user').pop()?.content || '';
  return heuristicPlanner(lastUserMsg);
}

function heuristicPlanner(text) {
  const t = text.toLowerCase().trim();

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

  // 3. Task creation
  const taskMatch = t.match(/(?:añade|agrega|crea|nueva tarea)\s+(?:la tarea\s+)?(?:de\s+)?(.+)/i);
  if (taskMatch) {
    let title = taskMatch[1].trim();
    let entityName = null;

    if (title.includes(' con ')) {
      const parts = title.split(' con ');
      title = parts[0];
      entityName = parts[1]?.trim();
    }

    return JSON.stringify({
      type: 'tool_call',
      tool: 'manage_task',
      params: {
        action: 'create',
        title,
        entityName,
        entityCategory: 'person',
      },
      intent: 'task',
      reply: `¡Anotado! Creé la tarea: "${title}" 📋`,
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
