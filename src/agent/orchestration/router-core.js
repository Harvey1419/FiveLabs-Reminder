import { callChatCompletion, callResponseSynthesis } from '../providers/client.js';
import { retrieveRelevantMemories } from '../../features/memory/service.js';
import {
  getDailyOverview,
  getUserSubscription,
  getUserIntegration,
  hasProAccess,
  createPendingSubscription,
} from '../../infrastructure/database/index.js';
import { getOrCreateCanonicalPlan } from '../../integrations/mercado-pago/client.js';
import { getGoogleConnectUrl } from '../../integrations/google/auth.js';
import { buildAgentCorePrompt } from '../core/agent-core.js';
import {
  formatWorkingMemoryPrompt,
  getWorkingMemory,
  getWorkingMemorySnapshot,
  hydrateWorkingMemoryFromHistory,
  sanitizeResponseText,
} from '../core/working-memory.js';
import { hydrateClarificationStateFromHistory, getClarificationStateSnapshot } from './clarification-flow.js';
import { composeExecutionReply } from '../core/execution-facts.js';
import { isAdminUser } from '../../shared/auth.js';
import { nowISO, nowHuman, computeOffsetMinutes } from '../../shared/time.js';
import { TOOL_NAMES } from '../contracts/tool-names.js';
import { parseIntentArguments, validateTurnIntent } from '../contracts/intent-contracts.js';
import {
  getStructuredTurnSchema,
  projectStructuredTurnIntent,
  stripStructuredNulls,
} from '../contracts/foreground-turn-schema.js';
import { executeTurnIntent, inferIntentFromTool } from './intent-executor.js';
import { normalizeTurnIntentForRuntime } from './intent-normalizer.js';
import { mergePendingIntentActions } from '../core/pending-intent.js';

const MAX_HISTORY_TURNS = 30;
const MAX_HISTORY_CHARS = 12000;
const MAX_HISTORY_TURN_CHARS = 2000;

function safeLogSnippet(value, maxLength = 120) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (!text) return '';
  return text.length > maxLength ? `${text.slice(0, maxLength)}…` : text;
}

function summarizeAction(action = {}) {
  const parts = [`${action.domain || 'unknown'}.${action.action || 'unknown'}`];
  if (action.target) parts.push(`target="${safeLogSnippet(action.target, 70)}"`);
  if (action.scope) parts.push(`scope=${action.scope}`);
  if (action.schedule?.kind) parts.push(`schedule=${action.schedule.kind}`);
  if (action.recurrence) parts.push(`recurrence=${action.recurrence}`);
  if (action.content || action.title || action.newName) parts.push('hasContentDelta=true');
  return parts.join(' ');
}

function compactHistoryForModel(history = []) {
  const valid = history
    .filter((turn) => turn && ['user', 'assistant'].includes(turn.role) && typeof turn.content === 'string')
    .slice(-MAX_HISTORY_TURNS)
    .map(({ role, content }) => ({ role, content: content.slice(-MAX_HISTORY_TURN_CHARS) }));

  const selected = [];
  let usedChars = 0;
  for (let index = valid.length - 1; index >= 0; index -= 1) {
    const turn = valid[index];
    const size = turn.content.length;
    if (selected.length > 0 && usedChars + size > MAX_HISTORY_CHARS) break;
    selected.push(turn);
    usedChars += size;
  }
  return selected.reverse();
}

function normalizeModelResponse(modelResponse) {
  if (!modelResponse || typeof modelResponse !== 'object' || Array.isArray(modelResponse)) {
    return { content: typeof modelResponse === 'string' ? modelResponse.trim() : '', toolCalls: [], unavailable: false };
  }
  const toolCalls = (modelResponse.tool_calls || []).map((toolCall, index) => ({
    id: toolCall.id || `call_${index + 1}`,
    name: toolCall.function?.name || toolCall.name,
    arguments: toolCall.function?.arguments ?? toolCall.arguments ?? '{}',
  })).filter((call) => Boolean(call.name));
  return {
    content: typeof modelResponse.content === 'string' ? modelResponse.content.trim() : '',
    toolCalls,
    unavailable: modelResponse.unavailable === true,
    unavailableReason: modelResponse.unavailableReason || null,
    refused: modelResponse.refused === true,
    structuredIntent: modelResponse.structuredIntent || null,
  };
}

