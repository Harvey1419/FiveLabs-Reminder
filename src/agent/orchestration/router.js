import { executeTool } from '../tools/index.js';
import {
  callChatCompletion,
  callConversationalPresentation,
  callManifestCoverageVerification,
  callPendingTransitionVerification,
  callResponseSynthesis,
} from '../providers/client.js';
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
  saveWorkingMemory, clearWorkingMemory, getWorkingMemory, formatWorkingMemoryPrompt, sanitizeResponseText,
} from '../core/working-memory.js';
import {
  hydrateClarificationStateFromHistory,
  getClarificationStateSnapshot,
} from './clarification-flow.js';
import { getAgentToolDefinitions, parseToolArguments, validateToolCall } from '../contracts/tool-contracts.js';
import { composeExecutionReply, createExecutionFact } from '../core/execution-facts.js';
import { isAdminUser } from '../../shared/auth.js';
import { nowISO, nowHuman, computeOffsetMinutes } from '../../shared/time.js';
import {
  compileTurnManifest, resolveTypedSchedule, TURN_OPERATION_LIMIT,
} from './turn-plan.js';
import {
  MANIFEST_REPAIR_MODE,
  buildManifestRecoveryFeedback,
  getManifestRepairDirective,
} from './manifest-recovery.js';
import { formatAssistantClarification } from './clarification-presentation.js';

const MAX_TOOL_CALLS_PER_TURN = 6;
const MAX_MODEL_ROUNDS_PER_TURN = 4;
const MAX_MANIFEST_REPAIR_ATTEMPTS = 2;
const STANDALONE_GREETINGS = new Set([
  'hola', 'hello', 'hi', 'hey', 'buenos días', 'buenas tardes', 'buenas noches',
]);
const GREETING_PUNCTUATION = new Set(['!', '¡', '?', '¿', '.', ',', ';', ':']);

function normalizeStandaloneGreeting(value) {
  let normalized = [...String(value || '').toLocaleLowerCase()]
    .filter((character) => !GREETING_PUNCTUATION.has(character))
    .join('')
    .trim();
  while (normalized.includes('  ')) normalized = normalized.replaceAll('  ', ' ');
  return normalized;
}

function manifestShapeForLog(manifest) {
  const operations = Array.isArray(manifest?.operations) ? manifest.operations : [];
  const shape = operations.map((operation) => {
    const qualifiers = [
      operation.scope ? `scope=${operation.scope}` : '',
      operation.filter ? `filter=${operation.filter}` : '',
      operation.status ? `status=${operation.status}` : '',
      operation.category ? `category=${operation.category}` : '',
      operation.schedule?.kind ? `schedule=${operation.schedule.kind}` : '',
      operation.schedule?.clockMode ? `clockMode=${operation.schedule.clockMode}` : '',
      Number.isInteger(operation.schedule?.hour)
        ? `clock=${String(operation.schedule.hour).padStart(2, '0')}:${String(operation.schedule.minute ?? 0).padStart(2, '0')}`
        : '',
      operation.schedule?.kind === 'calendar_date_time'
        ? `date=${[operation.schedule.year, operation.schedule.month, operation.schedule.day].join('-')}`
        : '',
      operation.date && operation.schedule?.kind !== 'calendar_date_time'
        ? `dateField=${operation.date}`
        : '',
      Number.isInteger(operation.advanceMinutes) ? `advance=${operation.advanceMinutes}m` : '',
      operation.contextRef?.source
        ? `context=${operation.contextRef.source}:${operation.contextRef.position}`
        : '',
    ].filter(Boolean);
    return `${operation.kind || 'unknown'}${qualifiers.length ? `(${qualifiers.join(',')})` : ''}`;
  });
  return `operations=[${shape.join(';') || 'none'}] excluded=${Array.isArray(manifest?.excludedClauses) ? manifest.excludedClauses.length : 0}`;
}

function compactDiagnostic(value, maxLength = 240) {
  let compact = [...String(value || '')]
    .map((character) => character.trim() ? character : ' ')
    .join('')
    .trim();
  while (compact.includes('  ')) compact = compact.replaceAll('  ', ' ');
  return compact.slice(0, maxLength);
}

function logCoverageVerdict({ requestId, coverage, phase }) {
  if (!coverage) return;
  const details = coverage.verdict === 'incomplete'
    ? ` missing="${compactDiagnostic(coverage.missingQuote)}" feedback="${compactDiagnostic(coverage.feedback)}"`
    : '';
  const memory = coverage.memoryDisposition ? ` memory=${coverage.memoryDisposition}` : '';
  const proposal = coverage.assistantProposal
    ? ` proposal=${coverage.assistantProposal.kind}:${coverage.assistantProposal.scope}`
    : '';
  const clarification = coverage.assistantClarification
    ? ` clarification=${coverage.assistantClarification.kind}:${coverage.assistantClarification.missingFields.join(',')}`
    : '';
  const responseQuality = coverage.assistantResponseQuality === 'replace'
    ? ` responseQuality=replace:${coverage.responseConfidence}`
    : '';
  const requirement = coverage.manifestRequirement ? ` requirement=${coverage.manifestRequirement}` : '';
  console.log(`[router req=${requestId}] Manifest coverage phase=${phase} verdict=${coverage.verdict} confidence=${coverage.confidence}${requirement}${memory}${proposal}${clarification}${responseQuality}${details}`);
}

function safeRejectedManifestReply(language) {
  return language === 'en'
    ? 'I did not save any changes because I could not validate all the details. Please tell me what I should schedule and when.'
    : 'No guardé ningún cambio porque no pude validar todos los datos. Dime qué debo programar y cuándo.';
}

/**
 * Relevant context -> native LLM tool decision -> validated backend execution
 * -> response grounded exclusively in execution facts.
 */
