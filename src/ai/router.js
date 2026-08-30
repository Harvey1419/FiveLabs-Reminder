import { executeTool } from './tools.js';
import { callChatCompletion } from './client.js';
import { retrieveRelevantMemories } from '../services/memoryService.js';
import { getDailyOverview, getActiveMemories, getUserSubscription, hasProAccess } from '../db/index.js';
import { buildAgentCorePrompt } from './agentCore.js';
import { isAdminUser } from '../utils/auth.js';
import {
  nowISO,
  nowHuman,
  computeOffsetMinutes,
} from '../utils/time.js';

/**
 * AI Agent Router: Orchestrates context retrieval, single-pass decision making, tool execution, and synthesis.
 *
 * @param {string} messageText
 * @param {object|string} userOrPhone
 * @param {Array<{role: string, content: string}>} [history=[]]
 */
export async function routeMessage(messageText, userOrPhone, history = []) {
  const startMs = Date.now();
  const user = typeof userOrPhone === 'string'
    ? { phone_number: userOrPhone, timezone: 'America/Bogota', locale: 'es-CO' }
    : (userOrPhone || { phone_number: '', timezone: 'America/Bogota', locale: 'es-CO' });

  const timezone = user.timezone || 'America/Bogota';
  const phoneNumber = user.phone_number;
  const offset = computeOffsetMinutes(timezone);
  const nowStr = nowISO(timezone);
  const nowHumanStr = nowHuman(timezone, user.locale === 'en-US' ? 'en' : 'es');
  const isAdmin = isAdminUser(user);

  console.log(`[router] in: "${messageText}" phone=${phoneNumber} tz=${timezone} admin=${isAdmin}`);

  // 1. Parallel Context Pre-fetch (~80-120ms): Always load active user preferences alongside dynamic memories and subscription
  const [relevantMemories, userPreferences, dailyOverview, subscription] = await Promise.all([
    retrieveRelevantMemories({ userId: user.id, queryText: messageText, limit: 5 }),
    user.id ? getActiveMemories({ userId: user.id, category: 'preference', limit: 5 }) : Promise.resolve([]),
    getDailyOverview({ userId: user.id, phoneNumber, timezone }),
    user.id ? getUserSubscription(user.id) : Promise.resolve(null),
  ]);

  const isPro = hasProAccess(subscription, user);
  user.subscription = subscription;
  user.isPro = isPro;

  // Deduplicate and combine persistent preferences with topic-relevant memories
  const combinedMemories = [...(userPreferences || [])];
  for (const m of (relevantMemories || [])) {
    if (!combinedMemories.some(p => p.id === m.id)) {
      combinedMemories.push(m);
    }
  }

  const memoryHints = combinedMemories.length > 0
    ? combinedMemories.map(m => `- [${m.category || 'memoria'}] ${m.content}`).join('\n')
    : '';

  // 2. Build Authoritative Agent Core Grounded Prompt with RBAC & Plan exposure
  const prompt = buildAgentCorePrompt({
    nowStr,
    nowHumanStr,
    timezone,
    memoryHints,
    overview: dailyOverview,
    isAdmin,
    isPro,
  });

  const pastTurns = history.slice(-8);
  const messages = [
    { role: 'system', content: prompt },
    ...pastTurns,
    { role: 'user', content: messageText },
  ];

  let plan = { type: 'chat', tool: null, params: {}, intent: 'chat', reply: '' };

  try {
    const rawText = await callChatCompletion(messages, { max_tokens: 1200 });
    const jsonStr = extractFirstJsonObject(rawText);
    const parsed = safeJsonParse(jsonStr);
    if (parsed) {
      plan = parsed;
      if (plan.reasoning) {
        console.log(`[router] Deliberation: "${plan.reasoning.slice(0, 140)}..."`);
      }
    } else if (rawText && !rawText.startsWith('{')) {
      plan.reply = rawText;
    }
  } catch (err) {
    console.warn('[router] planning failed:', err.message);
  }

  // 2.5 Transaction Guard: Ensure promises made in conversation match database mutations
  const claimedAction = /\b(te\s+program[eé]|te\s+recordar[eé]|recordatorio\s+programado|te\s+dej[eé]\s+programado|he\s+programado|agendado|cancel[eé]|elimin[eé]|borr[eé]|quit[eé]|reprogramado|actualizado)\b/i.test(plan.reply || '');
  const requestedAction = /\b(recu[eé]rdame|acu[eé]rdame|av[ií]same|remind\s+me|quita|cancela|elimina|borra|cambia|mueve)\b/i.test(messageText) &&
    !/\b(gracias|ok|listo|no\s+tengo|consulta|cu[aá]les|qu[eé]\s+tengo|verdad\?|cierto\?)\b/i.test(messageText);

  if ((claimedAction || requestedAction) && (!plan.tool || plan.type !== 'tool_call')) {
    console.warn('[router] Transaction Guard: missing database tool call detected for action intent. Executing emergency repair...');
    try {
      const rescueMessages = [
        { role: 'system', content: `${prompt}\n\nCRITICAL MANDATE: The user requested an operational action ("${messageText}"). You MUST output a JSON with "type": "tool_call" executing "manage_reminder" (action: "create" | "cancel" | "update"), "manage_task", or "manage_entity". NEVER answer with chat-only when an action is requested.` },
        { role: 'user', content: messageText },
      ];
      const rescueRaw = await callChatCompletion(rescueMessages, { max_tokens: 600, temperature: 0.0 });
      const rescueJson = extractFirstJsonObject(rescueRaw);
      const repairedPlan = safeJsonParse(rescueJson);
      if (repairedPlan?.tool && repairedPlan.type === 'tool_call') {
        plan = repairedPlan;
        console.log(`[router] Transaction Guard successfully repaired tool call for ${plan.tool}.`);
      }
    } catch (rescueErr) {
      console.error('[router] Transaction Guard repair failed:', rescueErr.message);
    }
  }

  // 3. Tool Execution if requested (Supports Batch Creation)
  if (plan.type === 'tool_call' && plan.tool) {
    const toolResult = await executeTool(plan.tool, plan.params || {}, user);
    console.log(`[router] Tool ${plan.tool} executed (${toolResult.action}):`, toolResult.rawSummary);

    // Dynamic memory listing fallback if model left reply generic, interim or empty
    if (toolResult.action === 'listed_memories' && Array.isArray(toolResult.data)) {
      const isGenericOrInterim = !plan.reply ||
        plan.reply.length < 15 ||
        (/\b(consultando|revisando|un momento|espera|buscando)\b/i.test(plan.reply) && !plan.reply.includes('•'));

      if (isGenericOrInterim) {
        const mems = toolResult.data;
        if (mems.length > 0) {
          plan.reply = `🧠 *Lo que sé y recuerdo sobre ti:*\n\n` +
            mems.slice(0, 10).map(m => `• *${m.category ? m.category.charAt(0).toUpperCase() + m.category.slice(1) : 'Dato'}:* ${m.content}`).join('\n\n') +
            `\n\n¿Hay algo más que quieras que tenga presente o algún detalle que actualizar? 😊`;
        } else {
          plan.reply = `Actualmente no tengo memorias registradas sobre ti. Puedes contarme sobre tus proyectos, personas o preferencias y las recordaré con gusto. 😊`;
        }
      }
    }

    // Dynamic cancellation count enrichment
    if (toolResult.action === 'cancelled_reminders' && toolResult.data) {
      const { cancelledCount } = toolResult.data;
      if (plan.params?.keepLatest) {
        plan.reply = `¡Listo! Eliminé ${cancelledCount} recordatorio(s) anterior(es) y te dejé solo el último 🗑️⏰`;
      } else if (plan.params?.cancelAll) {
        plan.reply = `¡Listo! Eliminé todos tus recordatorios pendientes (${cancelledCount} en total) 🗑️`;
      }
    }

    // Subscription link generation enrichment
    if (toolResult.action === 'subscription_link_generated' && toolResult.data?.checkout_url) {
      const checkoutUrl = toolResult.data.checkout_url;
      if (plan.reply && plan.reply.includes('[checkout_url]')) {
        plan.reply = plan.reply.replace(/\[checkout_url\]/g, checkoutUrl);
      } else if (!plan.reply || !plan.reply.includes('http')) {
        plan.reply =
          `🚀 *Desbloquea tu Segundo Cerebro con Reminder Pro*\n\n` +
          `Con **Reminder Pro** ($49.900 COP/mes) obtienes un asistente que evoluciona contigo:\n\n` +
          `• 🧠 *Memoria Continua:* Entre más hablas conmigo, más aprendo de tus proyectos, clientes y hábitos.\n` +
          `• 📅 *Agenda Total:* Recordatorios para cualquier fecha futura sin límites.\n` +
          `• 🔄 *Recurrencias Inteligentes:* 'Todos los lunes', 'cada 15 días' o fin de mes.\n` +
          `• 🌅 *Morning Briefing:* Tu resumen ejecutivo matutino en WhatsApp a tu hora.\n` +
          `• 🔔 *Insistencia Anti-Procrastinación:* Avisos inteligentes hasta que confirmes.\n\n` +
          `👉 *Suscríbete aquí de forma segura con Mercado Pago:*\n${checkoutUrl}`;
      }
    }

    // Tier limit exceeded notification
    if (toolResult.action === 'tier_limit_exceeded') {
      plan.reply = toolResult.rawSummary;
    }
  }

  const finalReply = plan.reply || '¡Entendido! Lo tengo presente en tus notas.';
  const totalDurationMs = Date.now() - startMs;
  console.log(`[router] Out in ${totalDurationMs}ms: "${finalReply.slice(0, 80)}..."`);

  let inferredIntent = plan.intent || 'chat';
  if (plan.tool === 'manage_memory') inferredIntent = 'memory';
  else if (plan.tool === 'manage_reminder') inferredIntent = 'reminder';
  else if (plan.tool === 'manage_task') inferredIntent = 'task';
  else if (plan.tool === 'manage_entity') inferredIntent = 'entity';
  else if (plan.tool === 'manage_subscription' || plan.tool === 'get_subscription_link') inferredIntent = 'subscription';
  else if (plan.tool === 'admin_metrics') inferredIntent = 'admin';

  const isEnglish = (user.locale && user.locale.startsWith('en')) || /\b(hello|hi|good morning|schedule|remind me|please|help me|thank you|thanks)\b/i.test(messageText);

  return {
    intent: inferredIntent,
    entities: plan.params || {},
    language: isEnglish ? 'en' : 'es',
    confirmation: finalReply,
  };
}

