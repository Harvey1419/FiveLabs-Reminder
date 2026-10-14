import { createRouterProfileContext, type RouterProfileDependencies, type RouterProfileFact, type RouterProfileUser } from './router-profile-context.js';
import { safeLogSnippet } from './router-action-preparation.js';
import { sanitizeUserQueryText } from './router-model-context.js';
export interface RouterInitialHistoryTurn extends Record<string, unknown> { role?: unknown; content?: unknown; entities?: { _responseLanguage?: unknown } }
export interface RouterTurnInitializationOptions extends Record<string, unknown> {
  requestTimeMs?: unknown; referenceTime?: unknown; currentUserText?: unknown; correlationId?: unknown; inputModality?: unknown; attachmentOnly?: unknown;
}
export interface RouterTurnInitializationDependencies<Fact extends RouterProfileFact> {
  profileDependencies: RouterProfileDependencies<Fact>;
  isAdminUser(user: RouterProfileUser): boolean;
  computeOffsetMinutes(timezone: string, referenceTime: Date): unknown;
  nowISO(timezone: string, referenceTime: Date): string; nowHuman(timezone: string, language: string, referenceTime: Date): string;
  hydrateClarificationStateFromHistory(user: RouterProfileUser, history: readonly RouterInitialHistoryTurn[]): unknown;
  hydrateWorkingMemoryFromHistory(user: RouterProfileUser, history: readonly RouterInitialHistoryTurn[], referenceTime: Date): unknown;
  now(): number; logger: Pick<Console, 'log'>;
}
/** Request anchors and hydration precede context reads; profile effects remain injected host capabilities. */
export function createRouterTurnInitialization<Fact extends RouterProfileFact>(dependencies: RouterTurnInitializationDependencies<Fact>) {
  const { profileDependencies, isAdminUser, computeOffsetMinutes, nowISO, nowHuman,
    hydrateClarificationStateFromHistory, hydrateWorkingMemoryFromHistory, now, logger: console } = dependencies;
  function initializeRouterTurn(messageText: unknown, userOrPhone: unknown, history: readonly RouterInitialHistoryTurn[] = [], options: RouterTurnInitializationOptions = {}, contextEffects: Fact[] = []) {
    const startMs = now();
    const requestedReferenceMs = options?.requestTimeMs != null
      ? Number(options.requestTimeMs)
      : (options?.referenceTime != null ? new Date(options.referenceTime as string | number).getTime() : NaN);
    const requestReferenceTime = new Date(Number.isFinite(requestedReferenceMs) ? requestedReferenceMs : startMs);
    const profileContext = createRouterProfileContext(profileDependencies, { messageText, userOrPhone, history, suppliedCurrentUserText: options?.currentUserText, contextEffects });
    const { user, currentUserText, phoneNumber } = profileContext;
    let { timezone, language } = profileContext;
    const isAdmin = isAdminUser(user);
    const requestId = options?.correlationId || 'none';
    const inputModality = options?.inputModality || 'text';

    computeOffsetMinutes(timezone, requestReferenceTime);
    const nowStr = nowISO(timezone, requestReferenceTime);
    const nowHumanStr = nowHuman(timezone, language, requestReferenceTime);
    console.log(`[router req=${requestId}] in modality=${inputModality} text="${safeLogSnippet(messageText, 180)}" phone=${phoneNumber} tz=${timezone} admin=${isAdmin}`);

    const trustedMessageText = currentUserText;
    const sanitizedUserText = sanitizeUserQueryText(trustedMessageText);
    const hasAttachmentEvidence = /<untrusted_attachment_content>/i.test(String(messageText || ''));
    const isAttachmentOnlyTurn = options?.attachmentOnly === true || (hasAttachmentEvidence && !currentUserText);

    hydrateClarificationStateFromHistory(user, history);
    hydrateWorkingMemoryFromHistory(user, history, requestReferenceTime);

    return { startMs, requestReferenceTime, profileContext, user, currentUserText, phoneNumber, isAdmin, requestId,
      inputModality, nowStr, nowHumanStr, trustedMessageText, sanitizedUserText, isAttachmentOnlyTurn };
  }
  return { initializeRouterTurn };
}