export async function routeMessage(messageText, userOrPhone, history = [], options = {}) {
  const startMs = Date.now();
  const requestedReferenceMs = options?.requestTimeMs == null ? NaN : Number(options.requestTimeMs);
  const requestReferenceTime = new Date(Number.isFinite(requestedReferenceMs) ? requestedReferenceMs : startMs);
  let contextElapsedMs = 0;
  let modelElapsedMs = 0;
  let toolElapsedMs = 0;
  const user = typeof userOrPhone === 'string'
    ? { phone_number: userOrPhone, timezone: 'America/Bogota', locale: 'es-CO' }
    : (userOrPhone || { phone_number: '', timezone: 'America/Bogota', locale: 'es-CO' });

  const timezone = user.timezone || 'America/Bogota';
  const phoneNumber = user.phone_number;
  computeOffsetMinutes(timezone, requestReferenceTime);
  const nowStr = nowISO(timezone, requestReferenceTime);
  const nowHumanStr = nowHuman(timezone, user.locale === 'en-US' ? 'en' : 'es', requestReferenceTime);
  const isAdmin = isAdminUser(user);
  const language = user.locale?.startsWith('en') ? 'en' : 'es';
  const requestId = options?.correlationId || 'none';

  console.log(`[router req=${requestId}] in: "${messageText}" phone=${phoneNumber} tz=${timezone} admin=${isAdmin}`);

  const trustedMessageText = String(messageText || '')
    .replace(/<untrusted_attachment_content>[\s\S]*?<\/untrusted_attachment_content>/gi, '')
    .trim();
  const hasAttachmentEvidence = /<untrusted_attachment_content>/i.test(String(messageText || ''));
  const isAttachmentOnlyTurn = hasAttachmentEvidence && !trustedMessageText;

  // Pure protocol optimization only; no domain intent or mutation is inferred here.
  const normalizedGreeting = normalizeStandaloneGreeting(trustedMessageText);
  if (STANDALONE_GREETINGS.has(normalizedGreeting)) {
    const isEnglishGreeting = new Set(['hello', 'hi', 'hey']).has(normalizedGreeting);
    const greeting = isEnglishGreeting ? 'Hi! 👋\n\nHow can I help you?' : '¡Hola! 👋\n\n¿En qué te ayudo?';
    console.log(`[router req=${requestId}] Fast-path greeting: 0 LLM tokens, ${Date.now() - startMs}ms.`);
    return {
      intent: 'greeting', entities: {}, language: isEnglishGreeting ? 'en' : 'es', confirmation: greeting,
      ctaUrl: null, ctaHeader: null, ctaButtonText: null,
    };
  }

  // Restore typed pending state after a restart. Its interpretation remains a
  // model decision through execute_turn; no phrase catalogue is consulted.
  hydrateClarificationStateFromHistory(user, history);

  // Only semantically retrieved long-term memories enter the prompt. Live state
  // is orientation; each tool revalidates reads and mutations against backend truth.
  const contextStartMs = Date.now();
  const [relevantMemories, dailyOverview, subscription, googleIntegration] = await Promise.all([
    retrieveRelevantMemories({ userId: user.id, queryText: messageText, limit: 5 }),
    getDailyOverview({ userId: user.id, phoneNumber, timezone }),
    user.id ? getUserSubscription(user.id) : Promise.resolve(null),
    user.id ? getUserIntegration(user.id, 'google') : Promise.resolve(null),
  ]);
  contextElapsedMs = Date.now() - contextStartMs;

  const effectiveSub = subscription || user.subscription;
  const isPro = hasProAccess(effectiveSub, user);
  user.subscription = effectiveSub;
  user.isPro = isPro;
  user.memories = relevantMemories || [];

  const memoryHints = (relevantMemories || []).length > 0
    ? relevantMemories.map((memory) => `- [${memory.category || 'memoria'}] ${memory.content}`).join('\n')
    : '';
  const workingMemoryText = formatWorkingMemoryPrompt(phoneNumber || user.id);
  const prompt = buildAgentCorePrompt({
    nowStr, nowHumanStr, timezone, phoneNumber, memoryHints, overview: dailyOverview,
    workingMemoryText, googleIntegration, isAdmin, isPro, displayName: user.display_name,
  });

  let pastTurns = Array.isArray(history) ? history.slice() : [];
  const lastTurn = pastTurns.at(-1);
  if (lastTurn?.role === 'user' && (lastTurn.content === messageText || lastTurn.content === trustedMessageText)) {
    pastTurns.pop();
  }
  pastTurns = pastTurns
    .filter((turn) => turn && ['user', 'assistant'].includes(turn.role) && typeof turn.content === 'string')
    .slice(-14)
    .map(({ role, content }) => ({ role, content }));
  const latestAssistantMessage = [...pastTurns]
    .reverse()
    .find((turn) => turn.role === 'assistant')?.content || '';

  const messages = [
    { role: 'system', content: prompt },
    ...pastTurns,
    { role: 'user', content: messageText },
  ];

  // Attachment content may supply evidence, but it can never originate user
  // authorization. With no trusted caption/text, expose no backend tools.
  const toolDefinitions = isAttachmentOnlyTurn ? [] : getAgentToolDefinitions({ isAdmin });
  const hasPendingState = (getWorkingMemory(user)?.pendingClarifications || []).length > 0;
  const agentMessages = messages.slice();
  let decision = { content: '', toolCalls: [], legacyPlan: null };
  let finalModelContent = '';
  let directResponseVerified = false;
  const executionFacts = [];
  const executionRecords = [];
  const executedSignatures = new Map();
  let hasRecordedLimit = false;
  let manifestRepairAttempts = 0;
  let manifestRepairMode = null;
  let pendingTransitionRecovery = null;
  let excludedClauses = [];
  let memoryDisposition = 'extract';

  for (let round = 0; round < MAX_MODEL_ROUNDS_PER_TURN; round += 1) {
    let modelResponse;
    try {
      const modelStartMs = Date.now();
      const isManifestRepairRound = manifestRepairAttempts > 0;
      const isPendingTransitionRecoveryRound = Boolean(
        pendingTransitionRecovery && manifestRepairAttempts === 0,
      );
      const planningTokenBudget = round === 0
        ? 2000
        : (isManifestRepairRound || isPendingTransitionRecoveryRound)
          ? 2400
          : 800;
      const repairStartStage = isManifestRepairRound && manifestRepairAttempts >= 2
        ? 'secondary'
        : null;
      if (repairStartStage) {
        console.warn(`[router req=${requestId}] Escalating repeated semantic repair to stage=${repairStartStage} repairAttempt=${manifestRepairAttempts}.`);
      }
      modelResponse = await callChatCompletion(agentMessages, {
        max_tokens: planningTokenBudget,
        correlationId: options?.correlationId,
        tools: round === 0 || isManifestRepairRound || isPendingTransitionRecoveryRound
          ? toolDefinitions
          : [],
        toolChoice: isPendingTransitionRecoveryRound
          || (isManifestRepairRound && manifestRepairMode === MANIFEST_REPAIR_MODE.REQUIRED)
          ? 'required'
          : 'auto',
        returnMessage: true,
        purpose: round === 0
          ? 'initial'
          : manifestRepairAttempts > 0
              ? 'manifest_repair'
              : pendingTransitionRecovery
                ? 'pending_transition_recovery'
                : 'continuation',
        // One self-repair gives the primary model a chance to correct a
        // transient schema mistake. If the same semantic boundary rejects it
        // again, use an independent model instead of repeating a correlated
        // failure with GPT-OSS for the final bounded repair.
        startStage: repairStartStage,
      });
      modelElapsedMs += Date.now() - modelStartMs;
    } catch (error) {
      console.warn(`[router req=${requestId}] planning round ${round + 1} failed:`, error.message);
      break;
    }

    const currentDecision = normalizeAgentDecision(modelResponse);
    if (round === 0 || currentDecision.legacyPlan) decision = currentDecision;
    if (currentDecision.toolCalls.length === 0) {
      if (round === 0 && hasPendingState) {
        const pendingMemory = getWorkingMemory(user);
        const pending = pendingMemory?.pendingClarifications || [];
        if (pending.length === 1) {
          const verifierStartMs = Date.now();
          const verification = await callPendingTransitionVerification({
            userText: trustedMessageText || messageText,
            pendingState: {
              count: 1,
              selectedPosition: 1,
              selected: {
                content: pending[0].content,
                question: pending[0].question,
                proposedAt: pending[0].proposedReminder?.targetTime || null,
                proposedOperation: pending[0].proposedOperation || null,
                status: 'not_executed',
              },
            },
            proposedOperation: { kind: 'no_tool_response' },
            latestAssistantMessage,
            correlationId: options?.correlationId,
          });
          modelElapsedMs += Date.now() - verifierStartMs;
          if (verification) {
            console.log(`[router req=${requestId}] Pending transition verdict=${verification.transition} confidence=${verification.confidence} latestAssistantContext=${latestAssistantMessage ? 'present' : 'absent'}.`);
          }
          if (
            verification?.confidence === 'high'
            && ['execute_pending', 'discard_pending', 'revise_pending'].includes(verification.transition)
          ) {
            if (['execute_pending', 'discard_pending'].includes(verification.transition)) {
              // The independent verifier is allowed to resolve exactly one
              // already-typed pending proposal. It cannot invent a new domain
              // operation: it only selects execute vs. discard for state that
              // the backend previously staged. Avoiding a second planning call
              // removes an unnecessary outage/latency point from simple replies.
              const recoveryCall = {
                id: `pending_transition_recovery_${round + 1}`,
                name: 'orchestrator',
                arguments: JSON.stringify({
                  kind: verification.transition,
                  contextRef: { source: 'pending_state', position: 1 },
                  sourceQuote: trustedMessageText || messageText,
                }),
              };
              const recoveryStartedAt = Date.now();
              const pendingOutcome = await executePendingPlanOperation({
                operation: {
                  kind: verification.transition,
                  contextRef: { source: 'pending_state', position: 1 },
                  sourceQuote: trustedMessageText || messageText,
                },
                user,
                userMessage: trustedMessageText || messageText,
                language,
                isPro,
                referenceTime: requestReferenceTime,
                timezone,
                correlationId: options?.correlationId,
                preverifiedTransition: verification,
                latestAssistantMessage,
              });
              toolElapsedMs += Date.now() - recoveryStartedAt;
              recoveryCall.name = pendingOutcome.toolName;
              recoveryCall.arguments = JSON.stringify(pendingOutcome.params);
              const fact = createExecutionFact({
                toolName: pendingOutcome.toolName,
                params: pendingOutcome.params,
                result: pendingOutcome.result,
                callId: recoveryCall.id,
                language,
              });
              executionFacts.push(fact);
              executionRecords.push({
                call: recoveryCall,
                params: pendingOutcome.params,
                result: pendingOutcome.result,
                fact,
              });
              if (
                (pendingOutcome.result.success || pendingOutcome.result.requiresClarification)
                && pendingOutcome.toolName !== 'orchestrator'
              ) {
                updateWorkingMemoryFromExecution({
                  user,
                  toolName: pendingOutcome.toolName,
                  params: pendingOutcome.params,
                  result: pendingOutcome.result,
                });
              }
              memoryDisposition = 'skip_operational';
              finalModelContent = '';
              console.log(`[router req=${requestId}] Resolved single pending proposal directly transition=${verification.transition} verifierConfidence=high outcome=${pendingOutcome.result.action}`);
              break;
            }

            pendingTransitionRecovery = verification.transition;
            agentMessages.push({
              role: 'assistant',
              content: currentDecision.content || (language === 'en' ? 'Understood.' : 'Entendido.'),
            });
            agentMessages.push({
              role: 'system',
              content: language === 'en'
                ? `A safety verifier determined that the latest user reply directly resolves the single pending proposal as ${verification.transition}. Re-read the latest user message and return exactly one execute_turn with that pending transition, contextRef={source:pending_state,position:1}, and a verbatim current-message sourceQuote. Do not replay any historical operation.`
                : `Un verificador de seguridad determinó que la última respuesta del usuario resuelve directamente la única propuesta pendiente como ${verification.transition}. Relee el último mensaje y devuelve exactamente un execute_turn con esa transición pendiente, contextRef={source:pending_state,position:1} y sourceQuote literal del mensaje actual. No repitas ninguna operación histórica.`,
            });
            console.warn(`[router req=${requestId}] Recovering omitted pending transition: ${verification.transition}`);
            continue;
          }
        }
      }

      // A planner can also fail by answering in prose when the current turn
      // clearly authorizes an action. Verify that negative decision with the
      // same semantic coverage boundary used for manifests. High confidence
      // is required so ordinary conversation and scope refusals stay natural.
      let proseCoverage = null;
      if (executionRecords.length === 0) {
        const coverageStartMs = Date.now();
        const coverage = await callManifestCoverageVerification({
          userText: trustedMessageText || messageText,
          manifest: { operations: [], excludedClauses: [] },
          conversationState: workingMemoryText,
          recentConversation: pastTurns,
          currentTime: nowStr,
          assistantResponse: currentDecision.content,
          correlationId: options?.correlationId,
        });
        proseCoverage = coverage;
        modelElapsedMs += Date.now() - coverageStartMs;
        if (coverage?.memoryDisposition === 'skip_operational') {
          memoryDisposition = 'skip_operational';
        }
        logCoverageVerdict({ requestId, coverage, phase: 'prose_decision' });
        const hasTypedManifestRequirement = ['none', 'operations', 'pending_transition']
          .includes(coverage?.manifestRequirement);
        const coverageRequiresManifest = coverage?.manifestRequirement === 'operations'
          || (coverage?.manifestRequirement === 'pending_transition' && hasPendingState)
          // Compatibility for injected/local verifiers that predate the typed
          // field. Production verifier results always carry it.
          || (!hasTypedManifestRequirement && coverage?.verdict === 'incomplete');
        if (
          coverage?.verdict === 'incomplete'
          && coverage.confidence === 'high'
          && coverageRequiresManifest
        ) {
          if (manifestRepairAttempts < MAX_MANIFEST_REPAIR_ATTEMPTS) {
            manifestRepairAttempts += 1;
            manifestRepairMode = MANIFEST_REPAIR_MODE.REQUIRED;
            agentMessages.push({
              role: 'assistant',
              content: currentDecision.content || (language === 'en' ? 'Understood.' : 'Entendido.'),
            });
            agentMessages.push({
              role: 'system',
              content: language === 'en'
                ? `A semantic verifier found that the current-message clause “${coverage.missingQuote}” requires an in-scope operation that the prose answer omitted. Nothing was executed. Return one execute_turn covering the complete current-turn delta with verbatim sourceQuote evidence. ${coverage.feedback}`
                : `Un verificador semántico detectó que la cláusula del mensaje actual “${coverage.missingQuote}” requiere una operación dentro del alcance que la respuesta en prosa omitió. No se ejecutó nada. Devuelve un execute_turn con el delta completo del turno actual y sourceQuote literal. ${coverage.feedback}`,
            });
            console.warn(`[router req=${requestId}] Recovering omitted execute_turn from a prose-only decision.`);
            continue;
          }
          finalModelContent = safeRejectedManifestReply(language);
          directResponseVerified = true;
          console.warn(`[router req=${requestId}] Prose decision remained semantically incomplete; stopped with a grounded reply.`);
          break;
        }
        if (
          coverage?.verdict === 'incomplete'
          && coverage.confidence === 'high'
          && !coverageRequiresManifest
        ) {
          console.warn(`[router req=${requestId}] Ignored inconsistent coverage repair: manifestRequirement=${coverage.manifestRequirement} hasPendingState=${hasPendingState}.`);
        }
        if (
          coverage?.verdict === 'complete'
          && coverage.proposalConfidence === 'high'
          && coverage.assistantProposal?.kind === 'reminder_cancel'
          && ['elapsed', 'all'].includes(coverage.assistantProposal.scope)
        ) {
          const params = { action: 'cancel', scope: coverage.assistantProposal.scope };
          const toolStartMs = Date.now();
          const result = await executeTool({
            toolName: 'manage_reminder', params, user, isPro, language,
            userMessage: trustedMessageText || messageText,
            correlationId: options?.correlationId,
            referenceTime: requestReferenceTime,
          });
          toolElapsedMs += Date.now() - toolStartMs;
          const call = {
            id: `assistant_proposal_${round + 1}`,
            name: 'manage_reminder',
            arguments: JSON.stringify(params),
          };
          const fact = createExecutionFact({
            toolName: call.name, params, result, callId: call.id, language,
          });
          executionFacts.push(fact);
          executionRecords.push({ call, params, result, fact });
          if (result.success || result.requiresClarification) {
            updateWorkingMemoryFromExecution({ user, toolName: call.name, params, result });
          }
          finalModelContent = '';
          console.log(`[router req=${requestId}] Grounded assistant proposal as ${coverage.assistantProposal.kind}(scope=${coverage.assistantProposal.scope}); no mutation executed.`);
          break;
        }
        if (
          coverage?.verdict === 'complete'
          && coverage.clarificationConfidence === 'high'
          && coverage.assistantClarification
        ) {
          const clarification = formatAssistantClarification(coverage.assistantClarification, language);
          if (clarification) {
            finalModelContent = clarification;
            directResponseVerified = true;
            console.log(`[router req=${requestId}] Replaced a redundant permission gate with one typed clarification fields=${coverage.assistantClarification.missingFields.join(',')}.`);
            break;
          }
        }
        if (
          coverage?.safeResponse
          && (coverage.verdict === 'complete' || !coverageRequiresManifest)
        ) {
          const presentationStartMs = Date.now();
          const presentedResponse = await callConversationalPresentation({
            responseText: coverage.safeResponse,
            language,
            correlationId: options?.correlationId,
          });
          modelElapsedMs += Date.now() - presentationStartMs;
          finalModelContent = presentedResponse || coverage.safeResponse;
          directResponseVerified = true;
          const disposition = coverage.assistantResponseQuality === 'replace'
            ? 'replaced_unsafe'
            : 'validated_safe';
          console.log(`[router req=${requestId}] Structured conversational response disposition=${disposition} confidence=${coverage.responseConfidence}.`);
          break;
        }
      }
      // If every provider failed after tools already executed, retain the
      // backend cards instead of prepending a misleading outage message.
      finalModelContent = modelResponse?.unavailable ? '' : currentDecision.content;
      // Backward-compatible path for injected/local verifier implementations
      // predating structured response quality. Production verifier responses
      // always include assistantResponseQuality and safeResponse.
      if (proseCoverage && proseCoverage.assistantResponseQuality === undefined) {
        directResponseVerified = true;
      }
      break;
    }

    const manifestCall = currentDecision.toolCalls.find((call) => call.name === 'execute_turn');
    if (manifestCall && executionRecords.length === 0) {
      agentMessages.push({
        role: 'assistant',
        content: currentDecision.content || null,
        tool_calls: [toProviderToolCall(manifestCall)],
      });
      const preflight = preflightTurnManifestCall({
        call: manifestCall,
        user,
        userMessage: trustedMessageText || messageText,
        isAdmin,
        referenceTime: requestReferenceTime,
        timezone,
      });
      if (preflight.validation?.valid) {
        console.log(`[router req=${requestId}] Planned manifest ${manifestShapeForLog(preflight.validation.params)}`);
      }
      // Audit semantic operation identity before resolving contextual targets.
      // This lets the guardrail correct create-vs-update intent in one pass,
      // instead of spending the bounded repair budget on a contextRef that the
      // current message never authorized in the first place.
      if (preflight.validation?.valid) {
        const coverageStartMs = Date.now();
        const coverage = await callManifestCoverageVerification({
          userText: trustedMessageText || messageText,
          manifest: preflight.validation.params,
          conversationState: workingMemoryText,
          recentConversation: pastTurns,
          currentTime: nowStr,
          correlationId: options?.correlationId,
        });
        modelElapsedMs += Date.now() - coverageStartMs;
        if (coverage?.memoryDisposition === 'skip_operational') {
          memoryDisposition = 'skip_operational';
        }
        logCoverageVerdict({ requestId, coverage, phase: `pre_execution_${manifestRepairAttempts + 1}` });
        if (coverage?.verdict === 'incomplete' && coverage.confidence === 'high') {
          const coverageFeedback = {
            outcome: 'manifest_incomplete_before_execution',
            missingQuote: coverage.missingQuote,
            instruction: language === 'en'
              ? `Nothing was executed. The current-message clause “${coverage.missingQuote}” is not accounted for. Return one corrected execute_turn: add the authorized operation, or add the clause to excludedClauses with the correct reason. ${coverage.feedback}`
              : `No se ejecutó nada. La cláusula del mensaje actual “${coverage.missingQuote}” no está contemplada. Devuelve un execute_turn corregido: agrega la operación autorizada o incluye la cláusula en excludedClauses con el motivo correcto. ${coverage.feedback}`,
          };
          if (manifestRepairAttempts < MAX_MANIFEST_REPAIR_ATTEMPTS) {
            manifestRepairAttempts += 1;
            manifestRepairMode = MANIFEST_REPAIR_MODE.REQUIRED;
            agentMessages.push({
              role: 'tool',
              tool_call_id: manifestCall.id,
              name: 'execute_turn',
              content: JSON.stringify(coverageFeedback),
            });
            console.warn(`[router req=${requestId}] Repairing semantically incomplete manifest: missing="${compactDiagnostic(coverage.missingQuote)}" feedback="${compactDiagnostic(coverage.feedback)}"`);
            continue;
          }

          finalModelContent = safeRejectedManifestReply(language);
          directResponseVerified = true;
          console.warn(`[router req=${requestId}] Manifest remained semantically incomplete; stopped before execution with a grounded reply.`);
          break;
        }
      }

      const repairDirective = getManifestRepairDirective(preflight.validation, preflight.compiled);
      if (repairDirective && manifestRepairAttempts < MAX_MANIFEST_REPAIR_ATTEMPTS) {
        manifestRepairAttempts += 1;
        manifestRepairMode = repairDirective.mode;
        agentMessages.push({
          role: 'tool',
          tool_call_id: manifestCall.id,
          name: 'execute_turn',
          content: JSON.stringify(buildManifestRecoveryFeedback({
            directive: repairDirective,
            language,
          })),
        });
        console.warn(`[router req=${requestId}] Repairing manifest before execution: code=${repairDirective.errorCode} sequence=${repairDirective.sequence || 'manifest'} mode=${repairDirective.mode} detail="${compactDiagnostic(repairDirective.error)}"`);
        continue;
      }
      if (repairDirective) {
        // Do not ask another model to narrate a failed mutation: prose can
        // falsely claim success even though no backend operation ran.
        finalModelContent = safeRejectedManifestReply(language);
        directResponseVerified = true;
        console.warn(`[router req=${requestId}] Manifest remained invalid after repair: code=${repairDirective.errorCode} sequence=${repairDirective.sequence || 'manifest'} detail="${compactDiagnostic(repairDirective.error)}"; stopped before execution with a grounded reply.`);
        break;
      }
      const manifestStartMs = Date.now();
      const manifestOutcome = await executeTurnManifestCall({
        call: manifestCall,
        user,
        userMessage: trustedMessageText || messageText,
        isAdmin,
        isPro,
        language,
        referenceTime: requestReferenceTime,
        timezone,
        correlationId: options?.correlationId,
        latestAssistantMessage,
        preflight,
      });
      toolElapsedMs += Date.now() - manifestStartMs;
      modelElapsedMs += manifestOutcome.verifierElapsedMs;
      executionFacts.push(...manifestOutcome.facts);
      executionRecords.push(...manifestOutcome.records);
      excludedClauses = preflight.compiled?.excludedClauses || [];
      agentMessages.push({
        role: 'tool',
        tool_call_id: manifestCall.id,
        name: 'execute_turn',
        content: JSON.stringify(manifestOutcome.providerResult),
      });
      // Every operation and its user-facing card is already represented by
      // verified backend facts. A prose-only continuation would add latency,
      // cost, and a second opportunity to repeat those same results.
      break;
    }

    const isLegacyDecision = Boolean(currentDecision.legacyPlan);
    const callsRemaining = MAX_TOOL_CALLS_PER_TURN - executionRecords.length;
    const callsThisRound = currentDecision.toolCalls.slice(0, Math.max(0, callsRemaining));
    const toolMessages = [];
    const signaturesFromPriorRounds = new Map(executedSignatures);
    let executedAnyToolThisRound = false;

    if (!isLegacyDecision) {
      agentMessages.push({
        role: 'assistant',
        content: currentDecision.content || null,
        tool_calls: callsThisRound.map(toProviderToolCall),
      });
    }

    // Execute sequentially: mutations must preserve user order and observe all
    // prior outcomes, even if the provider proposed calls in parallel.
    for (const call of callsThisRound) {
      const params = parseToolArguments(call.arguments);
      const priorEquivalentRead = round > 0 && params
        ? findPriorEquivalentRead(executionRecords, call.name, params)
        : null;
      if (priorEquivalentRead) {
        if (!isLegacyDecision) {
          toolMessages.push({
            role: 'tool',
            tool_call_id: call.id,
            name: call.name,
            content: JSON.stringify({
              outcome: 'read_already_satisfied',
              success: true,
              previousOutcome: priorEquivalentRead.fact.outcome,
              summary: priorEquivalentRead.fact.summary,
            }),
          });
        }
        continue;
      }
      const signature = `${call.name}:${stableStringify(params)}`;
      if (signaturesFromPriorRounds.has(signature)) {
        const priorFact = signaturesFromPriorRounds.get(signature);
        if (!isLegacyDecision) {
          toolMessages.push({
            role: 'tool',
            tool_call_id: call.id,
            name: call.name,
            content: JSON.stringify({
              outcome: 'duplicate_suppressed',
              success: priorFact.success,
              previousOutcome: priorFact.outcome,
              previousErrorCode: priorFact.errorCode,
            }),
          });
        }
        continue;
      }

      let result;
      executedAnyToolThisRound = true;
      const toolStartMs = Date.now();
      if (params === null) {
        result = {
          success: false, action: 'invalid_parameters', errorCode: 'INVALID_PARAMETERS',
          error: language === 'en' ? 'The tool arguments were not valid JSON.' : 'Los argumentos de la herramienta no eran JSON válido.',
        };
      } else {
        const validation = validateToolCall({ toolName: call.name, params, isAdmin });
        if (!validation.valid) {
          result = {
            success: false, action: 'rejected_tool_call', errorCode: validation.errorCode, error: validation.error,
          };
        } else {
          result = await executeTool({
            toolName: call.name,
            params: validation.params,
            user,
            isPro,
            language,
            userMessage: trustedMessageText || messageText,
            correlationId: options?.correlationId,
            referenceTime: requestReferenceTime,
          });
        }
      }

      toolElapsedMs += Date.now() - toolStartMs;
      const fact = createExecutionFact({ toolName: call.name, params: params || {}, result, callId: call.id, language });
      executedSignatures.set(signature, fact);
      executionFacts.push(fact);
      executionRecords.push({ call, params: params || {}, result, fact });
      console.log(`[router req=${requestId}] Tool ${call.name} outcome: success=${result.success} action=${result.action}`);
      if (result.success || result.requiresClarification) {
        updateWorkingMemoryFromExecution({ user, toolName: call.name, params: params || {}, result });
      }

      if (!isLegacyDecision) {
        toolMessages.push({
          role: 'tool',
          tool_call_id: call.id,
          name: call.name,
          content: JSON.stringify(fact),
        });
      }
    }

    if (currentDecision.toolCalls.length > callsThisRound.length && !hasRecordedLimit) {
      executionFacts.push(createToolLimitFact(language));
      hasRecordedLimit = true;
    }
    if (isLegacyDecision) break;
    agentMessages.push(...toolMessages);
    if (!executedAnyToolThisRound) break;
    if (executionRecords.length >= MAX_TOOL_CALLS_PER_TURN) break;
  }

  // Facts/cards remain backend-owned. Post-tool prose is never mixed into the
  // verified presentation. A separate compact synthesis may only add a small
  // frame around those immutable cards; it never receives authority to rewrite
  // dates, counts, names, or outcomes.
  const visibleExecutionFacts = getVisibleExecutionFacts(executionRecords, executionFacts);
  let responseFraming = null;
  const canSynthesizeFrame = excludedClauses.length > 0
    || visibleExecutionFacts.every((fact) => fact.success && fact.complete);
  if (visibleExecutionFacts.length > 0 && canSynthesizeFrame) {
    const synthesisStartMs = Date.now();
    responseFraming = await callResponseSynthesis({
      userText: trustedMessageText || messageText,
      facts: visibleExecutionFacts,
      excludedClauses,
      language,
      correlationId: options?.correlationId,
    });
    modelElapsedMs += Date.now() - synthesisStartMs;
  }
  const safeConversationFallback = language === 'en'
    ? 'Understood. I’ll be here whenever you need me.'
    : 'Entendido. Aquí estaré cuando me necesites.';
  let finalReply = visibleExecutionFacts.length > 0
    ? composeExecutionReply(visibleExecutionFacts, language, { framing: responseFraming })
    : (directResponseVerified ? (finalModelContent || decision.content) : safeConversationFallback);
  if (visibleExecutionFacts.length === 0 && !directResponseVerified) {
    console.warn(`[router req=${requestId}] Blocked unverified provider prose at the delivery boundary.`);
  }
  finalReply = await replaceTrustedLinkPlaceholders({ text: finalReply, user, phoneNumber });

  const defaultNeutralReply = language === 'en'
    ? 'I could not determine the requested action. Could you rephrase it?'
    : 'No pude determinar la acción solicitada. ¿Puedes reformularla?';
  const finalReplyText = sanitizeResponseText(finalReply || defaultNeutralReply);
  const primaryRecord = executionRecords[0] || null;
  const primaryTool = primaryRecord?.call?.name || decision.legacyPlan?.tool || null;
  const primaryParams = primaryRecord?.params || decision.legacyPlan?.params || {};
  const inferredIntent = inferIntent(primaryTool, decision.legacyPlan?.intent);
  const ctaFact = executionFacts.find((fact) => fact.ctaUrl) || null;
  const ctaResult = executionRecords.find(({ result }) => result?.ctaUrl || result?.data?.auth_url || result?.data?.checkout_url)?.result || null;

  console.log(`[router req=${requestId}] Out in ${Date.now() - startMs}ms (context: ${contextElapsedMs}ms, model: ${modelElapsedMs}ms, tools: ${toolElapsedMs}ms): "${finalReplyText.slice(0, 80)}..."`);

  return {
    intent: inferredIntent,
    entities: {
      ...(primaryParams && typeof primaryParams === 'object' && !Array.isArray(primaryParams) ? primaryParams : {}),
      _conversationState: getClarificationStateSnapshot(user),
    },
    language,
    confirmation: finalReplyText,
    ctaUrl: ctaFact?.ctaUrl || ctaResult?.data?.auth_url || ctaResult?.data?.checkout_url || null,
    ctaHeader: ctaFact?.ctaHeader || null,
    ctaButtonText: ctaFact?.ctaButtonText || null,
    plan: decision.legacyPlan || (primaryTool ? { type: 'tool_call', tool: primaryTool, params: primaryParams } : { type: 'chat' }),
    executionFacts,
    memoryDisposition,
  };
}

