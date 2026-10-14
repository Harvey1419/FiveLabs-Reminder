import { z } from 'zod';
import { jsonObjectSchema, type JsonObject, type TurnContext } from '@templelabs/contracts';
import { requireInboundTurnLease } from '../../agent/core/turn-lease.js';
import { inboundStoredTurnSchema } from './inbound-checkpoint-reader.js';
import { createInterruptedCompletionRecoveryRuntime } from './interrupted-completion-recovery-runtime.js';
import { recoverProductivityStoredTurn, inspectProductivityTurn, type ProductivityStateRecoveryPort } from './productivity-state-recovery.js';
import { checkpointFingerprint } from './checkpoint-fingerprint.js';
import type { ActiveRunRpcClient } from './active-run-store.js';

const entrySchema = z.strictObject({
  anchor: z.strictObject({ id: z.string().min(1), message_id: z.string().min(1), thread_id: z.string().min(1),
    sequence_id: z.number().int().positive().refine(Number.isSafeInteger) }),
  prior: inboundStoredTurnSchema.nullable(),
});
const managedKeys = ['agentCore','agentCoreProductivity','agentCoreResolution','agentCoreActiveRun',
  'agentCoreActiveResolution','agentCoreActiveCompletion','agentCoreDeliveryManifest','agentCoreBaseline'];
function fail(code: string, report?: unknown): never { throw Object.assign(new Error(code), { code, report }); }

/** Startup gate: one historical closure, followed by an authoritative reload of ALL prior turns. */
export function createOwnedProductivityStateRecovery(client: ActiveRunRpcClient,
  rawOwner: { readonly id: string; readonly token: string }): ProductivityStateRecoveryPort {
  const owner = { ...rawOwner };
  let admitted = false;
  return { async load(rawContext: TurnContext, threadId: string) {
    const lease = requireInboundTurnLease(), context = { ...rawContext, capabilities: new Set(rawContext.capabilities) };
    if (!context.capabilities.has('agent_core.reconcile')) fail('PRODUCTIVITY_ENTRY_ACCESS_DENIED');
    if (owner.id !== context.runId || owner.id !== lease.inboundTurn.id || context.requestId !== lease.inboundTurn.messageId
      || threadId !== lease.inboundTurn.threadId) fail('PRODUCTIVITY_ENTRY_OWNER_MISMATCH');
    if (managedKeys.some(key => Object.hasOwn(lease.inboundTurn.response, key))) fail('PRODUCTIVITY_ENTRY_CURRENT_TURN_STARTED');
    if (admitted) fail('PRODUCTIVITY_ENTRY_REPLAY_FORBIDDEN');
    admitted = true;
    const signal = AbortSignal.any([context.signal, lease.signal, AbortSignal.timeout(60000)]);
    context.signal = signal;
    const fresh = async () => { signal.throwIfAborted(); await lease.assertActive(); signal.throwIfAborted(); };
    const read = async () => {
      await fresh();
      const bounded = AbortSignal.any([signal, AbortSignal.timeout(15000)]);
      let abort: () => void = () => {};
      const cancelled = new Promise<never>((_resolve, reject) => {
        abort = () => reject(bounded.reason); bounded.addEventListener('abort', abort, { once: true }); if (bounded.aborted) abort();
      });
      const args: JsonObject = { p_owner_id: owner.id, p_owner_token: owner.token, p_user_id: context.userId,
        p_request_id: context.requestId, p_thread_id: threadId };
      let result: { data: unknown; error: unknown };
      try { result = await Promise.race([Promise.resolve(client.rpc('read_hermes_productivity_turn_entry', args)), cancelled]); }
      catch { signal.throwIfAborted(); fail('PRODUCTIVITY_ENTRY_STORAGE_UNAVAILABLE'); }
      finally { bounded.removeEventListener('abort', abort); }
      await fresh();
      if (result.error || result.data === null) fail('PRODUCTIVITY_ENTRY_STORAGE_UNAVAILABLE');
      const entry = entrySchema.parse(result.data), { anchor, prior } = entry;
      if (anchor.id !== owner.id || anchor.message_id !== context.requestId || anchor.thread_id !== threadId
        || (prior && (prior.thread_id !== threadId || prior.id === anchor.id || prior.sequence_id >= anchor.sequence_id
          || prior.status === 'running'))) fail('PRODUCTIVITY_ENTRY_INVALID_ORDER');
      return entry;
    };
    const first = await read();
    if (first.prior === null) return undefined; // Only explicit, owner-authenticated genesis.
    let prior = first.prior;
    if (prior.status === 'unknown') {
      const response = prior.response ?? {};
      const baseline = response.agentCoreBaseline;
      const recorded = baseline !== null && typeof baseline === 'object' && !Array.isArray(baseline) && baseline.inputRecorded === true;
      if (!recorded || !Object.hasOwn(response, 'agentCoreActiveRun') || managedKeys.filter(key =>
        !['agentCoreActiveRun','agentCoreBaseline','agentCoreDeliveryManifest'].includes(key)).some(key => Object.hasOwn(response,key))) {
        fail('PRIOR_TURN_RECONCILIATION_REQUIRED', inspectProductivityTurn(prior,context.userId));
      }
      const closed = await createInterruptedCompletionRecoveryRuntime(client,owner).recover(context,threadId,prior);
      if (!closed) fail('PRODUCTIVITY_ENTRY_SOURCE_CHANGED');
      const reloaded = await read();
      if (JSON.stringify(first.anchor) !== JSON.stringify(reloaded.anchor) || !reloaded.prior
        || reloaded.prior.sequence_id < prior.sequence_id
        || (reloaded.prior.sequence_id === prior.sequence_id
          && checkpointFingerprint(jsonObjectSchema.parse(reloaded.prior)) !== checkpointFingerprint(jsonObjectSchema.parse(closed.prior)))) fail('PRODUCTIVITY_ENTRY_SOURCE_CHANGED');
      prior = reloaded.prior;
      // One closure cannot grant continuity past another interrupted turn.
      if (prior.status !== 'completed') fail('PRIOR_TURN_RECONCILIATION_REQUIRED', inspectProductivityTurn(prior,context.userId));
    }
    const conversation = recoverProductivityStoredTurn(prior,context.userId);
    await fresh();
    return conversation;
  } };
}
