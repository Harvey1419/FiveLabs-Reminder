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
    phoneNumber,
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
  const claimedAction = /\b(te\s+program[eé]|te\s+recordar[eé]|recordatorio\s+programado|recordatorios\s+programados|te\s+dej[eé]\s+programado|he\s+programado|agendado|cancel[eé]|elimin[eé]|borr[eé]|quit[eé]|reprogramado|actualizado|tarea\s+añadida|tareas\s+añadidas|tarea\s+creada|tareas\s+creadas|proyecto\s+creado|proyectos\s+creados|tarea\s+registrada|tarea\s+marcada|tarea\s+completada|he\s+(añadido|creado|agregado|guardado|registrado|completado|marcado|eliminado|borrado)\s+(la|las|el|un|una|este|esta)?\s*(tarea|proyecto|item|lista))\b/i.test(plan.reply || '');
  const requestedAction = (
    /\b(recu[eé]rdame|acu[eé]rdame|av[ií]same|remind\s+me|quita|cancela|elimina|borra|cambia|mueve)\b/i.test(messageText) ||
    /\b(a[ñn]ade|agrega|pon(me)?|crea|anota|registra|guarda|marca|completa)\b.*\b(tarea|tareas|proyecto|proyectos|lista|pendiente|pendientes|checklist|item|items|art[ií]culo)\b/i.test(messageText) ||
    /\b(al\s+proyecto|en\s+el\s+proyecto|bajo\s+(este|el)\s+proyecto|en\s+la\s+lista|a\s+la\s+lista)\b/i.test(messageText)
  ) && !/\b(gracias|ok|listo|no\s+tengo|consulta|verdad\?|cierto\?)\b/i.test(messageText);

  if ((claimedAction || requestedAction) && (!plan.tool || plan.type !== 'tool_call')) {
    console.warn('[router] Transaction Guard: missing database tool call detected for action intent. Executing emergency repair...');
    try {
      const rescueMessages = [
        { role: 'system', content: `${prompt}\n\nCRITICAL MANDATE: The user requested an operational action ("${messageText}"). You MUST output a JSON with "type": "tool_call" executing "manage_reminder" (action: "create" | "cancel" | "update"), "manage_task" (action: "create" | "complete" | "delete" | "list"), or "manage_entity". NEVER answer with chat-only when an action is requested.` },
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
  let toolResult = null;
  if (plan.type === 'tool_call' && plan.tool) {
    toolResult = await executeTool(plan.tool, plan.params || {}, user);
    console.log(`[router] Tool ${plan.tool} executed (${toolResult.action}):`, toolResult.rawSummary);

    // Dynamic task listing fallback if model left reply generic, interim or empty
    if (toolResult.action === 'listed_tasks' && Array.isArray(toolResult.data)) {
      const isGenericOrInterim = !plan.reply ||
        plan.reply.length < 15 ||
        (/\b(consultando|revisando|un momento|espera|buscando|entendido|lo tengo presente|anotado)\b/i.test(plan.reply) && !plan.reply.includes('•') && !plan.reply.includes('▫️'));

      if (isGenericOrInterim) {
        const tasks = toolResult.data;
        if (tasks.length > 0) {
          const byEntity = {};
          const general = [];
          for (const t of tasks) {
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
        } else {
          plan.reply = `📂 *Tareas pendientes*\n\nActualmente no tienes tareas pendientes registradas en tu agenda.`;
        }
      }
    }

    // Dynamic task batch creation fallback if model left reply generic
    if (toolResult.action === 'created_tasks_batch' && Array.isArray(toolResult.data)) {
      const isGeneric = !plan.reply ||
        plan.reply.length < 15 ||
        (/\b(consultando|revisando|un momento|espera|buscando|entendido|lo tengo presente)\b/i.test(plan.reply) && !plan.reply.includes('•') && !plan.reply.includes('▫️'));

      if (isGeneric) {
        const saved = toolResult.data;
        const entName = saved[0]?.entityName;
        if (entName) {
          plan.reply = `✅ *Tarea añadida*\n\n📂 *Proyecto: ${entName}*\n` + saved.map(t => `• ${t.title}`).join('\n');
        } else {
          plan.reply = `✅ *Tarea(s) creada(s)*\n\n` + saved.map(t => `• ${t.title}`).join('\n');
        }
      }
    }

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
            `\n\n💡 _Puedes pedirme agregar más detalles o corregir cualquier dato cuando quieras._`;
        } else {
          plan.reply = `🧠 *Memoria del Asistente*\n\nActualmente no tengo recuerdos o preferencias guardadas sobre ti. A medida que hablemos iré recordando tus proyectos y contexto importante.`;
        }
      }
    }

    // Dynamic cancelled reminder feedback fallback if model forgot to mention it
    if (toolResult.action === 'cancelled_reminders' && toolResult.data) {
      const { cancelledCount } = toolResult.data;
      if (cancelledCount > 0 && !plan.reply.includes('cancelado') && !plan.reply.includes('eliminado')) {
        plan.reply = `🗑️ *Recordatorio cancelado*\n\n${toolResult.rawSummary}\n\n${plan.reply}`;
      }
    }

    // Dynamic subscription link replacement if model left placeholder
    if (toolResult.action === 'subscription_link_generated' && toolResult.data?.checkout_url) {
      const checkoutUrl = toolResult.data.checkout_url;
      if (plan.reply && plan.reply.includes('[checkout_url]')) {
        plan.reply = plan.reply.replace(/\[checkout_url\]/g, checkoutUrl);
      } else if (!plan.reply.includes(checkoutUrl)) {
        plan.reply = `${plan.reply}\n\n👉 *Enlace de pago seguro de Mercado Pago:*\n${checkoutUrl}`;
      }
    }

    // Google Calendar link replacement / result enrichment
    if (toolResult.action === 'google_auth_link_generated' || toolResult.action === 'google_not_connected') {
      if (toolResult.data?.auth_url) {
        const isInterim = /\b(consultando|revisando|un momento|espera|buscando)\b/i.test(plan.reply);
        if (isInterim || !plan.reply || plan.reply.length < 15) {
          plan.reply = `📅 *Google Calendar no vinculado*\n\nPara consultar tus eventos o agendar reuniones, primero debes vincular tu cuenta de Google.\n\n👉 Toca el botón de abajo para conectarla en 1 toque.`;
        } else if (plan.reply.includes('[auth_url]')) {
          plan.reply = plan.reply.replace(/\[auth_url\]/g, toolResult.data.auth_url);
        } else if (!plan.reply.includes(toolResult.data.auth_url)) {
          plan.reply = `${plan.reply}\n\n👉 *Vincula tu cuenta aquí:* ${toolResult.data.auth_url}`;
        }
      }
    } else if (
      toolResult.action === 'google_events_listed' ||
      toolResult.action === 'google_event_created' ||
      toolResult.action === 'google_disconnected' ||
      toolResult.action === 'listed_entities' ||
      toolResult.action === 'listed_tasks' ||
      toolResult.action === 'listed_reminders' ||
      toolResult.action === 'listed_memories'
    ) {
      if (!plan.reply || plan.reply === '' || /\b(consultando|revisando|un momento|espera|buscando)\b/i.test(plan.reply)) {
        plan.reply = toolResult.rawSummary;
      }
    }

    // Subscription cancellation enrichment
    if (toolResult.action === 'subscription_cancelled') {
      plan.reply = `🗑️ *Suscripción a Reminder Pro cancelada*\n\n${toolResult.rawSummary}\n\n¡Esperamos verte de vuelta pronto! 😊`;
    }

    // Tier limit exceeded notification
    if (toolResult.action === 'tier_limit_exceeded') {
      plan.reply = toolResult.rawSummary;
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
      if (ackRes.acknowledgedCount > 0) {
        console.log(`[router] Auto-acknowledged ${ackRes.acknowledgedCount} pending reminder(s) from user confirmation "${messageText}".`);
        if (!plan.reply || plan.reply.includes('intermitencia de conexión') || plan.reply.includes('¡Entendido! Lo tengo presente')) {
          plan.reply = '¡Listo! ✅ Recordatorio completado y desactivados los avisos pendientes.';
        }
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

  // Universal safety check: if user asked for task listing and the model returned generic/empty reply
  const isTaskQuery = /\b(dame\s+(todos\s+)?(los\s+)?(proyectos|tareas)|mu[eé]stramelos|mu[eé]strame\s+(las\s+)?tareas|cu[aá]les\s+son\s+(mis\s+)?tareas|qu[eé]\s+tareas\s+tengo|proyectos\s+y\s+tareas|ver\s+mis\s+tareas|listar?\s+tareas)\b/i.test(messageText);

  if (isTaskQuery && (!plan.reply || plan.reply.length < 15 || plan.reply.includes('¡Entendido! Lo tengo presente') || (!plan.reply.includes('•') && !plan.reply.includes('▫️')))) {
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

  const finalReply = plan.reply || '¡Entendido! Lo tengo presente en tus notas.';
  const totalDurationMs = Date.now() - startMs;
  console.log(`[router] Out in ${totalDurationMs}ms: "${finalReply.slice(0, 80)}..."`);

  let inferredIntent = plan.intent || 'chat';
  if (plan.tool === 'manage_memory') inferredIntent = 'memory';
  else if (plan.tool === 'manage_reminder') inferredIntent = 'reminder';
  else if (plan.tool === 'manage_task') inferredIntent = 'task';
  else if (plan.tool === 'manage_entity') inferredIntent = 'entity';
  else if (plan.tool === 'manage_subscription' || plan.tool === 'get_subscription_link') inferredIntent = 'subscription';
  else if (plan.tool === 'manage_google_calendar') inferredIntent = 'calendar';
  else if (plan.tool === 'admin_metrics') inferredIntent = 'admin';

  let ctaUrl = null;
  let ctaHeader = null;
  let ctaButtonText = null;

  if (toolResult?.action === 'google_auth_link_generated' || toolResult?.action === 'google_not_connected') {
    ctaUrl = toolResult.data?.auth_url || getGoogleConnectUrl({ userId: user.id, phoneNumber: phoneNumber || user.phone_number });
    ctaHeader = '📅 Google Calendar';
    ctaButtonText = '🔗 Conectar Google';
  } else if (toolResult?.action === 'subscription_link_generated' || plan.tool === 'get_subscription_link') {
    ctaUrl = toolResult?.data?.checkout_url || null;
    ctaHeader = '🌟 Reminder Pro';
    ctaButtonText = '🚀 Suscribirme a Pro';
  }

  const isEnglish = (user.locale && user.locale.startsWith('en')) || /\b(hello|hi|good morning|schedule|remind me|please|help me|thank you|thanks)\b/i.test(messageText);

  return {
    intent: inferredIntent,
    entities: plan.params || {},
    language: isEnglish ? 'en' : 'es',
    confirmation: finalReply,
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