function collectIntent(toolCalls, { isAdmin = false } = {}) {
  const executeCalls = toolCalls.filter((call) => call.name === TOOL_NAMES.EXECUTE_TURN);
  const replyCalls = toolCalls.filter((call) => call.name === TOOL_NAMES.REPLY_TO_USER);
  const unknownCalls = toolCalls.filter((call) => ![TOOL_NAMES.EXECUTE_TURN, TOOL_NAMES.REPLY_TO_USER].includes(call.name));
  if (unknownCalls.length > 0 || (executeCalls.length > 0 && replyCalls.length > 0) || replyCalls.length > 1) {
    return { valid: false, errorCode: 'UNKNOWN_TOOL', error: 'El modelo intentó usar una combinación de capacidades no disponible.' };
  }
  if (replyCalls.length === 1) {
    const parsed = parseIntentArguments(replyCalls[0].arguments);
    const content = typeof parsed?.content === 'string' ? parsed.content.trim() : '';
    if (!content) return { valid: false, errorCode: 'MISSING_CONTENT', error: 'reply_to_user requiere contenido.' };
    return { valid: true, intent: { actions: [{ domain: 'conversation', action: 'reply', content }], excluded: [] } };
  }
  if (executeCalls.length === 0) return { valid: true, intent: null };

  const actions = [];
  const excluded = [];
  for (const call of executeCalls) {
    const parsed = parseIntentArguments(call.arguments);
    if (!parsed) return { valid: false, errorCode: 'INVALID_PARAMETERS', error: 'La decisión estructurada no era JSON válido.' };
    const validation = validateTurnIntent(parsed, { isAdmin });
    if (!validation.valid) return validation;
    actions.push(...validation.intent.actions);
    excluded.push(...validation.intent.excluded);
  }
  if (actions.length > 12) {
    return { valid: false, errorCode: 'TURN_ACTION_LIMIT', error: 'La solicitud contiene demasiadas acciones para un solo turno.' };
  }
  return { valid: true, intent: { actions, excluded } };
}

function conversationReplyFromActions(actions = []) {
  return actions
    .filter((action) => action.domain === 'conversation' && action.action === 'reply')
    .map((action) => sanitizeResponseText(action.content || ''))
    .filter(Boolean)
    .join('\n\n');
}

function parseStructuredTurnDecision(modelResponse, { isAdmin = false } = {}) {
  if (modelResponse?.unavailable) return { unavailable: true, validation: null };
  if (modelResponse?.toolCalls?.length) return { unavailable: false, validation: { valid: false, errorCode: 'INVALID_PARAMETERS', error: 'La decisión foreground no admite llamadas a herramientas.' } };
  if (modelResponse?.structuredIntent) return { unavailable: false, validation: { valid: true, intent: modelResponse.structuredIntent } };
  return { unavailable: false, validation: validateStructuredTurnContent(modelResponse?.content, { isAdmin }) };
}

function validateStructuredTurnContent(content, { isAdmin = false, pendingIntent = null } = {}) {
  const parsed = parseIntentArguments(content);
  if (!parsed) return { valid: false, errorCode: 'INVALID_PARAMETERS', error: 'La decisión estructurada no era JSON válido.' };
  const canonical = projectStructuredTurnIntent(stripStructuredNulls(parsed));
  const validation = validateTurnIntent(canonical, { isAdmin });
  if (!validation.valid) return validation;

  const effect = validation.intent.pendingIntentEffect || null;
  const continuationActions = validation.intent.actions.filter((action) => !['conversation', 'clarification', 'pending'].includes(action.domain));
  if (effect && !pendingIntent) {
    // A stale transition marker is harmless only when the current actions form
    // a valid standalone TurnIntent after removing it. Complete operations can
    // execute and typed partial operations can start a fresh draft; fragments
    // that depended on missing prior state still fail closed.
    const { pendingIntentEffect: _effect, ...intent } = validation.intent;
    const standalone = validateTurnIntent(intent, { isAdmin });
    if (standalone.valid) return standalone;
    return { valid: false, errorCode: 'NO_PENDING_INTENT', error: 'La respuesta intentó continuar un estado que ya no está disponible.' };
  }
  if (pendingIntent && !effect && continuationActions.length > 0) {
    return { valid: false, errorCode: 'PENDING_INTENT_EFFECT_REQUIRED', error: 'La respuesta no declaró cómo relacionar la operación actual con la intención pendiente.' };
  }
  if (effect === 'resolve') {
    const merged = mergePendingIntentActions(pendingIntent, continuationActions);
    if (!merged.valid) return merged;
    const complete = validateTurnIntent({ actions: merged.actions }, { isAdmin });
    if (!complete.valid) return { valid: false, errorCode: 'INCOMPLETE_PENDING_CONTINUATION', error: 'La continuación aún no produce una operación completa.' };
  }
  return validation;
}

