import {
  atomicTaskCallSchema, atomicTaskReceiptSchema, activeRunRecoverySnapshotSchema, jsonObjectSchema,
  type TurnContext, type ActiveRunRecoverySnapshot, type JsonObject, type AtomicTaskReceipt,
} from '@templelabs/contracts';
import { requireInboundTurnLease } from '../../agent/core/turn-lease.js';
import type { LegacyDomainExecutionCall } from '../../agent/core/agent-run.js';
import type { ActiveRunRpcClient } from './active-run-store.js';
import { checkpointFingerprint } from './checkpoint-fingerprint.js';
import { inspectActiveRunRecovery } from './active-run-recovery.js';
import { verifyActiveRunEffectEvidence } from './active-run-resolution.js';

function fail(code: string): never { throw Object.assign(new Error(code), { code }); }
const hash = (value: unknown) => checkpointFingerprint(jsonObjectSchema.parse(value));
async function invoke(client: ActiveRunRpcClient, owner: { id: string; token: string }, context: TurnContext,
  name: string, args: JsonObject, capability: string) {
  const lease = requireInboundTurnLease(), turn = { ...context, capabilities: new Set(context.capabilities) };
  if (!turn.capabilities.has(capability)) fail('ATOMIC_TASK_ACCESS_DENIED');
  if (lease.inboundTurn.id !== owner.id || turn.runId !== owner.id || turn.requestId !== lease.inboundTurn.messageId) fail('ATOMIC_TASK_OWNER_MISMATCH');
  const signal = AbortSignal.any([turn.signal, lease.signal, AbortSignal.timeout(15000)]);
  const fresh = async () => { signal.throwIfAborted(); await lease.assertActive(); signal.throwIfAborted(); };
  await fresh();
  let abort: () => void = () => {};
  const cancelled = new Promise<never>((_resolve, reject) => { abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) abort(); });
  let result: { readonly data: unknown; readonly error: unknown };
  try { result = await Promise.race([Promise.resolve(client.rpc(name, { ...args, p_owner_id: owner.id, p_owner_token: owner.token })), cancelled]); }
  catch { signal.throwIfAborted(); fail('ATOMIC_TASK_STORAGE_UNCERTAIN'); }
  finally { signal.removeEventListener('abort', abort); }
  await fresh();
  if (result.error) fail('ATOMIC_TASK_STORAGE_UNCERTAIN');
  if (result.data === null) fail('ATOMIC_TASK_NOT_ADMITTED');
  return result.data;
}
/** Inject into the owned bridge. Exact single-task mutations only; no legacy fallback. */
export function createAtomicTaskExecutor(client: ActiveRunRpcClient, rawOwner: { readonly id: string; readonly token: string },
  context: TurnContext, authorize: (call: LegacyDomainExecutionCall) => boolean | Promise<boolean>,
  onReceipt?: (receipt: AtomicTaskReceipt) => void) {
  const owner = { id: rawOwner.id, token: rawOwner.token }, turn = { ...context, capabilities: new Set(context.capabilities) };
  return async (raw: LegacyDomainExecutionCall): Promise<JsonObject> => {
    const call = structuredClone(raw);
    const domainCall = atomicTaskCallSchema.parse({ toolName: call.toolName, params: call.params });
    if (call.user?.id !== turn.userId) fail('ATOMIC_TASK_OWNER_MISMATCH');
    const lease = requireInboundTurnLease(); turn.signal.throwIfAborted(); lease.signal.throwIfAborted(); await lease.assertActive();
    if (!turn.capabilities.has('agent_core.atomic_tasks') || !await authorize(structuredClone(call))) fail('ATOMIC_TASK_ACCESS_DENIED');
    const receipt = atomicTaskReceiptSchema.parse(await invoke(client, owner, turn, 'execute_hermes_atomic_task',
      { p_user_id: turn.userId, p_call: jsonObjectSchema.parse(domainCall) }, 'agent_core.atomic_tasks'));
    if (receipt.userId !== turn.userId || receipt.inboundRunId !== owner.id || receipt.threadId !== lease.inboundTurn.threadId
      || hash(receipt.domainCall) !== hash(domainCall)) fail('ATOMIC_TASK_RECEIPT_MISMATCH');
    onReceipt?.(structuredClone(receipt));
    return structuredClone(receipt.legacyResult);
  };
}
/** Missing receipts remain uncertain; only a transaction-linked receipt proves an applied operation. */
export function createAtomicTaskEffectSource(client: ActiveRunRpcClient, rawOwner: { readonly id: string; readonly token: string }) {
  const owner = { id: rawOwner.id, token: rawOwner.token };
  return async (action: ActiveRunRecoverySnapshot['actions'][number], raw: ActiveRunRecoverySnapshot, context: TurnContext) => {
    const source = activeRunRecoverySnapshotSchema.parse(structuredClone(raw));
    if (source.anchor.id !== owner.id || source.anchor.message_id !== context.requestId || source.run.user_id !== context.userId) fail('ATOMIC_TASK_OWNER_MISMATCH');
    inspectActiveRunRecovery(source, context.userId, requireInboundTurnLease().inboundTurn.threadId);
    const stored = source.actions.find(current => current.callId === action.callId);
    if (!stored || hash(stored) !== hash(action) || stored.domain !== 'task') fail('ATOMIC_TASK_RECEIPT_MISMATCH');
    const call = atomicTaskCallSchema.parse(stored.executionFact?._domainCall);
    const receipt = atomicTaskReceiptSchema.parse(await invoke(client, owner, context, 'read_hermes_atomic_task_receipt',
      { p_expected: jsonObjectSchema.parse(source), p_call_id: stored.callId }, 'agent_core.reconcile'));
    if (receipt.userId !== context.userId || receipt.activeRunId !== source.run.id || receipt.threadId !== source.run.thread_id
      || receipt.callId !== stored.callId || receipt.targetId !== stored.targetId || hash(receipt.domainCall) !== hash(call)) fail('ATOMIC_TASK_RECEIPT_MISMATCH');
    return verifyActiveRunEffectEvidence(source, { userId: context.userId, activeRunId: source.run.id, callId: stored.callId,
      actionFingerprint: hash(stored), evidenceId: receipt.receiptId, outcome: 'applied', coversCompanions: true, item: receipt.item });
  };
}
