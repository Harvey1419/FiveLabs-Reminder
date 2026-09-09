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
import { formatWorkingMemoryPrompt, getWorkingMemory, sanitizeResponseText } from '../core/working-memory.js';
import { hydrateClarificationStateFromHistory, getClarificationStateSnapshot } from './clarification-flow.js';
import { composeExecutionReply } from '../core/execution-facts.js';
import { isAdminUser } from '../../shared/auth.js';
import { nowISO, nowHuman, computeOffsetMinutes } from '../../shared/time.js';
import { TOOL_NAMES } from '../contracts/tool-names.js';
import { getIntentToolDefinitions, parseIntentArguments, validateTurnIntent } from '../contracts/intent-contracts.js';
import { executeTurnIntent, inferIntentFromTool } from './intent-executor.js';
import { normalizeTurnIntentForRuntime } from './intent-normalizer.js';

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
  };
}

function collectIntent(toolCalls, { isAdmin = false } = {}) {
  const executeCalls = toolCalls.filter((call) => call.name === TOOL_NAMES.EXECUTE_TURN);
  const unknownCalls = toolCalls.filter((call) => call.name !== TOOL_NAMES.EXECUTE_TURN);
  if (unknownCalls.length > 0) {
    return { valid: false, errorCode: 'UNKNOWN_TOOL', error: 'El modelo intentó usar una capacidad no disponible.' };
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

function getAttachmentOnlyIntentTools({ isAdmin = false } = {}) {
  const tools = getIntentToolDefinitions({ isAdmin });
  const actionSchema = tools?.[0]?.function?.parameters?.properties?.actions?.items;
  if (actionSchema?.properties?.domain) {
    actionSchema.properties.domain.enum = ['conversation'];
  }
  return tools;
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

/**
 * Bind backend-authoritative interaction state to semantic actions without
 * exposing database IDs to the model. This never infers an operation: it only
 * fills identity for an acknowledge action Hermes has already selected.
 */
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
    ? 'I understood that you want me to do something, but I could not safely translate it into an action. Please rephrase it in one sentence.'
    : 'Entendí que quieres que haga algo, pero no pude convertirlo en una acción segura. Dímelo de nuevo en una sola frase.';
}

function structuredDecisionError(language) {
  return language === 'en'
    ? 'I had a small problem interpreting that message. Please send it again.'
    : 'Tuve un pequeño problema interpretando ese mensaje. Envíamelo de nuevo, por favor.';
}

function buildRecoveryMessages({ prompt, pastTurns, messageText }) {
  const recoveryInstruction = `\n\n## RECUPERACIÓN DE PROTOCOLO\nTu respuesta anterior no usó el protocolo estructurado. Devuelve exactamente una llamada a execute_turn. No respondas en prosa fuera de la llamada. Si el turno es conversación normal, agradecimiento, despedida, pregunta personal respondible desde el contexto o charla cotidiana, usa conversation.reply con el texto natural en content. Si el turno consulta o modifica estado operativo, usa el dominio correspondiente para que Node consulte la fuente de verdad.`;
  return [
    { role: 'system', content: `${prompt}${recoveryInstruction}` },
    ...pastTurns,
    { role: 'user', content: messageText },
  ];
}

/**
 * Canonical agent route:
 * context -> Hermes semantic decision -> TurnIntent -> deterministic tools -> cards.
 * Model prose is never an alternate execution path. All ordinary conversation,
 * including greetings, uses conversation.reply through the same protocol.
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
  const isAttachmentOnlyTurn = hasAttachmentEvidence && !trustedMessageText;

  hydrateClarificationStateFromHistory(user, history);

  const contextStart = Date.now();
  const [relevantMemories, dailyOverview, subscription, googleIntegration] = await Promise.all([
    retrieveRelevantMemories({ userId: user.id, queryText: messageText, limit: 5 }),
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

  let pastTurns = Array.isArray(history) ? history.slice() : [];
  const lastTurn = pastTurns.at(-1);
  if (lastTurn?.role === 'user' && (lastTurn.content === messageText || lastTurn.content === trustedMessageText)) pastTurns.pop();
  pastTurns = pastTurns
    .filter((turn) => turn && ['user', 'assistant'].includes(turn.role) && typeof turn.content === 'string')
    .slice(-14)
    .map(({ role, content }) => ({ role, content }));
  const latestAssistantMessage = [...pastTurns].reverse().find((turn) => turn.role === 'assistant')?.content || '';

  const messages = [
    { role: 'system', content: prompt },
    ...pastTurns,
    { role: 'user', content: messageText },
  ];
  const intentTools = isAttachmentOnlyTurn
    ? getAttachmentOnlyIntentTools({ isAdmin })
    : getIntentToolDefinitions({ isAdmin });

  const modelStart = Date.now();
  let modelResponse;
  try {
    modelResponse = await callChatCompletion(messages, {
      max_tokens: 2000,
      correlationId: options?.correlationId,
      tools: intentTools,
      toolChoice: isAttachmentOnlyTurn ? 'required' : 'auto',
      returnMessage: true,
      purpose: 'initial',
    });
  } catch (error) {
    console.warn(`[router req=${requestId}] model failed:`, error.message);
    modelResponse = { content: '', tool_calls: [], unavailable: true };
  }
  let modelElapsedMs = Date.now() - modelStart;
  let decision = normalizeModelResponse(modelResponse);
  console.log(`[router req=${requestId}] model decision in ${modelElapsedMs}ms toolCalls=${decision.toolCalls.length} proseChars=${decision.content.length} unavailable=${decision.unavailable}`);
  let collected = collectIntent(decision.toolCalls, { isAdmin });
  collected = enforceAttachmentOnlyIntent(collected, isAttachmentOnlyTurn);

  if (!collected.valid) {
    console.warn(`[router req=${requestId}] rejected semantic intent: ${collected.errorCode} ${collected.error}`);
    return {
      intent: 'clarification',
      entities: { _conversationState: getClarificationStateSnapshot(user) },
      language,
      confirmation: safeIntentError(language),
      ctaUrl: null, ctaHeader: null, ctaButtonText: null,
      plan: { type: 'invalid_intent' }, executionFacts: [], memoryDisposition: 'skip_operational',
    };
  }

  if (!collected.intent && !isAttachmentOnlyTurn && !decision.unavailable) {
    console.warn(`[router req=${requestId}] prose-only semantic miss; attempting one structured recovery`);
    const recoveryStart = Date.now();
    try {
      const recoveryResponse = await callChatCompletion(buildRecoveryMessages({ prompt, pastTurns, messageText }), {
        max_tokens: 1200,
        correlationId: options?.correlationId,
        tools: intentTools,
        toolChoice: 'auto',
        returnMessage: true,
        purpose: 'structured_recovery',
        startStage: 'secondary',
      });
      modelElapsedMs += Date.now() - recoveryStart;
      decision = normalizeModelResponse(recoveryResponse);
      collected = collectIntent(decision.toolCalls, { isAdmin });
      console.log(`[router req=${requestId}] recovery decision toolCalls=${decision.toolCalls.length} proseChars=${decision.content.length} unavailable=${decision.unavailable}`);
    } catch (error) {
      modelElapsedMs += Date.now() - recoveryStart;
      console.warn(`[router req=${requestId}] structured recovery failed:`, error.message);
      decision = { content: '', toolCalls: [], unavailable: true };
      collected = { valid: true, intent: null };
    }

    if (!collected.valid) {
      console.warn(`[router req=${requestId}] rejected recovered semantic intent: ${collected.errorCode} ${collected.error}`);
      return {
        intent: 'clarification',
        entities: { _conversationState: getClarificationStateSnapshot(user) },
        language,
        confirmation: safeIntentError(language),
        ctaUrl: null, ctaHeader: null, ctaButtonText: null,
        plan: { type: 'invalid_recovered_intent' }, executionFacts: [], memoryDisposition: 'skip_operational',
      };
    }
  }

  if (!collected.intent) {
    const confirmation = decision.unavailable && decision.content
      ? sanitizeResponseText(decision.content)
      : structuredDecisionError(language);
    console.warn(`[router req=${requestId}] structured decision missing after recovery; refusing prose bypass`);
    return {
      intent: 'clarification', entities: { _conversationState: getClarificationStateSnapshot(user) }, language, confirmation,
      ctaUrl: null, ctaHeader: null, ctaButtonText: null, plan: { type: 'missing_structured_decision' }, executionFacts: [], memoryDisposition: 'skip_operational',
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
      entities: { _conversationState: getClarificationStateSnapshot(user) },
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
    entities: {
      ...(primary?.params && typeof primary.params === 'object' && !Array.isArray(primary.params) ? primary.params : {}),
      _conversationState: getClarificationStateSnapshot(user),
    },
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
