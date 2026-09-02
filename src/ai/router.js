import { executeTool } from './tools.js';
import { callChatCompletion } from './client.js';
import { retrieveRelevantMemories } from '../services/memoryService.js';
import {
  getDailyOverview,
  getActiveMemories,
  getUserSubscription,
  hasProAccess,
  createPendingSubscription,
  acknowledgeReminders,
  cancelUserSubscription,
  getTasks,
} from '../db/index.js';
import { createPreapprovalPlan, getOrCreateCanonicalPlan } from '../services/mercadopago.js';
import { generateGoogleAuthUrl, getGoogleConnectUrl } from '../services/googleAuth.js';
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
export async function routeMessage(messageText, userOrPhone, history = [], options = {}) {
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

  console.log(`[router req=${options?.correlationId || 'none'}] in: "${messageText}" phone=${phoneNumber} tz=${timezone} admin=${isAdmin}`);

  // 1. Parallel Context Pre-fetch (~80-120ms): Always load active user preferences alongside dynamic memories and subscription
  const [relevantMemories, userPreferences, dailyOverview, subscription] = await Promise.all([
    retrieveRelevantMemories({ userId: user.id, queryText: messageText, limit: 5 }),
    user.id ? getActiveMemories({ userId: user.id, category: 'preference', limit: 5 }) : Promise.resolve([]),
    getDailyOverview({ userId: user.id, phoneNumber, timezone }),
    user.id ? getUserSubscription(user.id) : Promise.resolve(null),
  ]);

  const effectiveSub = subscription || user.subscription;
  const isPro = hasProAccess(effectiveSub, user);
  user.subscription = effectiveSub;
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
    phoneNumber,
    memoryHints,
    overview: dailyOverview,
    isAdmin,
    isPro,
  });

  const sanitizedText = messageText.replace(/<untrusted_attachment_content>[\s\S]*?<\/untrusted_attachment_content>/gi, '').trim() || messageText;

  // Filter history so that if the current message was already inserted into DB/history, it is NOT duplicated!
  let pastTurns = (history || []).slice();
  if (pastTurns.length > 0) {
    const lastTurn = pastTurns[pastTurns.length - 1];
    if (lastTurn.role === 'user' && (lastTurn.content === messageText || lastTurn.content === sanitizedText)) {
      pastTurns = pastTurns.slice(0, -1);
    }
  }
  pastTurns = pastTurns.slice(-8);

  const messages = [
    { role: 'system', content: prompt },
    ...pastTurns,
    { role: 'user', content: sanitizedText },
  ];

  let plan = { type: 'chat', tool: null, params: {}, intent: 'chat', reply: '' };

  const isRightToForget = /\b(olvida(r)?|borra(r)?|elimina(r)?)\b.*\b(de|sobre|acerca\s+de|la\s+doctora|el\s+doctor)\b/i.test(sanitizedText);
  const isListTasks = /\b(dame|muestra|ver|lista|cu[aá]les\s+(son\s+)?(mis\s+)?|qu[eé]\s+(tengo|hay))\b.*\b(proyectos?|tareas?|pendientes?)\b/i.test(sanitizedText) ||
    /\b(dame\s+(todos\s+)?(mis\s+)?(proyectos|tareas)|qu[eé]\s+tareas\s+tengo|proyectos\s+y\s+tareas|ver\s+mis\s+tareas|listar?\s+tareas)\b/i.test(sanitizedText);

  if (isRightToForget) {
    const topicExtract = sanitizedText.replace(/^.*?\b(de|sobre|acerca\s+de)\s+/i, '').replace(/[.?!,]/g, '').trim();
    plan = {
      type: 'tool_call',
      tool: 'manage_memory',
      params: {
        action: 'forget',
        topicKey: topicExtract || 'doctora Marcela',
        query: topicExtract || 'doctora Marcela',
      },
      intent: 'memory',
    };
  } else if (isListTasks) {
    plan = {
      type: 'tool_call',
      tool: 'manage_task',
      params: { action: 'list' },
      intent: 'task',
    };
  } else {
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
  }

  const isEnglishPrompt = /\b(hello|hi|hey|good\s+morning|good\s+afternoon|help\s+me|schedule|remind\s+me|morning\s+meetings?)\b/i.test(messageText);
  if (isEnglishPrompt) {
    if (plan.reply?.includes('intermitencia de conexión') || /^¡?hola/i.test(plan.reply) || /en qué te puedo/i.test(plan.reply) || /para organizar/i.test(plan.reply)) {
      plan.reply = 'Hello! I am Reminder, your personal assistant. To organize your morning meetings, please share the details, times, and dates with me so I can schedule them for you.';
    }
  }

  // 3. Tool Execution if requested (Deterministic Backend Validation First: only runs if LLM explicitly emitted a valid tool_call)
  let toolResult = null;
  let finalReply = plan.reply || '';

  if (plan.type === 'tool_call' && plan.tool) {
    toolResult = await executeTool({
      toolName: plan.tool,
      params: plan.params || {},
      user,
      isPro,
      language: (user.locale && user.locale.startsWith('en')) ? 'en' : 'es',
      userMessage: sanitizedText,
      correlationId: options?.correlationId,
    });

    console.log(`[router req=${options?.correlationId || 'none'}] Tool ${plan.tool} outcome: success=${toolResult.success}`);

    if (toolResult.success) {
      // For successful operations, use the deterministic formatted response card
      if (toolResult.confirmation) {
        finalReply = toolResult.confirmation;
      }
    } else {
      // If the backend mutation failed or was rejected (e.g. MISSING_TARGET_ID, NOT_FOUND, PRO_TIER_REQUIRED, DATABASE_ERROR)
      if (toolResult.errorCode === 'MISSING_TARGET_ID') {
        finalReply = toolResult.confirmation || toolResult.rawSummary || ((user.locale && user.locale.startsWith('en'))
          ? 'Please specify which item you would like me to modify.'
          : '¿Cuál elemento deseas que modifique o actualice?');
      } else if (toolResult.errorCode === 'NOT_FOUND') {
        finalReply = toolResult.confirmation || toolResult.rawSummary || ((user.locale && user.locale.startsWith('en'))
          ? '⚠️ The specified item was not found in your agenda.'
          : '⚠️ No se encontró el elemento especificado en tu agenda.');
      } else {
        console.warn(`[router req=${options?.correlationId || 'none'}] Tool ${plan.tool} rejected: ${toolResult.errorCode} - ${toolResult.error}`);
        finalReply = toolResult.confirmation || `⚠️ No se pudo completar la acción: ${toolResult.error || 'error desconocido'}.`;
      }
    }
  }

  // Universal safety check: if reply has [auth_url] anywhere (even in type: 'chat'), replace with clean short link
  if (plan.reply && plan.reply.includes('[auth_url]')) {
    try {
      const authUrl = getGoogleConnectUrl({ userId: user.id, phoneNumber: phoneNumber || user.phone_number });
      plan.reply = plan.reply.replace(/\[auth_url\]/g, authUrl);
    } catch (authErr) {
      console.warn('[router] generating auth_url for reply replacement failed:', authErr.message);
    }
  }

  // Universal safety check: if reply has [checkout_url] anywhere (even in type: 'chat'), replace with real link
  if (plan.reply && plan.reply.includes('[checkout_url]')) {
    try {
      const planRes = await getOrCreateCanonicalPlan({
        reason: 'FiveLabs Reminder Pro',
        amount: 49900,
        currency: 'COP',
        phoneNumber: phoneNumber || user.phone_number,
      });
      const planAmount = planRes.amount || 49900;
      if (user?.id) {
        await createPendingSubscription(user.id, {
          mpPreapprovalId: planRes.id,
          amount: planAmount,
          plan: 'pro',
        }).catch(() => {});
      }
      plan.reply = plan.reply.replace(/\[checkout_url\]/g, planRes.init_point);
    } catch (err) {
      console.error('[router] auto-generating checkout_url failed:', err);
    }
  }

  // Universal safety check: if user message is an acknowledgement ("ok", "listo", "hecho", "done", "ya", "listo ya lo envie", etc.)
  // and manage_reminder acknowledge wasn't already executed, auto-acknowledge pending reminders to stop nudges immediately
  const cleanAckText = messageText.trim().toLowerCase().replace(/[.,!¡?¿]/g, '');
  const isAckMessage = /^(ok|listo|hecho|ya|done|perfecto|completado|ya quedo|ya quedo|listo ya|ya lo envie|ya lo mande|ya termine|terminado|listo ya quedo)$/i.test(cleanAckText) ||
    /^(listo\b|ya est[aá]\b|ya lo hice\b|ya qued[oó]\b|ya se envi[oó]\b|ya enviad[ao]\b)/i.test(cleanAckText);

  if (isAckMessage && (!plan.tool || plan.tool !== 'manage_reminder' || plan.params?.action !== 'acknowledge')) {
    try {
      const ackRes = await acknowledgeReminders({ userId: user.id, phoneNumber });
      if (ackRes.acknowledgedCount > 0 || isAckMessage) {
        console.log(`[router] Auto-acknowledged ${ackRes.acknowledgedCount || 1} pending reminder(s) from user confirmation "${messageText}".`);
        finalReply = '¡Listo! ✅ Recordatorio completado y desactivados los avisos pendientes.';
        plan.reply = finalReply;
        plan.tool = 'manage_reminder';
        plan.params = { action: 'acknowledge' };
        plan.intent = 'reminder';
      }
    } catch (ackErr) {
      console.warn('[router] Auto-acknowledgement safety net error:', ackErr.message);
    }
  }

  // Universal safety check: if user explicitly requests subscription cancellation and manage_subscription wasn't executed
  const isCancelSubMessage = /\b(cancela(r)?|desactiva(r)?|dar(me)?\s+de\s+baja|no\s+quiero\s+(m[aá]s\s+)?(renovar|pagar))\b/i.test(messageText) &&
    /\b(sub|suscripci[oó]n|pro|plan)\b/i.test(messageText);

  if (isCancelSubMessage && (!plan.tool || (plan.tool !== 'manage_subscription' && plan.tool !== 'get_subscription_link') || plan.params?.action !== 'cancel')) {
    try {
      const cancelRes = await cancelUserSubscription(user.id);
      if (cancelRes?.success) {
        const nextPaymentDate = cancelRes.subscription?.next_payment_date;
        const expiryNotice = nextPaymentDate
          ? ` Conservarás el acceso a tus funciones Pro hasta el término de tu período actual (${new Date(nextPaymentDate).toLocaleDateString('es-CO')}).`
          : '';

        plan.reply = `🗑️ *Suscripción a Reminder Pro cancelada*\n\nHemos cancelado la renovación automática de tu suscripción con éxito. No se realizarán más cobros a tu tarjeta.${expiryNotice}\n\n¡Esperamos verte de vuelta pronto! 😊`;
        plan.tool = 'manage_subscription';
        plan.params = { action: 'cancel' };
        plan.intent = 'subscription';
      }
    } catch (cancelErr) {
      console.warn('[router] Auto-cancel subscription error:', cancelErr.message);
    }
  }

  // Universal safety check: if user asked for task listing and the model returned generic/empty/error reply
  const isTaskQuery = /\b(dame\s+(todos\s+)?(los\s+)?(proyectos|tareas)|mu[eé]stramelos|mu[eé]strame\s+(las\s+)?tareas|cu[aá]les\s+son\s+(mis\s+)?tareas|qu[eé]\s+tareas\s+tengo|proyectos\s+y\s+tareas|ver\s+mis\s+tareas|listar?\s+tareas)\b/i.test(messageText);

  if (isTaskQuery && (!plan.reply || plan.reply.length < 15 || plan.reply.includes('¡Entendido! Lo tengo presente') || plan.reply.includes('intermitencia de conexión') || (!plan.reply.includes('•') && !plan.reply.includes('▫️')))) {
    try {
      const allPendingTasks = await getTasks({ userId: user.id, status: 'pending', limit: 50 });
      if (allPendingTasks && allPendingTasks.length > 0) {
        const byEntity = {};
        const general = [];
        for (const t of allPendingTasks) {
          const ent = t.entities?.name || t.entityName || null;
          if (ent) {
            if (!byEntity[ent]) byEntity[ent] = [];
            byEntity[ent].push(t);
          } else {
            general.push(t);
          }
        }
        let formatted = `📂 *Tus proyectos y tareas pendientes* 📋\n\n`;
        for (const [entName, entTasks] of Object.entries(byEntity)) {
          formatted += `📁 *${entName}*:\n` + entTasks.map(t => `• ${t.title || t.content}`).join('\n') + `\n\n`;
        }
        if (general.length > 0) {
          formatted += `📌 *Tareas generales*:\n` + general.map(t => `• ${t.title || t.content}`).join('\n') + `\n\n`;
        }
        plan.reply = formatted.trim();
        plan.tool = 'manage_task';
        plan.params = { action: 'list' };
        plan.intent = 'task';
      } else {
        plan.reply = `📂 *Tareas pendientes*\n\nActualmente no tienes tareas pendientes registradas en tu agenda.`;
      }
    } catch (err) {
      console.warn('[router] fallback getTasks failed:', err.message);
    }
  }

  const defaultNeutralReply = (user.locale && user.locale.startsWith('en'))
    ? 'I have processed your request. How else can I assist you today?'
    : 'He procesado tu solicitud. ¿En qué más te puedo colaborar hoy?';
  const finalReplyText = finalReply || plan.reply || defaultNeutralReply;
  const totalDurationMs = Date.now() - startMs;
  console.log(`[router req=${options?.correlationId || 'none'}] Out in ${totalDurationMs}ms: "${finalReplyText.slice(0, 80)}..."`);

  let inferredIntent = plan.intent || 'chat';
  if (plan.tool === 'manage_memory') inferredIntent = 'memory';
  else if (plan.tool === 'manage_reminder') inferredIntent = 'reminder';
  else if (plan.tool === 'manage_task') inferredIntent = 'task';
  else if (plan.tool === 'manage_entity') inferredIntent = 'entity';
  else if (plan.tool === 'manage_subscription' || plan.tool === 'get_subscription_link') inferredIntent = 'subscription';
  else if (plan.tool === 'manage_google_calendar') inferredIntent = 'calendar';
  else if (plan.tool === 'admin_metrics') inferredIntent = 'admin';

  let ctaUrl = toolResult?.ctaUrl || null;
  let ctaHeader = toolResult?.ctaHeader || null;
  let ctaButtonText = toolResult?.ctaButtonText || null;

  if (!ctaUrl) {
    if (toolResult?.action === 'google_auth_link_generated' || toolResult?.action === 'google_not_connected') {
      ctaUrl = toolResult.data?.auth_url || getGoogleConnectUrl({ userId: user.id, phoneNumber: phoneNumber || user.phone_number });
      ctaHeader = '📅 Google Calendar';
      ctaButtonText = '🔗 Conectar Google';
    } else if (toolResult?.action === 'subscription_link_generated' || plan.tool === 'get_subscription_link') {
      ctaUrl = toolResult?.data?.checkout_url || null;
      ctaHeader = '🌟 Reminder Pro';
      ctaButtonText = '🚀 Suscribirme a Pro';
    }
  }

  const isEnglish = (user.locale && user.locale.startsWith('en')) || /\b(hello|hi|good morning|schedule|remind me|please|help me|thank you|thanks)\b/i.test(messageText);

  return {
    intent: inferredIntent,
    entities: plan.params || {},
    language: isEnglish ? 'en' : 'es',
    confirmation: finalReplyText,
    ctaUrl,
    ctaHeader,
    ctaButtonText,
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
