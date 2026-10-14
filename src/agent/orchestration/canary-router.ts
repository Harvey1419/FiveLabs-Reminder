import type { ProductivityConversation, TurnContext } from '@templelabs/contracts';
import type { InboundTurnLease } from '../core/turn-lease.js';
import type { InboundStoredTurn } from '../../adapters/agent-core/inbound-checkpoint-reader.js';
import { rejectBeforeEngine } from '../core/admission-rejection.js';
import { selectCanaryEngine, type CanaryPolicy } from './canary-selector.js';

export type CanaryRoute<Result> = (text: unknown, user: unknown, history?: readonly unknown[], options?: Record<string, unknown>) => Promise<Result>;
export interface CanaryAdmission { context: TurnContext; threadId: string; prior: InboundStoredTurn | null; handoff?: ProductivityConversation }
function blocked(): never {
  throw Object.assign(new Error('Turn requires reconciliation before engine admission'), { code: 'PRIOR_TURN_RECONCILIATION_REQUIRED' });
}
const managed = ['agentCore', 'agentCoreResolution', 'agentCoreProductivity', 'agentCoreActiveRun', 'agentCoreActiveResolution',
  'agentCoreActiveCompletion', 'agentCoreDeliveryManifest', 'agentCoreBaseline', 'agentCoreAdmissionRejected'];

export function createCanaryRouter<Result>(deps: {
  baseline: CanaryRoute<Result>;
  v2(text: string, user: unknown, options: Record<string, unknown>, admission: CanaryAdmission): Promise<Result>;
  handoff?(prior: InboundStoredTurn, context: TurnContext, threadId: string, history: readonly unknown[]): Promise<ProductivityConversation | null>;
  policy(): CanaryPolicy;
  lease(): InboundTurnLease | null;
  readPrior(context: TurnContext, threadId: string): Promise<InboundStoredTurn | null>;
}) {
  const admittedV2 = new WeakSet<object>();
  return async (text: unknown, user: unknown, history: readonly unknown[] = [], options: Record<string, unknown> = {}): Promise<Result> => {
    const selected = selectCanaryEngine(deps.policy(), user);
    const lease = deps.lease();
    // Existing CLI/background callers have no queue owner and retain the stable baseline.
    if (!lease) return deps.baseline(text, user, history, options);
    lease.signal.throwIfAborted();
    if (admittedV2.has(lease) || managed.some(key => Object.hasOwn(lease.inboundTurn.response, key))) blocked();
    if (!user || typeof user !== 'object' || !('id' in user) || typeof user.id !== 'string' || !user.id) blocked();
    const timezone = 'timezone' in user && typeof user.timezone === 'string' ? user.timezone : 'America/Bogota';
    const language = 'locale' in user && typeof user.locale === 'string' && user.locale.startsWith('en') ? 'en' : 'es';
    const context: TurnContext = { userId: user.id, runId: lease.inboundTurn.id, requestId: lease.inboundTurn.messageId,
      timezone, language, referenceTimeIso: new Date().toISOString(), capabilities: new Set(), signal: lease.signal };
    // Search ALL older unknown turns even during rollback; do not replay in another engine.
    let prior: InboundStoredTurn | null;
    try { prior = await deps.readPrior(context, lease.inboundTurn.threadId); }
    catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'PRIOR_TURN_RECONCILIATION_REQUIRED' && !Object.keys(lease.inboundTurn.response).length) {
        return rejectBeforeEngine(lease, context.userId, 'PRIOR_TURN_RECONCILIATION_REQUIRED');
      }
      throw error;
    }
    if (prior?.status !== undefined && prior.status !== 'completed') blocked();
    const priorV2 = prior?.response && ['agentCoreProductivity', 'agentCoreActiveCompletion', 'agentCoreActiveResolution']
      .some(key => Object.hasOwn(prior.response!, key));
    if (priorV2) {
      // Validate the prior V2 state before allowing either continuation or rollback.
      const { recoverProductivityStoredTurn } = await import('../../adapters/agent-core/productivity-state-recovery.js');
      recoverProductivityStoredTurn(prior, context.userId);
    } else if (prior && managed.some(key => Object.hasOwn(prior.response ?? {}, key))) blocked();
    const delivery = options.agentCoreDelivery;
    const supported = typeof text === 'string' && text.trim().length > 0 && text.length <= 8000
      && (!options.inputModality || options.inputModality === 'text' || options.inputModality === 'audio') && !options.attachmentOnly
      && delivery !== null && typeof delivery === 'object' && 'send' in delivery && typeof delivery.send === 'function';
    // Unsupported input remains on its existing engine before admission.
    if (selected === 'v2' && priorV2 && !supported) return rejectBeforeEngine(lease, context.userId, 'V2_UNSUPPORTED_INPUT');
    if (selected !== 'v2' || !supported) return deps.baseline(text, user, history, options);
    let handoff: ProductivityConversation | undefined;
    if (prior && !priorV2) {
      let transferred: ProductivityConversation | null | undefined;
      try { transferred = await deps.handoff?.(prior, context, lease.inboundTurn.threadId, history); }
      catch {
        // Handoff only reads. Persist proof before leaving admission so a failed read
        // cannot turn into an unknown execution and quarantine the next message.
        return rejectBeforeEngine(lease, context.userId, 'BASELINE_HANDOFF_FAILED');
      }
      if (!transferred) return rejectBeforeEngine(lease, context.userId, 'BASELINE_HANDOFF_RECONCILIATION_REQUIRED');
      if (transferred.userId !== context.userId) blocked();
      handoff = transferred;
    }
    // Once admitted, failures propagate. Never execute the baseline as a retry after V2 effects.
    await lease.assertActive();
    admittedV2.add(lease);
    return deps.v2(text as string, user, options, { context, threadId: lease.inboundTurn.threadId, prior, ...(handoff ? { handoff } : {}) });
  };
}
