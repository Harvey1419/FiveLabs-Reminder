export interface RouterProfileUser extends Record<string, unknown> {
  id?: string; phone_number?: string | null; timezone?: string | null; locale?: string | null;
}
export interface RouterProfileUpdate { sourceQuote?: string; timezone?: string | null; language?: string | null }
interface LanguageCandidate { topicKey?: unknown; category?: unknown; content?: string; evidence?: string }
export interface RouterProfileDecision {
  responseLanguage?: string; profileUpdate?: RouterProfileUpdate; learningCandidates?: unknown;
}
export interface RouterProfilePatch { timezone?: string; locale?: 'en-US' | 'es-CO' }
export interface RouterProfileFact extends Record<string, unknown> { tool?: unknown; success?: unknown; presentationData?: unknown }
interface ProfileHistoryTurn { role?: unknown; entities?: { _responseLanguage?: unknown } }
export interface RouterProfileDependencies<Fact extends RouterProfileFact> {
  extractCurrentUserText(modelContext: unknown, supplied: unknown): string;
  detectLanguageFromText(text: string): string | null;
  explicitEnglishDirective: RegExp; explicitSpanishDirective: RegExp;
  assertTurnLease(): Promise<unknown>;
  updateUserPreferences(userId: string, patch: RouterProfilePatch): Promise<unknown>;
  createExecutionFact(input: { toolName: 'profile'; params: { action: 'update' }; language: string;
    result: { success: boolean; action: 'profile_updated'; data: RouterProfilePatch | null; rawSummary: string } }): Fact;
}

/** Preserves current-turn profile evidence and observed persistence through host-owned ports. */
export function createRouterProfileContext<Fact extends RouterProfileFact>(
  { extractCurrentUserText, detectLanguageFromText, explicitEnglishDirective: EXPLICIT_ENGLISH_DIRECTIVE_RE, explicitSpanishDirective: EXPLICIT_SPANISH_DIRECTIVE_RE, assertTurnLease, updateUserPreferences, createExecutionFact }: RouterProfileDependencies<Fact>,
  { messageText, userOrPhone, history = [], suppliedCurrentUserText, contextEffects }: { messageText: unknown; userOrPhone: unknown; history?: readonly ProfileHistoryTurn[]; suppliedCurrentUserText?: unknown; contextEffects: Fact[] },
) {
  const user = typeof userOrPhone === 'string'
    ? { phone_number: userOrPhone, timezone: 'America/Bogota', locale: 'es-CO' }
    : (userOrPhone || { phone_number: '', timezone: 'America/Bogota', locale: 'es-CO' }) as RouterProfileUser;
  const currentUserText = extractCurrentUserText(messageText, suppliedCurrentUserText);
  let timezone = user.timezone || 'America/Bogota';
  const phoneNumber = user.phone_number;
  const isProfileEnglish = Boolean(user.locale?.startsWith('en'));
  const detectedUserLanguage = detectLanguageFromText(currentUserText);
  const isExplicitEnglish = EXPLICIT_ENGLISH_DIRECTIVE_RE.test(currentUserText?.trim?.() || '');
  const isExplicitSpanish = EXPLICIT_SPANISH_DIRECTIVE_RE.test(currentUserText?.trim?.() || '');
  const conversationLanguage = [...history].reverse().find(turn => turn.role === 'assistant'
    && ['en', 'es'].includes(turn.entities?._responseLanguage as string))?.entities?._responseLanguage;
  let language = isProfileEnglish
    ? (isExplicitSpanish ? 'es' : 'en')
    : (isExplicitEnglish || (conversationLanguage === 'en' && detectedUserLanguage !== 'es') ? 'en' : 'es');
  const applyDecisionContext = async (decision: RouterProfileDecision): Promise<boolean> => {
    if (decision.responseLanguage) {
      const hasSpanishDirectiveInRaw = /español|castellano|spanish/i.test((messageText || '') as string);
      const hasEnglishDirectiveInRaw = /ingl[eé]s|english/i.test((messageText || '') as string);

      const forbidSpanishOverwrite = (isProfileEnglish || detectedUserLanguage === 'en')
        && detectedUserLanguage !== 'es'
        && !hasSpanishDirectiveInRaw
        && decision.responseLanguage === 'es';

      const forbidEnglishOverwrite = (detectedUserLanguage === 'es' || (!isProfileEnglish && conversationLanguage === 'es'))
        && detectedUserLanguage !== 'en'
        && !hasEnglishDirectiveInRaw
        && decision.responseLanguage === 'en';

      if (!forbidSpanishOverwrite && !forbidEnglishOverwrite) {
        language = decision.responseLanguage;
      }
    }
    let update = decision.profileUpdate;
    if (!update && Array.isArray(decision.learningCandidates)) {
      const candidate = (decision.learningCandidates as LanguageCandidate[]).find(c =>
        c?.topicKey === 'preference/language'
        && (c.category === 'preference' || /ingl[eé]s|english/i.test(c.content || ''))
        && typeof c.evidence === 'string' && c.evidence.trim()
        && currentUserText.includes(c.evidence.trim())
      );
      if (candidate) {
        update = { sourceQuote: candidate.evidence!.trim(), language: 'en' };
        decision.profileUpdate = update;
      }
    }
    if (!update) return true;
    const patch: RouterProfilePatch = { ...(update.timezone ? { timezone: update.timezone } : {}),
      ...(update.language ? { locale: update.language === 'en' ? 'en-US' : 'es-CO' } : {}) };
    if (!Object.keys(patch).length) return true;
    if (contextEffects.some(fact => fact.tool === 'profile' && fact.success
      && Object.entries(patch).every(([key, value]) => (fact.presentationData as Record<string, unknown> | null | undefined)?.[key] === value))) return true;
    let saved: unknown = null;
    if (user.id && currentUserText.includes(update.sourceQuote?.trim() as string) && update.sourceQuote?.trim()) {
      await assertTurnLease();
      try { saved = await updateUserPreferences(user.id, patch); } catch { /* observed failure below */ }
    }
    const success = Boolean(saved && Object.entries(patch).every(([key, value]) => (saved as Record<string, unknown>)[key] === value));
    contextEffects.push(createExecutionFact({ toolName: 'profile', params: { action: 'update' }, language,
      result: { success, action: 'profile_updated', data: success ? patch : null,
        rawSummary: success
          ? (language === 'en' ? 'Saved your profile preferences.' : 'Guardé tus preferencias de perfil.')
          : (language === 'en' ? 'I could not confirm the profile change, so I did not execute the related actions.' : 'No pude confirmar el cambio de perfil, así que no ejecuté las acciones relacionadas.') } }));
    if (success) { Object.assign(user, patch); timezone = user.timezone || timezone; }
    return success;
  };
  return { user, currentUserText, phoneNumber, get language() { return language; }, get timezone() { return timezone; }, applyDecisionContext };
}
