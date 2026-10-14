import type { ValidatedIntent } from '../contracts/intent-validator.js';
import type { ValidatedTurnContext } from '../contracts/turn-context-contract.js';
import type { RuntimeAction } from './runtime-intent-normalizer.js';
import type { DomainCallContext } from './domain-call-builder.js';
import { bindAuthoritativeFollowupTargets, conversationReplyFromActions, type FollowupMemory, type FollowupOverview } from './router-turn-decisions.js';
import { structuredDecisionError } from './router-foreground-decision.js';
export interface RouterActionUser { id?: string; phone_number?: string | null }
interface ActionLogInput extends Record<string, unknown> { domain?: unknown; action?: unknown; schedule?: { kind?: unknown } | null }
export interface LinkPlaceholderInput { text?: string | null; user: RouterActionUser; phoneNumber?: string | null | undefined }
export type RouterRuntimeIntent = Omit<ValidatedIntent, 'actions'> & { actions: RuntimeAction[] };
export interface RouterLearningMetadata { learningCandidates?: ValidatedIntent['learningCandidates']; learningCandidatesProvided?: true }
export interface RouterActionResponse<Entities> extends RouterLearningMetadata {
  intent: 'chat' | 'clarification'; language: string; confirmation?: string; entities?: Entities;
  executionFacts?: []; ctaUrl?: string | null; ctaHeader?: string | null; ctaButtonText?: string | null;
  plan?: { type: string; actions: { domain: string | undefined; action: string | undefined }[] };
  memoryDisposition?: 'skip_operational' | 'skip_attachment' | 'extract';
}
export interface RouterActionDependencies<Lookup, Entities> {
  normalizeTurnIntentForRuntime(intent: ValidatedIntent, context: DomainCallContext): RouterRuntimeIntent;
  renderOperationalEvidence(history: readonly unknown[], refs: unknown, userId: string | undefined, language: string): string;
  renderHistoricalEvidence(history: readonly unknown[], refs: undefined, userId: string | undefined, language: string): string;
  renderPersonalKnowledge(refs: unknown, lookup: Lookup, userId: string | undefined, language: string): string;
  conversationStateEntities(user: RouterActionUser, extra: Record<string, unknown>): Entities;
  getGoogleConnectUrl(input: { userId: string | undefined; phoneNumber: string | null | undefined }): string;
  now(): number; logger: Pick<Console, 'log' | 'warn'>;
}
export interface RouterActionInput<Lookup> {
  admittedIntent: ValidatedIntent; user: RouterActionUser; dailyOverview?: FollowupOverview | null | undefined;
  workingMemory?: (FollowupMemory & { lastAction?: unknown }) | null | undefined; requestId: unknown;
  requestReferenceTime: Date; readonly language: string; readonly timezone: string;
  rawPastTurns: readonly unknown[]; hasHistoricalEvidence: boolean; personalKnowledge: { lookup: Lookup };
  phoneNumber?: string | null | undefined; isAttachmentOnlyTurn: boolean; startMs: number; contextElapsedMs: number; modelElapsedMs: number;
  applyDecisionContext(decision: ValidatedTurnContext): Promise<boolean>;
}
export type RouterActionOutcome<Entities> =
  | { handled: true; response: RouterActionResponse<Entities> }
  | { handled: false; runtimeIntent: RouterRuntimeIntent; learningMetadata: RouterLearningMetadata;
      operationalActions: RuntimeAction[]; recap: RuntimeAction | undefined; conversationReply: string };

export function safeLogSnippet(value: unknown, maxLength = 120) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (!text) return '';
  return text.length > maxLength ? `${text.slice(0, maxLength)}…` : text;
}

export function summarizeAction(action: ActionLogInput = {}) {
  const parts = [`${action.domain || 'unknown'}.${action.action || 'unknown'}`];
  if (action.target) parts.push(`target="${safeLogSnippet(action.target, 70)}"`);
  if (action.scope) parts.push(`scope=${action.scope}`);
  if (action.schedule?.kind) parts.push(`schedule=${action.schedule.kind}`);
  if (action.recurrence) parts.push(`recurrence=${action.recurrence}`);
  if (action.content || action.title || action.newName) parts.push('hasContentDelta=true');
  return parts.join(' ');
}

