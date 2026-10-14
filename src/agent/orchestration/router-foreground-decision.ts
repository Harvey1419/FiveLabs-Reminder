import { getStructuredTurnSchema } from '../contracts/foreground-turn-projection.js';
import type { ValidatedIntent } from '../contracts/intent-validator.js';
import { enforceCurrentProfileSource, validateStructuredTurnContent, parseStructuredTurnDecision,
  enforceAttachmentOnlyIntent, type CollectedIntent } from './router-turn-decisions.js';
import { normalizeModelResponse } from './router-model-response.js';
import type { WorkingMemoryInput } from '../core/working-memory-cache.js';
import type { ModelContextMessage } from './router-model-context.js';

export interface RouterForegroundMemory extends WorkingMemoryInput { timestamp?: unknown }
export interface RouterForegroundResponse<Entities> {
  intent: 'clarification'; entities: Entities; language: string; confirmation: string;
  ctaUrl: null; ctaHeader: null; ctaButtonText: null; plan: { type: string };
  executionFacts: []; memoryDisposition: 'skip_operational';
}
export interface RouterForegroundDependencies<Entities> {
  operationalEvidenceFromHistory(history: readonly unknown[], userId: string | undefined): readonly unknown[];
  callChatCompletion(messages: ModelContextMessage[], options: {
    max_tokens: number; correlationId: unknown; tools: null; toolChoice: 'none';
    responseFormat: { type: 'json_schema'; json_schema: { name: string; strict: true; schema: ReturnType<typeof getStructuredTurnSchema> } };
    returnMessage: true; purpose: 'initial'; language: string;
    validateStructuredContent(content: unknown): ReturnType<typeof validateStructuredTurnContent>;
  }): Promise<unknown>;
  getWorkingMemory(key: unknown): RouterForegroundMemory | null | undefined;
  saveWorkingMemory(key: unknown, value: RouterForegroundMemory, options: { restoredTimestamp: unknown }): void;
  conversationStateEntities(user: { id?: string }, extra: Record<string, unknown>): Entities;
  now(): number; logger: Pick<Console, 'log' | 'warn'>;
}
export interface RouterForegroundInput {
  rawPastTurns: readonly unknown[]; user: { id?: string }; messages: ModelContextMessage[];
  isAdmin: boolean; isAttachmentOnlyTurn: boolean; requestId: unknown; prompt: string;
  pastTurns: readonly ModelContextMessage[]; historyChars: number; relevantMemories?: readonly unknown[] | null;
  options?: { correlationId?: unknown }; language: string; currentUserText: string; workingMemoryKey: unknown;
}
export type RouterForegroundOutcome<Entities> =
  | { accepted: false; response: RouterForegroundResponse<Entities> }
  | { accepted: true; intent: ValidatedIntent; hasHistoricalEvidence: boolean; modelElapsedMs: number };

export function safeIntentError(language: string) {
  return language === 'en'
    ? 'I understood that you want me to do something, but I could not safely translate it into an action. Please send the request again.'
    : 'Entendí que quieres que haga algo, pero no pude convertirlo en una acción segura. Envíamelo de nuevo, por favor.';
}

export function structuredDecisionError(language: string) {
  return language === 'en'
    ? 'I could not produce a safe structured decision for that message. Please send it again.'
    : 'No pude producir una decisión estructurada segura para ese mensaje. Envíamelo de nuevo, por favor.';
}

export function providerUnavailableError(language: string) {
  return language === 'en'
    ? 'I could not complete this turn right now. I executed no new actions in this turn; this does not invalidate prior confirmations. Please try again in a moment.'
    : 'No pude completar esa acción en este momento. No ejecuté acciones nuevas en este turno; esto no invalida las confirmaciones anteriores. Inténtalo nuevamente en un momento.';
}

