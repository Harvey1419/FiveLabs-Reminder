import { jsonObjectSchema, type JsonObject, type ProductivityConversation, type TurnContext } from '@templelabs/contracts';
import { requireInboundTurnLease } from '../../agent/core/turn-lease.js';
import { inboundStoredTurnSchema, type InboundStoredTurn } from './inbound-checkpoint-reader.js';
import { createInterruptedActiveCompletionReader } from './interrupted-active-completion.js';
import { recoverActiveTurnCompletion } from './active-turn-completion.js';
import { checkpointFingerprint } from './checkpoint-fingerprint.js';
import type { ActiveRunRpcClient } from './active-run-store.js';

function fail(code: string, report?: unknown): never { throw Object.assign(new Error(code), { code, report }); }
const json = (value: unknown) => jsonObjectSchema.parse(value);
const hash = (value: unknown) => checkpointFingerprint(json(value));
export interface InterruptedCompletionRecoveryResult {
  readonly status: 'completed';
  readonly prior: InboundStoredTurn;
  readonly conversation: ProductivityConversation;
  readonly publication: 'acknowledged' | 'observed';
  readonly requiresHistoryReload: true;
  readonly grantsExecution: false;
}
/** One historical closure only. The current lease stays live; continuity must be reloaded across ALL prior turns. */
export function createInterruptedCompletionRecoveryRuntime(client: ActiveRunRpcClient, rawOwner: { readonly id: string; readonly token: string }) {
  const owner = { ...rawOwner }, reader = createInterruptedActiveCompletionReader(client, owner);
  let attempted = false;
  return { async recover(rawContext: TurnContext, threadId: string, expectedPrior?: InboundStoredTurn): Promise<InterruptedCompletionRecoveryResult | null> {
    const admittedPrior = expectedPrior ? inboundStoredTurnSchema.parse(structuredClone(expectedPrior)) : undefined;
    const lease = requireInboundTurnLease(), context = { ...rawContext, capabilities: new Set(rawContext.capabilities) };
    if (!context.capabilities.has('agent_core.reconcile') || !context.capabilities.has('agent_core.handoff')) fail('INTERRUPTED_COMPLETION_ACCESS_DENIED');
    if (context.runId !== owner.id || lease.inboundTurn.id !== owner.id || context.requestId !== lease.inboundTurn.messageId
      || lease.inboundTurn.threadId !== threadId) fail('INTERRUPTED_COMPLETION_OWNER_MISMATCH');
    if (['agentCore','agentCoreProductivity','agentCoreResolution','agentCoreActiveRun','agentCoreActiveResolution','agentCoreActiveCompletion','agentCoreDeliveryManifest','agentCoreBaseline']
      .some(key => Object.hasOwn(lease.inboundTurn.response, key))) fail('INTERRUPTED_COMPLETION_CURRENT_TURN_STARTED');
    if (attempted) fail('INTERRUPTED_COMPLETION_REPLAY_FORBIDDEN');
    attempted = true;
    const signal = AbortSignal.any([context.signal, lease.signal, AbortSignal.timeout(30000)]);
    context.signal = signal;
    const fresh = async () => { signal.throwIfAborted(); await lease.assertActive(); signal.throwIfAborted(); };
    await fresh();
    const loaded = await reader.load(context, threadId);
    if (!loaded) return null;
    const { evidence, report } = loaded;
    if (admittedPrior && hash(evidence.snapshot.prior) !== hash(admittedPrior)) fail('INTERRUPTED_COMPLETION_SOURCE_CHANGED');
    if (!report.completion || report.status !== 'verifiable') fail('INTERRUPTED_COMPLETION_RECONCILIATION_REQUIRED', report);
    const expected = structuredClone(evidence), completion = structuredClone(report.completion);
    const args: JsonObject = { p_owner_id: owner.id, p_owner_token: owner.token, p_user_id: context.userId,
      p_request_id: context.requestId, p_thread_id: threadId, p_expected: json(expected), p_completion: json(completion) };
    const invoke = async (name: string) => {
      await fresh();
      const bounded = AbortSignal.any([signal, AbortSignal.timeout(15000)]);
      let abort: () => void = () => {};
      const cancelled = new Promise<never>((_resolve, reject) => {
        abort = () => reject(bounded.reason); bounded.addEventListener('abort', abort, { once: true }); if (bounded.aborted) abort();
      });
      let result: { readonly data: unknown; readonly error: unknown };
      try { result = await Promise.race([Promise.resolve(client.rpc(name, structuredClone(args))), cancelled]); }
      catch { signal.throwIfAborted(); fail('INTERRUPTED_COMPLETION_STORAGE_UNCERTAIN'); }
      finally { bounded.removeEventListener('abort', abort); }
      await fresh();
      if (result.error) fail('INTERRUPTED_COMPLETION_STORAGE_UNCERTAIN');
      return result.data;
    };
    let data: unknown, publication: InterruptedCompletionRecoveryResult['publication'] = 'acknowledged';
    try { data = await invoke('resolve_hermes_interrupted_active_completion'); }
    catch (error) {
      if (!(error instanceof Error) || !('code' in error) || error.code !== 'INTERRUPTED_COMPLETION_STORAGE_UNCERTAIN') throw error;
      // A commit can succeed while its reply is lost. Observe once; never issue another write.
      data = await invoke('observe_hermes_interrupted_active_completion');
      publication = 'observed';
      if (data === null) fail('INTERRUPTED_COMPLETION_STORAGE_UNCERTAIN');
    }
    if (data === null) fail('INTERRUPTED_COMPLETION_CONFLICT');
    const prior = inboundStoredTurnSchema.parse(data), original = expected.snapshot.prior;
    if (prior.id !== original.id || prior.message_id !== original.message_id || prior.thread_id !== original.thread_id
      || prior.sequence_id !== original.sequence_id || prior.status !== 'completed'
      || hash(prior.response) !== hash({ ...original.response, agentCoreActiveCompletion: completion })) fail('INTERRUPTED_COMPLETION_PUBLICATION_MISMATCH');
    const conversation = recoverActiveTurnCompletion(prior, context.userId);
    await fresh();
    // A later unresolved turn still blocks the normal recovery loader; this historical result is not a current baseline grant.
    return { status: 'completed', prior: structuredClone(prior), conversation, publication, requiresHistoryReload: true, grantsExecution: false };
  } };
}
