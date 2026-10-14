import type { RouterActionUser } from './router-action-preparation.js';
export interface RouterTurnMetadata extends Record<string, unknown> { mutationReceipts?: unknown; interpretationOutcome?: unknown }
export interface RouterLifecycleEntities extends Record<string, unknown> { readonly [key: symbol]: string | undefined }
export interface RouterLifecycleResult<Fact> {
  entities?: RouterLifecycleEntities; executionFacts?: Fact[]; language: string; confirmation?: unknown; memoryDisposition?: unknown;
}
export interface RouterTurnLifecycleDependencies<Fact, Result extends RouterLifecycleResult<Fact>> {
  routeMessageInternal(messageText: unknown, userOrPhone: unknown, history: readonly unknown[], options: Record<string, unknown>, contextEffects: Fact[]): Promise<Result>;
  getClarificationStateSnapshot(user: RouterActionUser): unknown; getWorkingMemorySnapshot(user: RouterActionUser): unknown;
  carryCreationReceiptEvents(history: readonly unknown[], receipts: unknown): unknown;
  carryOperationalEvidence(history: readonly unknown[], facts: Fact[], owner: string, interpretationOutcome: unknown): unknown;
  composeExecutionReply(facts: Fact[], language: string): string;
}
/** Private per-instance owner binding stays local; historical carry precedes profile receipt composition. */
export function createRouterTurnLifecycle<Fact, Result extends RouterLifecycleResult<Fact>>(dependencies: RouterTurnLifecycleDependencies<Fact, Result>) {
  const { routeMessageInternal, getClarificationStateSnapshot, getWorkingMemorySnapshot, carryCreationReceiptEvents,
    carryOperationalEvidence, composeExecutionReply } = dependencies;
  const EVIDENCE_OWNER = Symbol('local evidence owner');
  function conversationStateEntities(user: RouterActionUser, extra: Record<string, unknown> = {}): RouterLifecycleEntities {
    const entities: RouterLifecycleEntities = {
      ...extra,
      _conversationState: getClarificationStateSnapshot(user),
      _workingMemory: getWorkingMemorySnapshot(user),
    };
    // Local-only binding: the persisted carry stores a domain-separated owner
    // digest, never a copied user ID. No user message can set this symbol.
    Object.defineProperty(entities, EVIDENCE_OWNER, { value: user.id });
    return entities;
  }

  /** Compose profile persistence evidence with domain evidence at the same boundary. */
  async function routeMessage(messageText: unknown, userOrPhone: unknown, history: readonly unknown[] = [], options: Record<string, unknown> = {}) {
    const contextEffects: Fact[] = [];
    const result = await routeMessageInternal(messageText, userOrPhone, history, options, contextEffects);
    // Persist the same bounded carry on every returned assistant turn, including
    // ordinary conversation, failed reads and provider failure. User metadata never mints it.
    const metadata = (result.entities?._turnMetadata || {}) as RouterTurnMetadata;
    const owner = result.entities?.[EVIDENCE_OWNER];
    result.entities = { ...result.entities, _turnMetadata: {
      ...metadata,
      creationReceiptEvents: carryCreationReceiptEvents(history, metadata.mutationReceipts),
      ...(owner ? { operationalEvidence: carryOperationalEvidence(history, result.executionFacts || [], owner, metadata.interpretationOutcome) } : {}),
    } };
    if (!contextEffects.length) return result;
    const executionFacts = [...contextEffects, ...(result.executionFacts || [])];
    // Domain presentation already validated the requested fields/framing. Adding
    // a profile receipt must not replace it with a generic recomposition.
    const profileReceipt = composeExecutionReply(contextEffects, result.language);
    return { ...result, executionFacts, confirmation: [profileReceipt, result.confirmation].filter(Boolean).join('\n\n'), memoryDisposition: result.memoryDisposition === 'processed' ? 'processed' : 'skip_operational' };
  }
  return { conversationStateEntities, routeMessage };
}