function preflightTurnManifestCall({ call, user, userMessage, isAdmin, referenceTime, timezone }) {
  const rawParams = parseToolArguments(call.arguments);
  const validation = rawParams === null
    ? { valid: false, errorCode: 'INVALID_PARAMETERS', error: 'El manifiesto del turno no era JSON válido.' }
    : validateToolCall({ toolName: 'execute_turn', params: rawParams, isAdmin });
  const compiled = validation.valid
    ? compileTurnManifest(validation.params, {
      userMessage,
      referenceTime,
      timezone,
      workingMemory: getWorkingMemory(user),
    })
    : validation;
  return { rawParams, validation, compiled };
}

function rejectedPlanResult(errorCode, error, language, { requiresClarification = false } = {}) {
  const message = error || (language === 'en' ? 'I could not safely execute that operation.' : 'No pude ejecutar esa operación de forma segura.');
  return {
    success: false,
    complete: false,
    action: requiresClarification ? 'clarification_required' : 'rejected_plan_operation',
    errorCode: errorCode || 'INVALID_PARAMETERS',
    error: message,
    confirmation: message,
    requiresClarification,
  };
}

function pendingClarificationQuestion(pending, language) {
  const labels = pending.slice(0, 5).map((item, index) => `${index + 1}. ${item.content}`).join('\n');
  return language === 'en'
    ? `Which pending proposal do you mean?\n${labels}`
    : `¿A cuál propuesta pendiente te refieres?\n${labels}`;
}