export function hasConversationalPaymentReference(text: string) {
  return ['[checkout_url]', 'stripe.com'].some(reference => text.includes(reference))
    || /https?:\/\/[^\s]+\/(?:checkout|subscriptions|buy|pay)(?:\/|\?|$)/i.test(text);
}

/** Host renderers retain personal/history ownership; planned prose never executes a domain operation. */
export function createRouterActionPreparation<Lookup, Entities>(dependencies: RouterActionDependencies<Lookup, Entities>) {
  const { normalizeTurnIntentForRuntime, renderOperationalEvidence, renderHistoricalEvidence,
    renderPersonalKnowledge, conversationStateEntities, getGoogleConnectUrl, now, logger: console } = dependencies;
  async function replaceTrustedLinkPlaceholders({ text, user, phoneNumber }: LinkPlaceholderInput) {
    let finalText = text || '';
    if (finalText.includes('[auth_url]')) {
      try {
        const authUrl = getGoogleConnectUrl({ userId: user.id, phoneNumber: phoneNumber || user.phone_number });
        finalText = finalText.replace(/\[auth_url\]/g, authUrl);
      } catch (error) {
        console.warn('[router] generating auth_url failed:', (error as { message?: unknown }).message);
      }
    }

    // Rendering is never payment authority, including synthesis and next-action
    // text. A checkout URL must come from the explicit subscription.link result.
    return finalText.replace(/\[checkout_url\]/g, '');
  }

  async function prepareRouterActions(input: RouterActionInput<Lookup>): Promise<RouterActionOutcome<Entities>> {
    const { admittedIntent, user, dailyOverview, workingMemory, requestId, requestReferenceTime, rawPastTurns,
      hasHistoricalEvidence, personalKnowledge, phoneNumber, isAttachmentOnlyTurn, startMs, contextElapsedMs,
      modelElapsedMs, applyDecisionContext } = input;
    let { language, timezone } = input;
    const finish = (response: RouterActionResponse<Entities>): RouterActionOutcome<Entities> => ({ handled: true, response });
    const learningMetadata: RouterLearningMetadata = admittedIntent.learningCandidatesProvided === true
      ? { learningCandidates: admittedIntent.learningCandidates, learningCandidatesProvided: true } : {};
    const contextApplied = await applyDecisionContext(admittedIntent);
    language = input.language; timezone = input.timezone;
    if (!contextApplied) return finish({ language, intent: 'clarification', executionFacts: [], ...learningMetadata });
    const semanticIntent = bindAuthoritativeFollowupTargets(admittedIntent, dailyOverview, workingMemory);
    console.log(`[router req=${requestId}] semantic intent actions=${semanticIntent.actions.map(summarizeAction).join(' | ')}`);
    const runtimeIntent = normalizeTurnIntentForRuntime(semanticIntent, {
      user,
      referenceTime: requestReferenceTime,
      timezone,
    });
    console.log(`[router req=${requestId}] runtime intent actions=${runtimeIntent.actions.map(summarizeAction).join(' | ')}`);

    const fallbackGreetingOrNotice = (lang: string) => (rawPastTurns?.length === 0
      ? (lang === 'en' ? 'Hello! How can I help you today?' : '¡Hola! ¿En qué puedo ayudarte hoy?')
      : (lang === 'en' ? 'No prior operational actions or evidence are recorded in this conversation.' : 'No hay acciones ni evidencia operativa previa registrada en esta conversación.'));

    const evidenceSelection = runtimeIntent.actions.find(action => action.evidenceRefs !== undefined);
    if (evidenceSelection) {
      const renderedEvidence = hasHistoricalEvidence
        ? renderOperationalEvidence(rawPastTurns, evidenceSelection.evidenceRefs, user.id, language)
        : fallbackGreetingOrNotice(language);
      return finish({
        ...learningMetadata,
        intent: 'chat', language,
        entities: conversationStateEntities(user, { _turnMetadata: { kind: 'conversation' } }),
        confirmation: [renderedEvidence, renderPersonalKnowledge(runtimeIntent.knowledgeRefs || [], personalKnowledge.lookup, user.id, language)].filter(Boolean).join('\n\n'),
        executionFacts: [], ctaUrl: null, ctaHeader: null, ctaButtonText: null,
        memoryDisposition: 'skip_operational',
      });
    }
    const recap = runtimeIntent.actions.find(action => action.domain === 'conversation' && action.action === 'recap');
    if (recap?.recapMode === 'historical' && runtimeIntent.responseCapability !== 'billing_info') {
      return finish({
        ...learningMetadata,
        intent: 'chat',
        entities: conversationStateEntities(user, { _turnMetadata: { kind: 'conversation' } }),
        language,
        confirmation: [renderHistoricalEvidence(rawPastTurns, undefined, user.id, language), renderPersonalKnowledge(runtimeIntent.knowledgeRefs || [], personalKnowledge.lookup, user.id, language)].filter(Boolean).join('\n\n'),
        ctaUrl: null, ctaHeader: null, ctaButtonText: null,
      });
    }
    const conversationReply = conversationReplyFromActions(runtimeIntent.actions);
    // Declared presentation authority overrides freeform billing prose, not user
    // meaning. Canonical validation has already rejected incompatible operations.
    const operationalActions = runtimeIntent.actions.filter(action => action.domain !== 'conversation');
    if (runtimeIntent.responseCapability === 'billing_info'
      && !operationalActions.some(action => action.domain === 'subscription' && action.action === 'info')) {
      operationalActions.push({ domain: 'subscription', action: 'info' });
    }

    // Structural references are not permission to create checkout. Use the pure
    // information path instead of trusting model prose (including mixed auth).
    if (operationalActions.length === 0 && hasConversationalPaymentReference(conversationReply)) {
      operationalActions.push({ domain: 'subscription', action: 'info' });
    }

    if (operationalActions.length === 0) {
      let confirmation = conversationReply || structuredDecisionError(language);
      let extractedCta: { ctaUrl: string; ctaHeader: string; ctaButtonText: string } | null = null;
      if (confirmation.includes('[auth_url]') || confirmation.includes('/auth/google')) {
        try {
          const authUrl = getGoogleConnectUrl({ userId: user?.id, phoneNumber: phoneNumber || user?.phone_number });
          extractedCta = {
            ctaUrl: authUrl,
            ctaHeader: '📅 Google Calendar',
            ctaButtonText: language === 'en' ? 'Connect' : 'Conectar',
          };
        } catch (err) {
          console.warn('[router] generating auth_url in conversation failed:', (err as { message?: unknown }).message);
        }
      }
      confirmation = await replaceTrustedLinkPlaceholders({ text: confirmation, user, phoneNumber });
      const personalAnswer = renderPersonalKnowledge(runtimeIntent.knowledgeRefs || [], personalKnowledge.lookup, user.id, language);
      if (personalAnswer) confirmation += `\n\n${personalAnswer}`;
      console.log(`[router req=${requestId}] structured conversation out in ${now() - startMs}ms (context=${contextElapsedMs}ms model=${modelElapsedMs}ms)`);
      return finish({
        ...learningMetadata,
        intent: 'chat',
        entities: conversationStateEntities(user, { _turnMetadata: { kind: 'conversation' } }),
        language,
        confirmation,
        ctaUrl: extractedCta?.ctaUrl || null,
        ctaHeader: extractedCta?.ctaHeader || null,
        ctaButtonText: extractedCta?.ctaButtonText || null,
        plan: { type: 'turn_intent', actions: runtimeIntent.actions.map(({ domain, action }) => ({ domain, action })) },
        executionFacts: [],
        memoryDisposition: isAttachmentOnlyTurn ? 'skip_attachment' : 'extract',
      });
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

    return { handled: false, runtimeIntent, learningMetadata, operationalActions, recap, conversationReply };
  }
  return { prepareRouterActions, replaceTrustedLinkPlaceholders };
}