function safeJsonParse(jsonStr) {
  if (!jsonStr) return null;
  try {
    return JSON.parse(jsonStr);
  } catch {
    try {
      // Sanitize unescaped control characters inside string literals
      const sanitized = jsonStr.replace(/[\u0000-\u001F]+/g, (match) => {
        if (match === '\n') return '\\n';
        if (match === '\r') return '\\r';
        if (match === '\t') return '\\t';
        return '';
      });
      return JSON.parse(sanitized);
    } catch {
      return null;
    }
  }
}

function extractFirstJsonObject(text) {
  if (!text) return null;
  let raw = text.trim();

  // Strip markdown code fences if present
  if (raw.startsWith('```json')) {
    raw = raw.replace(/^```json\s*/i, '').replace(/```\s*$/, '').trim();
  } else if (raw.startsWith('```')) {
    raw = raw.replace(/^```\s*/, '').replace(/```\s*$/, '').trim();
  }

  if (raw[0] !== '{') {
    const start = raw.indexOf('{');
    if (start < 0) return null;
    raw = raw.slice(start);
  }

  // Count braces
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (escape) { escape = false; continue; }
    if (ch === '\\') { escape = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return raw.slice(0, i + 1);
    }
  }

  // Attempt auto-repair for truncated reply
  if (depth > 0 && inString) {
    try {
      const repaired = raw + '"}' + '}'.repeat(depth - 1);
      JSON.parse(repaired);
      return repaired;
    } catch {}
  }

  return null;
}
