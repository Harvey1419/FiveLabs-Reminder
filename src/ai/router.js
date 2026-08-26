import { executeTool } from './tools.js';
import { callChatCompletion } from './client.js';
import { retrieveRelevantMemories } from '../services/memoryService.js';
import { getDailyOverview } from '../db/index.js';
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

  // 1. Parallel Context Pre-fetch (~80-120ms)
  const [relevantMemories, dailyOverview] = await Promise.all([
    retrieveRelevantMemories({ userId: user.id, queryText: messageText, limit: 5 }),
    getDailyOverview({ userId: user.id, phoneNumber, timezone }),
  ]);

  const memoryHints = relevantMemories.length > 0
    ? relevantMemories.map(m => `- [${m.category || 'memoria'}] ${m.content}`).join('\n')
    : '';

  // 2. Build Authoritative Agent Core Grounded Prompt with RBAC exposure
  const prompt = buildAgentCorePrompt({
    nowStr,
    nowHumanStr,
    timezone,
    memoryHints,
    overview: dailyOverview,
    isAdmin,
  });

  const pastTurns = history.slice(-4);
  const messages = [
    { role: 'system', content: prompt },
    ...pastTurns,
    { role: 'user', content: messageText },
  ];

  let plan = { type: 'chat', tool: null, params: {}, intent: 'chat', reply: '' };

  try {
    const rawText = await callChatCompletion(messages, { max_tokens: 2500 });
    const jsonStr = extractFirstJsonObject(rawText);
    if (jsonStr) {
      plan = JSON.parse(jsonStr);
    } else if (rawText && !rawText.startsWith('{')) {
      plan.reply = rawText;
    }
  } catch (err) {
    console.warn('[router] planning failed:', err.message);
  }

  // 3. Tool Execution if requested (Supports Batch Creation)
  if (plan.type === 'tool_call' && plan.tool) {
    const toolResult = await executeTool(plan.tool, plan.params || {}, user);
    console.log(`[router] Tool ${plan.tool} executed (${toolResult.action}):`, toolResult.rawSummary);

    // Dynamic cancellation count enrichment
    if (toolResult.action === 'cancelled_reminders' && toolResult.data) {
      const { cancelledCount } = toolResult.data;
      if (plan.params?.keepLatest) {
        plan.reply = `¡Listo! Eliminé ${cancelledCount} recordatorio(s) anterior(es) y te dejé solo el último 🗑️⏰`;
      } else if (plan.params?.cancelAll) {
        plan.reply = `¡Listo! Eliminé todos tus recordatorios pendientes (${cancelledCount} en total) 🗑️`;
      }
    }
  }

  const finalReply = plan.reply || '¡Entendido! Lo tengo presente en tus notas.';
  const totalDurationMs = Date.now() - startMs;
  console.log(`[router] Out in ${totalDurationMs}ms: "${finalReply.slice(0, 80)}..."`);

  const isEnglish = (user.locale && user.locale.startsWith('en')) || /\b(hello|hi|good morning|schedule|remind me|please|help me|thank you|thanks)\b/i.test(messageText);

  return {
    intent: plan.intent || 'chat',
    entities: plan.params || {},
    language: isEnglish ? 'en' : 'es',
    confirmation: finalReply,
  };
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
