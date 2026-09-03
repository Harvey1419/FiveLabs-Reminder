import { executeTool } from './tools.js';
import { callChatCompletion } from './client.js';
import { retrieveRelevantMemories } from '../services/memoryService.js';
import {
  getDailyOverview,
  getActiveMemories,
  getUserSubscription,
  getUserIntegration,
  hasProAccess,
  createPendingSubscription,
  acknowledgeReminders,
  cancelUserSubscription,
  getTasks,
} from '../db/index.js';
import { createPreapprovalPlan, getOrCreateCanonicalPlan } from '../services/mercadopago.js';
import { generateGoogleAuthUrl, getGoogleConnectUrl } from '../services/googleAuth.js';
import { buildAgentCorePrompt } from './agentCore.js';
import {
  getWorkingMemory,
  saveWorkingMemory,
  formatWorkingMemoryPrompt,
  resolveEntityReference,
  sanitizeResponseText,
} from './workingMemory.js';
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
 * @param {object} [options={}]
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

  // 1. Parallel Context Pre-fetch (~80-120ms): Always load active user preferences alongside dynamic memories, subscription, and integrations
  const [relevantMemories, userPreferences, dailyOverview, subscription, googleIntegration] = await Promise.all([
    retrieveRelevantMemories({ userId: user.id, queryText: messageText, limit: 5 }),
    user.id ? getActiveMemories({ userId: user.id, category: 'preference', limit: 5 }) : Promise.resolve([]),
    getDailyOverview({ userId: user.id, phoneNumber, timezone }),
    user.id ? getUserSubscription(user.id) : Promise.resolve(null),
    user.id ? getUserIntegration(user.id, 'google') : Promise.resolve(null),
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

  // Working Memory from previous turn
  const workingMemoryText = formatWorkingMemoryPrompt(phoneNumber || user.id);

  // 2. Build Authoritative Agent Core Grounded Prompt with RBAC & Plan exposure
  const prompt = buildAgentCorePrompt({
    nowStr,
    nowHumanStr,
    timezone,
    phoneNumber,
    memoryHints,
    overview: dailyOverview,
    workingMemoryText,
    googleIntegration,
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

  // 3. Tool Execution if requested (Deterministic Backend Validation: only runs if LLM emitted tool_call)
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
      if (toolResult.confirmation || toolResult.formattedCard || toolResult.rawSummary) {
        finalReply = toolResult.confirmation || toolResult.formattedCard || toolResult.rawSummary;
      }

      // Save structured items to working memory
      let workingItems = toolResult.data?.items;
      if (!workingItems) {
        if (Array.isArray(toolResult.data)) workingItems = toolResult.data;
        else if (toolResult.data?.events) workingItems = toolResult.data.events;
        else if (toolResult.data?.reminders) workingItems = toolResult.data.reminders;
        else if (toolResult.data?.tasks) workingItems = toolResult.data.tasks;
      }
      if (workingItems && workingItems.length > 0) {
        saveWorkingMemory(user, {
          source: plan.tool === 'get_unified_agenda' ? 'unified' : (plan.tool === 'manage_google_calendar' ? 'calendar' : (plan.tool === 'manage_reminder' ? 'reminder' : 'task')),
          scope: plan.params?.scope || 'tomorrow',
          semanticQuery: plan.params?.query || null,
          entityType: 'all',
          lastAction: plan.tool,
          items: workingItems,
        });
      }

      // Compound Operations: execute secondary plan if present
      if (plan.secondary_plan && plan.secondary_plan.tool) {
        const secondaryResult = await executeTool({
          toolName: plan.secondary_plan.tool,
          params: plan.secondary_plan.params || {},
          user,
          isPro,
          language: (user.locale && user.locale.startsWith('en')) ? 'en' : 'es',
          userMessage: sanitizedText,
          correlationId: options?.correlationId,
        });
        if (secondaryResult.confirmation || secondaryResult.formattedCard) {
          finalReply += '\n\n' + (secondaryResult.confirmation || secondaryResult.formattedCard);
        }
      }
    } else {
      // If the backend mutation failed or was rejected
      if (toolResult.errorCode === 'AMBIGUOUS_TARGET') {
        finalReply = toolResult.confirmation || toolResult.rawSummary || ((user.locale && user.locale.startsWith('en'))
          ? 'Multiple items match your request. Please clarify which one you would like to modify.'
          : 'Hay múltiples elementos que coinciden. Por favor aclara cuál de ellos deseas modificar.');
      } else if (toolResult.errorCode === 'MISSING_TARGET_ID') {
        finalReply = toolResult.confirmation || toolResult.rawSummary || ((user.locale && user.locale.startsWith('en'))
          ? 'Please specify which item you would like me to modify.'
          : '¿Cuál elemento deseas que modifique o actualice?');
      } else if (toolResult.errorCode === 'NOT_FOUND') {
        finalReply = toolResult.confirmation || toolResult.rawSummary || ((user.locale && user.locale.startsWith('en'))
          ? 'Item not found in your agenda.'
          : '⚠️ No se encontró el elemento especificado en tu agenda.');
      } else {
        finalReply = toolResult.confirmation || toolResult.error || `⚠️ No se pudo completar la acción: ${toolResult.error || 'error desconocido'}.`;
      }
    }
  } else {
    // 4. Deterministic Post-LLM Acknowledge Guard:
    // If LLM returned type: 'chat', but the user message is an explicit past-tense completion
    // of an active pending reminder ("ya le hablé", "ya quedó", "ya compré", "ya fui"), resolve and acknowledge deterministically.
    const isPastConfirmation = /\b(ya le hablé|ya le hable|ya hablé|ya hable|ya le escribí|ya le escribi|ya escribí|ya escribi|ya compré|ya compre|ya lo hice|ya está hecho|ya esta hecho|ya quedó|ya quedo|ya lo llamé|ya lo llame|ya llamé|ya llame|ya fui|fui|ya terminado|ya terminé|ya termine|listo|ok|hecho)\b/i.test(sanitizedText) && !sanitizedText.includes('?');
    if (isPastConfirmation) {
      const wm = getWorkingMemory(phoneNumber || user.id);
      let targetReminderId = null;
      if (wm && wm.items && wm.items.length > 0 && wm.items[0].internalId) {
        targetReminderId = wm.items[0].internalId;
      }

      if (targetReminderId) {
        const ackResult = await executeTool({
          toolName: 'manage_reminder',
          params: { action: 'acknowledge', reminderId: targetReminderId },
          user,
          isPro,
          language: (user.locale && user.locale.startsWith('en')) ? 'en' : 'es',
          userMessage: sanitizedText,
          correlationId: options?.correlationId,
        });
        if (ackResult.success) {
          finalReply = ackResult.confirmation || ackResult.formattedCard;
          plan.intent = 'reminder';
        }
      } else {
        const candidates = [
          ...(dailyOverview?.pendingConfirmationReminders || []),
          ...(dailyOverview?.timedRemindersToday || []),
        ];
        if (candidates.length > 0) {
          const refRes = resolveEntityReference({
            userOrPhone: user,
            reference: sanitizedText,
            candidates,
            preferredType: 'reminder',
          });
          if (refRes.status === 'RESOLVED') {
            const ackResult = await executeTool({
              toolName: 'manage_reminder',
              params: { action: 'acknowledge', reminderId: refRes.item.internalId },
              user,
              isPro,
              language: (user.locale && user.locale.startsWith('en')) ? 'en' : 'es',
              userMessage: sanitizedText,
              correlationId: options?.correlationId,
            });
            if (ackResult.success) {
              finalReply = ackResult.confirmation || ackResult.formattedCard;
              plan.intent = 'reminder';
            }
          } else if (refRes.status === 'AMBIGUOUS') {
            finalReply = (user.locale && user.locale.startsWith('en'))
              ? 'Multiple reminders match your request. Please clarify which one you completed.'
              : 'Hay más de un recordatorio pendiente que coincide con tu confirmación. ¿Cuál de ellos completaste?';
          }
        }
      }
    }
  }

  // Universal safety check: if reply has [auth_url] anywhere, replace with clean link
  if (finalReply && finalReply.includes('[auth_url]')) {
    try {
      const authUrl = getGoogleConnectUrl({ userId: user.id, phoneNumber: phoneNumber || user.phone_number });
      finalReply = finalReply.replace(/\[auth_url\]/g, authUrl);
    } catch (authErr) {
      console.warn('[router] generating auth_url for reply replacement failed:', authErr.message);
    }
  }

  // Universal check: if reply has [checkout_url] anywhere, replace with real link
  if (finalReply && finalReply.includes('[checkout_url]')) {
    try {
      const planRes = await getOrCreateCanonicalPlan({
        reason: 'Hermes TempleLabs Pro',
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
      finalReply = finalReply.replace(/\[checkout_url\]/g, planRes.init_point);
    } catch (err) {
      console.error('[router] auto-generating checkout_url failed:', err);
    }
  }

  const defaultNeutralReply = (user.locale && user.locale.startsWith('en'))
    ? 'I have processed your request. How else can I assist you today?'
    : 'He procesado tu solicitud. ¿En qué más te puedo colaborar hoy?';
  const rawReplyText = finalReply || plan.reply || defaultNeutralReply;

  // 5. Strict Output Sanitization: completely strip any accidental [id: ...] or raw UUIDs before delivery
  const finalReplyText = sanitizeResponseText(rawReplyText);

  const totalDurationMs = Date.now() - startMs;
  console.log(`[router req=${options?.correlationId || 'none'}] Out in ${totalDurationMs}ms: "${finalReplyText.slice(0, 80)}..."`);

  let inferredIntent = plan.intent || 'chat';
  if (plan.tool === 'manage_memory') inferredIntent = 'memory';
  else if (plan.tool === 'manage_reminder') inferredIntent = 'reminder';
  else if (plan.tool === 'manage_task') inferredIntent = 'task';
  else if (plan.tool === 'manage_entity') inferredIntent = 'entity';
  else if (plan.tool === 'manage_subscription' || plan.tool === 'get_subscription_link') inferredIntent = 'subscription';
  else if (plan.tool === 'manage_google_calendar') inferredIntent = 'calendar';
  else if (plan.tool === 'get_unified_agenda') inferredIntent = 'unified_agenda';
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