function enforceAttachmentOnlyIntent(collected, isAttachmentOnlyTurn) {
  if (!isAttachmentOnlyTurn || !collected?.valid || !collected.intent) return collected;
  const hasOperationalAction = collected.intent.actions.some((action) => action?.domain !== 'conversation');
  if (!hasOperationalAction) return collected;
  return {
    valid: false,
    errorCode: 'UNTRUSTED_ATTACHMENT_ACTION',
    error: 'El contenido de un adjunto sin instrucción confiable del usuario no puede originar acciones operativas.',
  };
}

export function bindAuthoritativeFollowupTargets(intent, overview) {
  if (!intent || !Array.isArray(intent.actions)) return intent;
  const active = Array.isArray(overview?.pendingConfirmationReminders)
    ? overview.pendingConfirmationReminders
    : [];
  if (active.length !== 1) return intent;

  const reminder = active[0];
  const humanTarget = String(reminder?.content || reminder?.title || '').trim();
  if (!humanTarget) return intent;

  return {
    ...intent,
    actions: intent.actions.map((action) => {
      if (action?.domain !== 'reminder' || action?.action !== 'acknowledge' || action?.target) return action;
      return { ...action, target: humanTarget };
    }),
  };
}

function conversationStateEntities(user, extra = {}) {
  return {
    ...extra,
    _conversationState: getClarificationStateSnapshot(user),
    _workingMemory: getWorkingMemorySnapshot(user),
  };
}

async function replaceTrustedLinkPlaceholders({ text, user, phoneNumber }) {
  let finalText = text || '';
  if (finalText.includes('[auth_url]')) {
    try {
      const authUrl = getGoogleConnectUrl({ userId: user.id, phoneNumber: phoneNumber || user.phone_number });
      finalText = finalText.replace(/\[auth_url\]/g, authUrl);
    } catch (error) {
      console.warn('[router] generating auth_url failed:', error.message);
    }
  }

  if (finalText.includes('[checkout_url]')) {
    try {
      const plan = await getOrCreateCanonicalPlan({
        reason: 'Hermes TempleLabs Pro', amount: 49900, currency: 'COP', phoneNumber: phoneNumber || user.phone_number,
      });
      if (user?.id) {
        await createPendingSubscription(user.id, {
          mpPreapprovalId: plan.id, amount: plan.amount || 49900, plan: 'pro',
        }).catch(() => {});
      }
      finalText = finalText.replace(/\[checkout_url\]/g, plan.init_point);
    } catch (error) {
      console.error('[router] auto-generating checkout_url failed:', error.message);
    }
  }
  return finalText;
}

function safeIntentError(language) {
  return language === 'en'
    ? 'I understood that you want me to do something, but I could not safely translate it into an action. Please send the request again.'
    : 'Entendí que quieres que haga algo, pero no pude convertirlo en una acción segura. Envíamelo de nuevo, por favor.';
}

function structuredDecisionError(language) {
  return language === 'en'
    ? 'I could not produce a safe structured decision for that message. Please send it again.'
    : 'No pude producir una decisión estructurada segura para ese mensaje. Envíamelo de nuevo, por favor.';
}

function providerUnavailableError(language) {
  return language === 'en'
    ? 'I could not complete that action right now. I did not execute anything. Please try again in a moment.'
    : 'No pude completar esa acción en este momento. No ejecuté ninguna acción. Inténtalo nuevamente en un momento.';
}

/**
 * Canonical agent route:
 * context -> one Hermes semantic decision -> TurnIntent -> deterministic tools -> cards.
 * execute_turn is mandatory even for ordinary conversation; there is no prose
 * bypass and no second semantic recovery call.
 */
