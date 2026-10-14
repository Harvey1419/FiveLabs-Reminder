import type { RouterProfileUser } from './router-profile-context.js';
export interface RouterContextMemory extends Record<string, unknown> { contextCategory?: unknown; category?: unknown; topic_key?: unknown; content?: unknown }
export interface RouterMemoryReadQuery { userId: string | undefined; limit: number; queryText?: string }
export interface RouterMemoryReadResult<Memory> { status?: unknown; memories?: Memory[] | null }
type MemoryReadMethod<Memory> = (query: RouterMemoryReadQuery) => Promise<RouterMemoryReadResult<Memory> | null | undefined>;
export interface RouterKnowledgeIndex<Memory> { refs: ReadonlyMap<Memory, string>; lookup: unknown }
export interface RouterContextReadDependencies<Memory extends RouterContextMemory, Overview, Subscription, Integration, Knowledge extends RouterKnowledgeIndex<Memory>> {
  getMemoryServiceMethod(name: string): unknown;
  retrieveRelevantMemories(query: RouterMemoryReadQuery): Promise<Memory[]>;
  retrieveStandingPreferences(query: RouterMemoryReadQuery): Promise<Memory[]>;
  getDailyOverview(query: { userId: string | undefined; phoneNumber: string | null | undefined; timezone: string }): Promise<Overview>;
  getUserSubscription(userId: string): Promise<Subscription>;
  getUserIntegration(userId: string, provider: 'google'): Promise<Integration>;
  hasProAccess(subscription: Subscription | null | undefined, user: RouterProfileUser): boolean;
  buildPersonalKnowledge(userId: string | undefined, memories: Memory[], preferences: Memory[]): Knowledge;
  now(): number; logger: Pick<Console, 'warn'>;
}

/** Reads remain host capabilities; incomplete entitlement never reuses a previous Pro decision. */
export function createRouterContextReads<Memory extends RouterContextMemory, Overview, Subscription, Integration, Knowledge extends RouterKnowledgeIndex<Memory>>({ getMemoryServiceMethod, retrieveRelevantMemories, retrieveStandingPreferences, getDailyOverview, getUserSubscription, getUserIntegration, hasProAccess, buildPersonalKnowledge, now, logger }: RouterContextReadDependencies<Memory, Overview, Subscription, Integration, Knowledge>) {
  function optionalMemoryServiceMethod(name: string): MemoryReadMethod<Memory> | null {
    try { return typeof getMemoryServiceMethod(name) === 'function' ? getMemoryServiceMethod(name) as MemoryReadMethod<Memory> : null; }
    catch { return null; }
  }
  async function loadRouterContext({ user, currentUserText, phoneNumber, timezone }: { user: RouterProfileUser; currentUserText: string; phoneNumber: string | null | undefined; timezone: string }) {
    const getProactive = typeof getMemoryServiceMethod('getProactiveAnchors') === 'function'
      ? getMemoryServiceMethod('getProactiveAnchors') as (query: { userId: string; maxEntities: number; maxRecentEpisodes: number }) => Promise<Memory[]>
      : () => Promise.resolve([]);

    const contextStart = now();
    const retrieveRelevantMemoriesResult = optionalMemoryServiceMethod('retrieveRelevantMemoriesResult');
    const retrieveStandingPreferencesResult = optionalMemoryServiceMethod('retrieveStandingPreferencesResult');
    const retrieveRelevantResult = retrieveRelevantMemoriesResult
      ? retrieveRelevantMemoriesResult({ userId: user.id, queryText: currentUserText, limit: 3 })
      : retrieveRelevantMemories({ userId: user.id, queryText: currentUserText, limit: 3 }).then((memories) => ({ status: 'available', memories }));
    const retrievePreferencesResult = retrieveStandingPreferencesResult
      ? (user.id ? retrieveStandingPreferencesResult({ userId: user.id, limit: 5 }) : Promise.resolve({ status: 'available', memories: [] }))
      : (user.id ? retrieveStandingPreferences({ userId: user.id, limit: 5 }).then((memories) => ({ status: 'available', memories })) : Promise.resolve({ status: 'available', memories: [] }));
    const [relevantResult, preferenceResult, proactiveAnchors, dailyOverview, subscription, googleIntegration] = await Promise.all([
      retrieveRelevantResult,
      retrievePreferencesResult,
      user.id ? getProactive({ userId: user.id, maxEntities: 2, maxRecentEpisodes: 2 }) : Promise.resolve([]),
      getDailyOverview({ userId: user.id, phoneNumber, timezone }),
      user.id ? getUserSubscription(user.id).catch(error => {
        logger.warn('[router] subscription entitlement unavailable:', (error as { message?: unknown }).message);
        return undefined;
      }) : Promise.resolve(null),
      user.id ? getUserIntegration(user.id, 'google') : Promise.resolve(null),
    ]);
    const relevantMemories = relevantResult?.memories || [];
    const standingPreferences = preferenceResult?.memories || [];
    const memoryRetrievalStatus = [relevantResult, preferenceResult].every(result => result?.status === 'unavailable')
      ? 'unavailable' : [relevantResult, preferenceResult].some(result => result?.status !== 'available') ? 'partial' : 'available';
    const contextElapsedMs = now() - contextStart;

    const entitlementKnown = subscription !== undefined;
    const effectiveSub = subscription;
    const isPro = entitlementKnown && hasProAccess(effectiveSub, user);
    // Do not reuse stale entitlement after a failed authoritative lookup.
    if (entitlementKnown) user.subscription = effectiveSub;
    else delete user.subscription;
    user.isPro = isPro;

    // On zero-query greetings/check-ins, vector search yields 0 matches. Fallback to proactive anchors.
    const effectiveMemories = (relevantMemories || []).length > 0
      ? relevantMemories
      : (proactiveAnchors || []).slice(0, 3);
    user.memories = effectiveMemories;
    user.preferences = standingPreferences || [];

    const personalKnowledge = buildPersonalKnowledge(user.id, effectiveMemories, standingPreferences);
    const knowledgeHint = (record: Memory) => personalKnowledge.refs.has(record)
      ? ` [${personalKnowledge.refs.get(record)}] [topicKey=${record.topic_key}]` : '';
    const memoryHints = effectiveMemories.length > 0
      ? effectiveMemories.map((memory) => `- [${memory.contextCategory || memory.category || 'memoria'}]${knowledgeHint(memory)} ${memory.content}`).join('\n')
      : '';
    const preferenceHints = (standingPreferences || []).length > 0
      ? standingPreferences.map((pref) => `- [${pref.contextCategory || pref.category || 'preferencia'}]${knowledgeHint(pref)} ${pref.content}`).join('\n')
      : '';
    return { relevantMemories, standingPreferences, proactiveAnchors, dailyOverview, subscription, googleIntegration, memoryRetrievalStatus, contextElapsedMs, entitlementKnown, isPro, effectiveMemories, personalKnowledge, memoryHints, preferenceHints };
  }
  return { loadRouterContext };
}