function saveRemainingPendingState(user, memory, pendingClarifications) {
  if (pendingClarifications.length === 0) {
    if ((memory?.items || []).length === 0) {
      clearWorkingMemory(user);
      return;
    }
    saveWorkingMemory(user, {
      source: memory.source,
      scope: memory.scope,
      semanticQuery: memory.semanticQuery,
      entityType: memory.entityType,
      activeEntity: memory.activeEntity,
      activeEntityId: memory.activeEntityId,
      lastAction: memory.lastAction,
      pendingClarifications: [],
      items: memory.items,
    });
    return;
  }
  saveWorkingMemory(user, {
    source: memory?.source || 'reminder',
    scope: 'clarification',
    entityType: memory?.entityType || 'all',
    lastAction: 'clarification_required',
    pendingClarifications,
    items: memory?.items || [],
  });
}

async function executePendingPlanOperation({
  operation, user, userMessage, language, isPro, referenceTime, timezone, correlationId,
  preverifiedTransition = null, latestAssistantMessage = '',
}) {
  const startedAt = Date.now();
  const memory = getWorkingMemory(user);
  const pending = Array.isArray(memory?.pendingClarifications) ? memory.pendingClarifications : [];
  const requestedPosition = operation.contextRef?.source === 'pending_state'
    ? operation.contextRef.position
    : (pending.length === 1 ? 1 : null);
  const selected = requestedPosition ? pending[requestedPosition - 1] : null;
  if (!selected) {
    return {
      toolName: 'orchestrator', params: {}, verifierElapsedMs: 0,
      result: rejectedPlanResult('AMBIGUOUS_PENDING_REFERENCE', pendingClarificationQuestion(pending, language), language, { requiresClarification: true }),
    };
  }

  const canReuseVerification = pending.length === 1
    && requestedPosition === 1
    && preverifiedTransition?.confidence === 'high'
    && preverifiedTransition.transition === operation.kind
    && ['execute_pending', 'discard_pending'].includes(operation.kind);
  const verification = canReuseVerification
    ? preverifiedTransition
    : await callPendingTransitionVerification({
      userText: userMessage,
      pendingState: {
        count: pending.length,
        selectedPosition: requestedPosition,
        selected: {
          content: selected.content,
          question: selected.question,
          proposedAt: selected.proposedReminder?.targetTime || null,
          proposedOperation: selected.proposedOperation || null,
          status: 'not_executed',
        },
      },
      proposedOperation: { kind: operation.kind, schedule: operation.schedule || null },
      latestAssistantMessage,
      correlationId,
    });
  const verifierElapsedMs = Date.now() - startedAt;
  let effectiveKind = operation.kind;
  if (!verification || verification.confidence === 'low') {
    effectiveKind = 'clarification_request';
  } else if (verification.transition !== operation.kind) {
    // A verifier may safely prevent execution, never introduce execution that
    // the primary planner did not authorize.
    effectiveKind = verification.transition === 'discard_pending' && verification.confidence === 'high'
      ? 'discard_pending'
      : 'clarification_request';
  }

  if (effectiveKind === 'clarification_request') {
    const question = language === 'en'
      ? 'Should I execute the pending proposal, change it, or discard it?'
      : '¿Quieres que ejecute la propuesta pendiente, que la modifique o que la descarte?';
    return {
      toolName: 'orchestrator', params: {}, verifierElapsedMs,
      result: rejectedPlanResult('PENDING_TRANSITION_UNCERTAIN', question, language, { requiresClarification: true }),
    };
  }

  const remaining = pending.filter((_item, index) => index !== requestedPosition - 1);
  if (effectiveKind === 'discard_pending') {
    saveRemainingPendingState(user, memory, remaining);
    const confirmation = language === 'en'
      ? 'Understood — I discarded the pending proposal.'
      : 'Entendido — descarté la propuesta pendiente.';
    return {
      toolName: 'orchestrator', params: { action: 'discard_pending' }, verifierElapsedMs,
      result: { success: true, complete: true, action: 'discarded_pending', confirmation, rawSummary: confirmation },
    };
  }

  const proposedOperation = selected.proposedOperation;
  if (proposedOperation?.kind === 'entity_delete') {
    const params = {
      action: 'delete',
      ...(proposedOperation.targetName ? { targetName: proposedOperation.targetName } : {}),
      ...(proposedOperation.category ? { category: proposedOperation.category } : {}),
      scope: proposedOperation.scope || 'single',
      ...(proposedOperation.preserveNames?.length ? { preserveNames: proposedOperation.preserveNames } : {}),
    };
    if (effectiveKind === 'revise_pending') {
      if (operation.targetName || operation.entityName) params.targetName = operation.targetName || operation.entityName;
      if (operation.category) params.category = operation.category;
      if (operation.scope) params.scope = operation.scope;
      if (operation.preserveNames) params.preserveNames = operation.preserveNames;
    }
    const result = await executeTool({
      toolName: 'manage_entity', params, user, isPro, language,
      userMessage: '', correlationId, referenceTime, clarificationResolution: true,
    });
    if (result.success) saveRemainingPendingState(user, memory, remaining);
    return { toolName: 'manage_entity', params, result, verifierElapsedMs };
  }

  if (proposedOperation?.kind === 'reminder_cancel') {
    const params = {
      action: 'cancel',
      scope: proposedOperation.scope,
      ...(proposedOperation.cutoffAt ? { cutoffAt: proposedOperation.cutoffAt } : {}),
    };
    const result = await executeTool({
      toolName: 'manage_reminder', params, user, isPro, language,
      userMessage: '', correlationId, referenceTime, clarificationResolution: true,
    });
    if (result.success) saveRemainingPendingState(user, memory, remaining);
    return { toolName: 'manage_reminder', params, result, verifierElapsedMs };
  }

  const proposal = selected.proposedReminder;
  if (!proposal?.targetTime) {
    return {
      toolName: 'orchestrator', params: {}, verifierElapsedMs,
      result: rejectedPlanResult('INVALID_PENDING_PROPOSAL', language === 'en' ? 'The pending proposal has no valid time.' : 'La propuesta pendiente no tiene una hora válida.', language),
    };
  }

  let targetTime = proposal.targetTime;
  if (effectiveKind === 'revise_pending') {
    const temporal = resolveTypedSchedule(operation.schedule, {
      referenceTime,
      timezone,
      baseDate: new Date(proposal.targetTime),
    });
    if (!temporal.valid) {
      return {
        toolName: 'orchestrator', params: {}, verifierElapsedMs,
        result: rejectedPlanResult(temporal.errorCode, temporal.error, language, { requiresClarification: true }),
      };
    }
    targetTime = temporal.canonical;
  }

  const params = {
    action: 'create',
    items: [{
      ...proposal,
      targetTime,
      sourceTimeText: effectiveKind === 'revise_pending'
        ? operation.sourceQuote
        : proposal.sourceTimeText,
    }],
  };
  const result = await executeTool({
    toolName: 'manage_reminder', params, user, isPro, language,
    userMessage: '', correlationId, referenceTime, clarificationResolution: true,
  });
  if (result.success) saveRemainingPendingState(user, memory, remaining);
  return { toolName: 'manage_reminder', params, result, verifierElapsedMs };
}