export async function routeMessage(messageText, userOrPhone, history = [], options = {}) {
  const startMs = Date.now();
  const requestedReferenceMs = options?.requestTimeMs == null ? NaN : Number(options.requestTimeMs);
  const requestReferenceTime = new Date(Number.isFinite(requestedReferenceMs) ? requestedReferenceMs : startMs);
  const user = typeof userOrPhone === 'string'
    ? { phone_number: userOrPhone, timezone: 'America/Bogota', locale: 'es-CO' }
    : (userOrPhone || { phone_number: '', timezone: 'America/Bogota', locale: 'es-CO' });
  const timezone = user.timezone || 'America/Bogota';
  const phoneNumber = user.phone_number;
  const language = user.locale?.startsWith('en') ? 'en' : 'es';
  const isAdmin = isAdminUser(user);
  const requestId = options?.correlationId || 'none';
  const inputModality = options?.inputModality || 'text';

  computeOffsetMinutes(timezone, requestReferenceTime);
  const nowStr = nowISO(timezone, requestReferenceTime);
  const nowHumanStr = nowHuman(timezone, language, requestReferenceTime);
  console.log(`[router req=${requestId}] in modality=${inputModality} text="${safeLogSnippet(messageText, 180)}" phone=${phoneNumber} tz=${timezone} admin=${isAdmin}`);

  const trustedMessageText = String(messageText || '')
    .replace(/<untrusted_attachment_content>[\s\S]*?<\/untrusted_attachment_content>/gi, '')
    .trim();
  const hasAttachmentEvidence = /<untrusted_attachment_content>/i.test(String(messageText || ''));
  const isAttachmentOnlyTurn = options?.attachmentOnly === true || (hasAttachmentEvidence && !trustedMessageText);

  hydrateClarificationStateFromHistory(user, history);
  hydrateWorkingMemoryFromHistory(user, history, requestReferenceTime);

  const contextStart = Date.now();
  const [relevantMemories, dailyOverview, subscription, googleIntegration] = await Promise.all([
    retrieveRelevantMemories({ userId: user.id, queryText: messageText, limit: 3 }),
    getDailyOverview({ userId: user.id, phoneNumber, timezone }),
    user.id ? getUserSubscription(user.id) : Promise.resolve(null),
    user.id ? getUserIntegration(user.id, 'google') : Promise.resolve(null),
  ]);
  const contextElapsedMs = Date.now() - contextStart;

  const effectiveSub = subscription || user.subscription;
  const isPro = hasProAccess(effectiveSub, user);
  user.subscription = effectiveSub;
  user.isPro = isPro;
  user.memories = relevantMemories || [];

  const memoryHints = (relevantMemories || []).length > 0
    ? relevantMemories.map((memory) => `- [${memory.category || 'memoria'}] ${memory.content}`).join('\n')
    : '';
  const workingMemoryKey = phoneNumber || user.id;
  const workingMemory = getWorkingMemory(workingMemoryKey);
  const workingMemoryText = formatWorkingMemoryPrompt(workingMemoryKey);
  if (workingMemory) {
    console.log(
      `[router req=${requestId}] working-memory source=${workingMemory.source || 'unknown'} lastAction=${workingMemory.lastAction || 'unknown'} items=${workingMemory.items?.length || 0} pendingClarifications=${workingMemory.pendingClarifications?.length || 0} notification="${safeLogSnippet(workingMemory.notificationContent, 100)}"`,
    );
  } else {
    console.log(`[router req=${requestId}] working-memory empty`);
  }
  console.log(`[router req=${requestId}] context loaded in ${contextElapsedMs}ms memories=${relevantMemories?.length || 0} activeNotices=${dailyOverview?.pendingConfirmationReminders?.length || 0} google=${googleIntegration ? 'present' : 'absent'} pro=${isPro}`);

  const prompt = buildAgentCorePrompt({
    nowStr, nowHumanStr, timezone, phoneNumber, memoryHints, overview: dailyOverview,
    workingMemoryText, googleIntegration, isAdmin, isPro, displayName: user.display_name,
  });

  let rawPastTurns = Array.isArray(history) ? history.slice() : [];
  const lastTurn = rawPastTurns.at(-1);
  if (lastTurn?.role === 'user' && (lastTurn.content === messageText || lastTurn.content === trustedMessageText)) rawPastTurns.pop();
  const pendingOrigin = rawPastTurns.at(-1)?.entities?._conversationState?.pendingIntent;
  if (workingMemory?.pendingIntent && pendingOrigin?.actions?.length) {
    // The typed pending draft is the compact operational source of truth. Do
    // not also replay the user/assistant pair that created it, which can make
    // a model re-emit already executed siblings from that original batch.
    rawPastTurns = rawPastTurns.slice(0, rawPastTurns.at(-2)?.role === 'user' ? -2 : -1);
  }
  const pastTurns = compactHistoryForModel(rawPastTurns);
  const latestAssistantMessage = [...pastTurns].reverse().find((turn) => turn.role === 'assistant')?.content || '';
  const historyChars = pastTurns.reduce((sum, turn) => sum + turn.content.length, 0);

  const messages = [
    { role: 'system', content: prompt },
    ...pastTurns,
    { role: 'user', content: messageText },
  ];
  const turnResponseFormat = { type: 'json_schema', json_schema: { name: 'hermes_turn_intent', strict: true, schema: getStructuredTurnSchema({ isAdmin, attachmentOnly: isAttachmentOnlyTurn }) } };

  console.log(`[router req=${requestId}] model context promptChars=${prompt.length} historyTurns=${pastTurns.length} historyChars=${historyChars} memories=${relevantMemories?.length || 0}`);

  const modelStart = Date.now();
  let modelResponse;
  try {
    modelResponse = await callChatCompletion(messages, {
      // Full nullable JSON for up to twelve actions, with room for model reasoning.
      max_tokens: 8192,
      correlationId: options?.correlationId,
      tools: null,
      toolChoice: 'none',
      responseFormat: turnResponseFormat,
      returnMessage: true,
      purpose: 'initial',
      language,
      validateStructuredContent: (content) => validateStructuredTurnContent(content, { isAdmin, pendingIntent: workingMemory?.pendingIntent || null }),
    });
  } catch (error) {
    console.warn(`[router req=${requestId}] model failed:`, error.message);
    modelResponse = { content: '', tool_calls: [], unavailable: true };
  }
  let modelElapsedMs = Date.now() - modelStart;
  const decision = normalizeModelResponse(modelResponse);
  console.log(`[router req=${requestId}] model decision in ${modelElapsedMs}ms structuredChars=${decision.content.length} unavailable=${decision.unavailable}`);
  const structuredDecision = parseStructuredTurnDecision(decision, { isAdmin });
  let collected = structuredDecision.unavailable ? { valid: true, intent: null } : structuredDecision.validation;
  collected = enforceAttachmentOnlyIntent(collected, isAttachmentOnlyTurn);

  if (!collected.valid) {
    console.warn(`[router req=${requestId}] rejected semantic intent: ${collected.errorCode} ${collected.error}`);
    return {
      intent: 'clarification',
      entities: conversationStateEntities(user),
      language,
      confirmation: safeIntentError(language),
      ctaUrl: null, ctaHeader: null, ctaButtonText: null,
      plan: { type: 'invalid_intent' }, executionFacts: [], memoryDisposition: 'skip_operational',
    };
  }

  if (!collected.intent) {
    const confirmation = decision.refused
      ? (language === 'en' ? 'I cannot complete that request. I did not execute any action.' : 'No puedo completar esa solicitud. No ejecuté ninguna acción.')
      : decision.unavailable
      ? providerUnavailableError(language)
      : structuredDecisionError(language);
    console.warn(`[router req=${requestId}] required structured tool missing; refusing prose bypass`);
    return {
      intent: 'clarification',
      entities: conversationStateEntities(user),
      language,
      confirmation,
      ctaUrl: null,
      ctaHeader: null,
      ctaButtonText: null,
      plan: {
        type: decision.refused
          ? 'provider_refusal'
          : decision.unavailableReason === 'schema_rejection'
            ? 'schema_rejection'
            : ['invalid_structured_output', 'structured_generation_rejection'].includes(decision.unavailableReason)
              ? 'invalid_structured_output'
              : decision.unavailable ? 'provider_unavailable' : 'missing_structured_decision',
      },
      executionFacts: [],
      memoryDisposition: 'skip_operational',
    };
  }

  const semanticIntent = bindAuthoritativeFollowupTargets(collected.intent, dailyOverview);
  console.log(`[router req=${requestId}] semantic intent actions=${semanticIntent.actions.map(summarizeAction).join(' | ')}`);
  const runtimeIntent = normalizeTurnIntentForRuntime(semanticIntent, {
    user,
    referenceTime: requestReferenceTime,
    timezone,
  });
  console.log(`[router req=${requestId}] runtime intent actions=${runtimeIntent.actions.map(summarizeAction).join(' | ')}`);

  const conversationReply = conversationReplyFromActions(runtimeIntent.actions);
  const operationalActions = runtimeIntent.actions.filter((action) => action.domain !== 'conversation');

  if (operationalActions.length === 0) {
    const confirmation = conversationReply || structuredDecisionError(language);
    console.log(`[router req=${requestId}] structured conversation out in ${Date.now() - startMs}ms (context=${contextElapsedMs}ms model=${modelElapsedMs}ms)`);
    return {
      intent: 'chat',
      entities: conversationStateEntities(user),
      language,
      confirmation,
      ctaUrl: null,
      ctaHeader: null,
      ctaButtonText: null,
      plan: { type: 'turn_intent', actions: runtimeIntent.actions.map(({ domain, action }) => ({ domain, action })) },
      executionFacts: [],
      memoryDisposition: isAttachmentOnlyTurn ? 'skip_attachment' : 'extract',
    };
  }

  for (const action of operationalActions) {
    const isEmptyReminderUpdate = action.domain === 'reminder'
      && action.action === 'update'
      && !action.content
      && !action.title
      && !action.newName
      && !action.schedule
      && !action.recurrence
      && !action.advanceMinutes;
    if (isEmptyReminderUpdate) {
      console.warn(
        `[router req=${requestId}] suspicious empty reminder.update target="${safeLogSnippet(action.target, 90)}" activeNotification="${safeLogSnippet(workingMemory?.notificationContent, 90)}" lastAction=${workingMemory?.lastAction || 'none'}`,
      );
    }
  }

  const toolStart = Date.now();
  const execution = await executeTurnIntent({ ...runtimeIntent, actions: operationalActions }, {
    user, isPro, language,
    userMessage: trustedMessageText || messageText,
    referenceTime: requestReferenceTime,
    timezone,
    correlationId: options?.correlationId,
    latestAssistantMessage,
  });
  const toolElapsedMs = Date.now() - toolStart;
  execution.records.forEach(({ toolName, result }, index) => {
    console.log(
      `[router req=${requestId}] execution[${index + 1}] tool=${toolName || 'unknown'} success=${Boolean(result?.success)} action=${result?.action || 'unknown'} errorCode=${result?.errorCode || 'none'}`,
    );
  });

  let framing = conversationReply ? { before: conversationReply, after: '' } : null;
  if ((execution.excluded || []).length > 0 && execution.facts.length > 0) {
    const synthesisStart = Date.now();
    const excludedFraming = await callResponseSynthesis({
      userText: trustedMessageText || messageText,
      facts: execution.facts,
      excludedClauses: execution.excluded,
      language,
      correlationId: options?.correlationId,
    });
    modelElapsedMs += Date.now() - synthesisStart;
    const before = [conversationReply, excludedFraming?.before].filter(Boolean).join('\n\n');
    framing = before ? { before, after: '' } : null;
  }

  let finalReply = composeExecutionReply(execution.facts, language, { framing });
  if (!finalReply) finalReply = safeIntentError(language);
  finalReply = await replaceTrustedLinkPlaceholders({ text: finalReply, user, phoneNumber });
  finalReply = sanitizeResponseText(finalReply);

  const primary = execution.records[0] || null;
  const ctaFact = execution.facts.find((fact) => fact.ctaUrl) || null;
  const ctaRecord = execution.records.find(({ result }) => result?.ctaUrl || result?.data?.auth_url || result?.data?.checkout_url) || null;

  console.log(`[router req=${requestId}] action out in ${Date.now() - startMs}ms (context=${contextElapsedMs}ms model=${modelElapsedMs}ms tools=${toolElapsedMs}ms actions=${runtimeIntent.actions.length})`);

  return {
    intent: inferIntentFromTool(primary?.toolName),
    entities: conversationStateEntities(user, {
      ...(primary?.params && typeof primary.params === 'object' && !Array.isArray(primary.params) ? primary.params : {}),
    }),
    language,
    confirmation: finalReply,
    ctaUrl: ctaFact?.ctaUrl || ctaRecord?.result?.data?.auth_url || ctaRecord?.result?.data?.checkout_url || null,
    ctaHeader: ctaFact?.ctaHeader || null,
    ctaButtonText: ctaFact?.ctaButtonText || null,
    plan: { type: 'turn_intent', actions: runtimeIntent.actions.map(({ domain, action }) => ({ domain, action })) },
    executionFacts: execution.facts,
    memoryDisposition: 'skip_operational',
  };
}