/** Admits one strict foreground decision; historical/context ports do not grant execution authority. */
export function createRouterForegroundDecision<Entities>(dependencies: RouterForegroundDependencies<Entities>) {
  const { operationalEvidenceFromHistory, callChatCompletion, getWorkingMemory, saveWorkingMemory,
    conversationStateEntities, now, logger: console } = dependencies;
  async function decideRouterForeground(input: RouterForegroundInput): Promise<RouterForegroundOutcome<Entities>> {
    const { rawPastTurns, user, messages, isAdmin, isAttachmentOnlyTurn, requestId, prompt, pastTurns,
      historyChars, relevantMemories, options, language, currentUserText, workingMemoryKey } = input;
    const fail = (response: RouterForegroundResponse<Entities>): RouterForegroundOutcome<Entities> => ({ accepted: false, response });
    const historicalEvidence = operationalEvidenceFromHistory(rawPastTurns, user.id);
    const hasHistoricalEvidence = historicalEvidence.length > 0;
    if (hasHistoricalEvidence) messages[0]!.content += `\nOperational evidence (actual prior outcomes: success on read/list means a real query succeeded then, not unverified cache. Say last observed; no new query is not a failed query. Bounded history, not fresh state; select evidenceRefs on recap, older/overflow may be missing): ${JSON.stringify(historicalEvidence)}`;

    const turnResponseFormat = {

      type: 'json_schema',
      json_schema: {
        name: 'hermes_turn_intent',
        strict: true,
        schema: getStructuredTurnSchema({
          isAdmin,
          attachmentOnly: isAttachmentOnlyTurn,
        }),
      },
    } satisfies Parameters<RouterForegroundDependencies<Entities>['callChatCompletion']>[1]['responseFormat'];

    console.log(`[router req=${requestId}] model context promptChars=${prompt.length} historyTurns=${pastTurns.length} historyChars=${historyChars} memories=${relevantMemories?.length || 0}`);

    const modelStart = now();
    let modelResponse: unknown;
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
        validateStructuredContent: (content) => enforceCurrentProfileSource(validateStructuredTurnContent(content, { isAdmin, hasHistoricalEvidence }), currentUserText),
      });
    } catch (error) {
      console.warn(`[router req=${requestId}] model failed:`, (error as { message?: unknown }).message);
      modelResponse = { content: '', tool_calls: [], unavailable: true };
    }
    const modelElapsedMs = now() - modelStart;
    const decision = normalizeModelResponse(modelResponse);
    console.log(`[router req=${requestId}] model decision in ${modelElapsedMs}ms structuredChars=${decision.content.length} unavailable=${decision.unavailable}`);
    const structuredDecision = parseStructuredTurnDecision(decision, { isAdmin, hasHistoricalEvidence });
    let collected: CollectedIntent = structuredDecision.unavailable ? { valid: true, intent: null } : structuredDecision.validation;
    collected = enforceCurrentProfileSource(collected, currentUserText);
    collected = enforceAttachmentOnlyIntent(collected, isAttachmentOnlyTurn);


    const recordProviderFault = (faultReason: unknown) => {
      const current = getWorkingMemory(workingMemoryKey);
      saveWorkingMemory(workingMemoryKey, {
        ...(current || { source: 'system', lastAction: 'provider_failure' }),
        infraFault: true,
        faultReason,
      }, { restoredTimestamp: current?.timestamp ?? null });
    };

    if (!collected.valid) {
      recordProviderFault(collected.errorCode || 'invalid_structured_output');
      console.warn(`[router req=${requestId}] rejected semantic intent: ${collected.errorCode} ${collected.error}`);
      return fail({
        intent: 'clarification',
        entities: conversationStateEntities(user, { _turnMetadata: { kind: 'provider_failure' } }),
        language,
        confirmation: safeIntentError(language),
        ctaUrl: null, ctaHeader: null, ctaButtonText: null,
        plan: { type: 'invalid_intent' }, executionFacts: [], memoryDisposition: 'skip_operational',
      });
    }

    if (!collected.intent) {
      recordProviderFault(decision.unavailableReason || (decision.refused ? 'provider_refusal' : decision.unavailable ? 'provider_unavailable' : 'missing_structured_decision'));

      const confirmation = decision.refused
        ? (language === 'en' ? 'I cannot complete this request. I executed no new actions in this turn; this does not invalidate prior confirmations.' : 'No puedo completar esta solicitud. No ejecuté acciones nuevas en este turno; esto no invalida las confirmaciones anteriores.')
        : decision.unavailable
        ? providerUnavailableError(language)
        : structuredDecisionError(language);
      console.warn(`[router req=${requestId}] required structured tool missing; refusing prose bypass`);
      return fail({
        intent: 'clarification',
        entities: conversationStateEntities(user, { _turnMetadata: { kind: 'provider_failure' } }),
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
              : ['invalid_structured_output', 'structured_generation_rejection'].includes(decision.unavailableReason as string)
                ? 'invalid_structured_output'
                : decision.unavailable ? 'provider_unavailable' : 'missing_structured_decision',
        },
        executionFacts: [],
        memoryDisposition: 'skip_operational',
      });
    }

    const currentMemory = getWorkingMemory(workingMemoryKey);
    if (currentMemory?.infraFault) {
      const { infraFault: _infraFault, faultReason: _faultReason, ...view } = currentMemory;
      saveWorkingMemory(workingMemoryKey, view, { restoredTimestamp: currentMemory.timestamp });
    }

    return { accepted: true, intent: collected.intent, hasHistoricalEvidence, modelElapsedMs };
  }
  return { decideRouterForeground };
}