async function executeTurnManifestCall({
  call, user, userMessage, isAdmin, isPro, language, referenceTime, timezone, correlationId,
  latestAssistantMessage = '', preflight = null,
}) {
  const records = [];
  const facts = [];
  let verifierElapsedMs = 0;
  const prepared = preflight || preflightTurnManifestCall({
    call, user, userMessage, isAdmin, referenceTime, timezone,
  });
  const { validation, compiled } = prepared;

  if (!validation.valid || !compiled?.valid) {
    const result = rejectedPlanResult(
      validation.valid ? compiled.errorCode : validation.errorCode,
      validation.valid ? compiled.error : validation.error,
      language,
    );
    const fact = createExecutionFact({ toolName: 'orchestrator', params: {}, result, callId: `${call.id}_plan`, language });
    const recordCall = { id: `${call.id}_plan`, name: 'orchestrator', arguments: '{}' };
    records.push({ call: recordCall, params: {}, result, fact });
    facts.push(fact);
  } else {
    for (const entry of compiled.entries) {
      let toolName = entry.toolName || 'orchestrator';
      let params = entry.params || {};
      let result;

      if (!entry.valid) {
        result = rejectedPlanResult(entry.errorCode, entry.error, language, { requiresClarification: entry.requiresClarification });
      } else if (entry.type === 'clarification') {
        const typedQuestion = entry.operation?.clarificationKind === 'reminder_schedule'
          ? formatAssistantClarification({
            kind: 'reminder_schedule',
            // The wording is application-owned; provider-authored subjects or
            // questions cannot leak mixed language or duplicated nouns.
            subject: '',
            missingFields: entry.operation.missingFields,
          }, language)
          : '';
        result = typedQuestion
          ? { ...entry.result, error: typedQuestion, confirmation: typedQuestion }
          : entry.result;
      } else if (entry.type === 'pending') {
        const pendingOutcome = await executePendingPlanOperation({
          operation: entry.operation, user, userMessage, language, isPro, referenceTime, timezone,
          correlationId, latestAssistantMessage,
        });
        toolName = pendingOutcome.toolName;
        params = pendingOutcome.params;
        result = pendingOutcome.result;
        verifierElapsedMs += pendingOutcome.verifierElapsedMs;
      } else {
        const domainValidation = validateToolCall({ toolName, params, isAdmin });
        if (!domainValidation.valid) {
          result = rejectedPlanResult(domainValidation.errorCode, domainValidation.error, language);
        } else {
          params = domainValidation.params;
          result = await executeTool({
            toolName, params, user, isPro, language, userMessage,
            correlationId, referenceTime,
          });
        }
      }

      const recordCall = {
        id: `${call.id}_${entry.sequence}`,
        name: toolName,
        arguments: JSON.stringify(params),
      };
      const fact = createExecutionFact({ toolName, params, result, callId: recordCall.id, language });
      records.push({ call: recordCall, params, result, fact });
      facts.push(fact);
      if ((result.success || result.requiresClarification) && toolName !== 'orchestrator') {
        updateWorkingMemoryFromExecution({ user, toolName, params, result });
      }
      console.log(`[router req=${correlationId || 'none'}] Planned ${toolName} outcome: success=${result.success} action=${result.action}`);
    }
  }

  return {
    records,
    facts,
    verifierElapsedMs,
    providerResult: {
      success: facts.every((fact) => fact.success),
      complete: facts.every((fact) => fact.complete),
      operationCount: facts.length,
      limit: TURN_OPERATION_LIMIT,
      outcomes: facts.map((fact) => ({
        operation: fact.tool,
        action: fact.action,
        success: fact.success,
        complete: fact.complete,
        errorCode: fact.errorCode,
        summary: fact.summary,
      })),
    },
  };
}

function getVisibleExecutionFacts(executionRecords, executionFacts) {
  const recoverableCodes = new Set(['INVALID_PARAMETERS', 'UNSUPPORTED_ACTION']);
  const supersededCallIds = new Set();

  for (let index = 0; index < executionRecords.length; index += 1) {
    const current = executionRecords[index];
    if (current?.fact?.success || !recoverableCodes.has(current?.fact?.errorCode)) continue;

    const correctedLater = executionRecords.slice(index + 1).some((candidate) => (
      candidate?.fact?.success
      && candidate?.call?.name === current?.call?.name
      && (!current?.fact?.requestedAction
        || !candidate?.fact?.requestedAction
        || candidate.fact.requestedAction === current.fact.requestedAction)
    ));
    if (correctedLater && current.fact.callId) supersededCallIds.add(current.fact.callId);
  }

  return (executionFacts || []).filter((fact) => !supersededCallIds.has(fact.callId));
}

function toProviderToolCall(call) {
  return {
    id: call.id,
    type: 'function',
    function: {
      name: call.name,
      arguments: typeof call.arguments === 'string' ? call.arguments : JSON.stringify(call.arguments || {}),
    },
  };
}

function stableStringify(value) {
  if (!value || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
}

function findPriorEquivalentRead(records, toolName, params) {
  // Listing entities is a complete inventory read. A continuation round may
  // not broaden or narrow the same successful read and create contradictory
  // counts; distinct reads explicitly requested together still run in round 1.
  if (toolName !== 'manage_entity' || params?.action !== 'list') return null;
  return [...records].reverse().find((record) => (
    record?.call?.name === toolName
    && record?.params?.action === 'list'
    && record?.result?.success
  )) || null;
}

function createToolLimitFact(language) {
  return Object.freeze({
    tool: 'orchestrator', action: 'tool_limit_reached', requestedAction: null,
    success: false, outcome: 'failure', errorCode: 'TOOL_LIMIT_REACHED',
    summary: language === 'en'
      ? 'The request exceeded the safe action limit for one turn; no additional actions were executed.'
      : 'La solicitud superó el límite seguro de acciones por turno; no ejecuté acciones adicionales.',
  });
}

function normalizeAgentDecision(modelResponse) {
  if (modelResponse && typeof modelResponse === 'object' && !Array.isArray(modelResponse)) {
    const nativeCalls = (modelResponse.tool_calls || []).map((toolCall, index) => ({
      id: toolCall.id || `call_${index + 1}`,
      name: toolCall.function?.name || toolCall.name,
      arguments: toolCall.function?.arguments ?? toolCall.arguments ?? '{}',
    })).filter((call) => Boolean(call.name));
    return {
      content: typeof modelResponse.content === 'string' ? modelResponse.content.trim() : '',
      toolCalls: nativeCalls,
      legacyPlan: null,
    };
  }

  const rawText = typeof modelResponse === 'string' ? modelResponse.trim() : '';
  const parsed = safeJsonParse(extractFirstJsonObject(rawText));
  if (!parsed) return { content: rawText, toolCalls: [], legacyPlan: null };

  const toolCalls = [];
  if (parsed.type === 'tool_call' && parsed.tool) {
    toolCalls.push({ id: 'legacy_primary', name: parsed.tool, arguments: parsed.params || {} });
    if (parsed.secondary_plan?.tool) {
      toolCalls.push({ id: 'legacy_secondary', name: parsed.secondary_plan.tool, arguments: parsed.secondary_plan.params || {} });
    }
  }
  return { content: parsed.reply || '', toolCalls, legacyPlan: parsed };
}

function updateWorkingMemoryFromExecution({ user, toolName, params, result }) {
  const existingMemory = getWorkingMemory(user);
  const pendingClarifications = result.pendingClarifications || result.data?.pendingClarifications || [];
  if (pendingClarifications.length > 0) {
    const existingPending = existingMemory?.pendingClarifications || [];
    const combinedPending = [];
    const seenPending = new Set();
    for (const item of [...existingPending, ...pendingClarifications]) {
      const identity = [
        item?.type || 'clarification',
        item?.content || '',
        item?.proposedReminder?.targetTime || '',
        item?.proposedOperation?.kind || '',
        item?.proposedOperation?.targetName || '',
        item?.proposedOperation?.scope || '',
        item?.proposedOperation?.cutoffAt || '',
        ...(item?.proposedOperation?.preserveNames || []),
      ].join('|');
      if (seenPending.has(identity)) continue;
      seenPending.add(identity);
      combinedPending.push(item);
    }
    saveWorkingMemory(user, {
      source: toolName === 'manage_reminder' ? 'reminder' : (toolName === 'manage_entity' ? 'entity' : 'unified'),
      scope: 'clarification',
      entityType: toolName === 'manage_reminder' ? 'reminder' : (toolName === 'manage_entity' ? 'entity' : 'all'),
      lastAction: 'clarification_required',
      pendingClarifications: combinedPending,
      // Pending proposals and the latest resolved items are orthogonal state.
      // Keeping both prevents an older proposal from making a newly displayed
      // card impossible to reference on the following turn.
      items: existingMemory?.items || [],
    });
    return;
  }

  const workingItems = extractWorkingItems(result.data);
  if (workingItems.length === 0) return;

  const firstType = workingItems[0]?.type || inferItemType(toolName);
  const hasUniformType = workingItems.every((item) => (item.type || firstType) === firstType);
  const source = toolName === 'get_unified_agenda'
    ? 'unified'
    : (toolName === 'manage_google_calendar'
      ? 'calendar'
      : (toolName === 'manage_reminder' ? 'reminder' : (toolName === 'manage_entity' ? 'entity' : 'task')));
  const activeEntity = result.data?.entityName || params.entityName || workingItems[0]?.entityName || null;
  const activeEntityId = result.data?.entityId
    || workingItems[0]?.entityId
    || workingItems[0]?.entity_id
    || workingItems[0]?.entities?.id
    || workingItems[0]?.raw?.entity_id
    || workingItems[0]?.raw?.entityId
    || workingItems[0]?.raw?.entities?.id
    || null;

  saveWorkingMemory(user, {
    source,
    scope: params.scope || 'current',
    semanticQuery: params.query || null,
    entityType: hasUniformType ? firstType : 'all',
    activeEntity,
    activeEntityId,
    lastAction: toolName,
    pendingClarifications: existingMemory?.pendingClarifications || [],
    items: workingItems,
  });
}

function extractWorkingItems(data) {
  if (!data) return [];
  if (Array.isArray(data)) return data;
  if (Array.isArray(data.items)) return data.items;
  if (Array.isArray(data.events)) return data.events;
  if (Array.isArray(data.reminders)) return data.reminders;
  if (Array.isArray(data.tasks)) return data.tasks;
  if (data.id && (data.title || data.content || data.name || data.summary)) return [data];
  return [];
}

function inferItemType(toolName) {
  if (toolName === 'manage_task') return 'task';
  if (toolName === 'manage_reminder') return 'reminder';
  if (toolName === 'manage_google_calendar') return 'calendar_event';
  if (toolName === 'manage_entity') return 'entity';
  return 'all';
}

function inferIntent(toolName, fallback = null) {
  const intents = {
    manage_memory: 'memory', manage_reminder: 'reminder', manage_task: 'task', manage_entity: 'entity',
    manage_subscription: 'subscription', get_subscription_link: 'subscription',
    manage_google_calendar: 'calendar', get_unified_agenda: 'unified_agenda', admin_metrics: 'admin',
  };
  return intents[toolName] || fallback || 'chat';
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

function safeJsonParse(jsonStr) {
  if (!jsonStr) return null;
  try {
    return JSON.parse(jsonStr);
  } catch {
    try {
      const sanitized = jsonStr
        .replace(/,\s*([}\]])/g, '$1')
        .replace(/([,{]\s*)([a-zA-Z_][a-zA-Z0-9_]*)\s*:/g, '$1"$2":');
      return JSON.parse(sanitized);
    } catch {
      return null;
    }
  }
}

function extractFirstJsonObject(text) {
  if (!text) return '';
  const clean = String(text).replace(/```(?:json)?/gi, '').replace(/```/g, '').trim();
  const start = clean.indexOf('{');
  if (start < 0) return '';
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < clean.length; index += 1) {
    const char = clean[index];
    if (escaped) { escaped = false; continue; }
    if (char === '\\') { escaped = true; continue; }
    if (char === '"') inString = !inString;
    if (inString) continue;
    if (char === '{') depth += 1;
    if (char === '}') {
      depth -= 1;
      if (depth === 0) return clean.slice(start, index + 1);
    }
  }
  return '';
}
