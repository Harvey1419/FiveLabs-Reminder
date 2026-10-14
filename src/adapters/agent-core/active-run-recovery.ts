import {
  activeRunCheckpointSchema, activeRunRecoverySnapshotSchema, jsonObjectSchema,
  type ActiveRunRecoverySnapshot, type JsonObject, type TurnContext,
} from '@templelabs/contracts';
import { requireInboundTurnLease } from '../../agent/core/turn-lease.js';
import { checkpointFingerprint } from './checkpoint-fingerprint.js';
import type { ActiveRunRpcClient } from './active-run-store.js';

export interface ActiveRunRecoveryReport {
  readonly runId: string;
  readonly inboundRunId: string;
  readonly stage: 'claimed' | 'final';
  readonly sourceFingerprint: string;
  readonly pendingCallIds: readonly string[];
  readonly skippedCallIds: readonly string[];
  readonly verificationCallIds: readonly string[];
  readonly unknownCallIds: readonly string[];
  readonly requiresDeliveryVerification: true;
  readonly grantsExecution: false;
  readonly allowsHandoff: false;
}
function fail(code: string): never { throw Object.assign(new Error(code), { code }); }
function same(a: unknown, b: unknown) {
  if (a === undefined || b === undefined) return a === b;
  return checkpointFingerprint(jsonObjectSchema.parse({ value: a })) === checkpointFingerprint(jsonObjectSchema.parse({ value: b }));
}
function instantMicros(value: string): bigint {
  const millis = Date.parse(value);
  const fraction = value.match(/\.(\d+)(?:Z|[+-]\d\d:\d\d)$/)?.[1] ?? '';
  if (!Number.isFinite(millis) || /[1-9]/.test(fraction.slice(6))) fail('ACTIVE_RUN_RECOVERY_STATE_MISMATCH');
  return BigInt(millis) * 1000n + BigInt(fraction.padEnd(6, '0').slice(3, 6));
}
/** Inspection never certifies external effects from a legacy result or model-written card. */
export function inspectActiveRunRecovery(raw: unknown, userId: string, threadId: string): ActiveRunRecoveryReport {
  return inspectSource(raw, userId, threadId, false);
}
/** Recorded-input sources require the dedicated completion path; this still grants no handoff. */
export function inspectRecordedActiveRunRecovery(raw: unknown, userId: string, threadId: string): ActiveRunRecoveryReport {
  return inspectSource(raw, userId, threadId, true);
}
function inspectSource(raw: unknown, userId: string, threadId: string, recordedInput: boolean): ActiveRunRecoveryReport {
  const state = activeRunRecoverySnapshotSchema.parse(raw), row = state.prior;
  if (row.id === state.anchor.id || row.thread_id !== state.anchor.thread_id
    || row.sequence_id >= state.anchor.sequence_id) fail('ACTIVE_RUN_RECOVERY_ORDER_MISMATCH');
  if (['agentCore', 'agentCoreProductivity', 'agentCoreResolution', 'agentCoreActiveResolution','agentCoreActiveCompletion'].some(key => Object.hasOwn(row.response, key))) fail('ACTIVE_RUN_RECOVERY_ENGINE_MISMATCH');
  const baselineMarker = jsonObjectSchema.safeParse(row.response.agentCoreBaseline).data;
  if (!recordedInput && baselineMarker?.inputRecorded === true) fail('ACTIVE_RUN_RECOVERY_COMPLETION_REQUIRED');
  if (recordedInput && (baselineMarker?.inputRecorded !== true || baselineMarker.version !== 1 || row.status !== 'unknown')) fail('ACTIVE_RUN_RECOVERY_INPUT_REQUIRED');
  const checkpoint = activeRunCheckpointSchema.parse(row.response.agentCoreActiveRun);
  if (checkpoint.userId !== userId || state.run.user_id !== userId || checkpoint.runId !== state.run.id
    || checkpoint.inboundRunId !== row.id || checkpoint.requestId !== row.message_id
    || row.thread_id !== threadId || state.run.thread_id !== threadId || checkpoint.snapshot.threadId !== threadId) fail('ACTIVE_RUN_RECOVERY_OWNER_MISMATCH');
  const source = checkpoint.snapshot, marker = state.run.context._agentCoreClaim;
  if (recordedInput && !same(state.run.waiting_for, source.executionState!.waitingFor)) fail('ACTIVE_RUN_RECOVERY_STATE_MISMATCH');
  const context = { ...state.run.context }; delete context._agentCoreClaim;
  if (state.run.kind !== source.executionState!.kind || !same(context, source.executionState!.context)
    || instantMicros(state.run.expires_at) !== instantMicros(source.expiresAtIso)) fail('ACTIVE_RUN_RECOVERY_STATE_MISMATCH');
  if (checkpoint.stage === 'claimed') {
    if (!same(marker, { claimId: checkpoint.claimId, ownerId: row.id, source })) fail('ACTIVE_RUN_RECOVERY_CLAIM_MISMATCH');
  } else if (Object.hasOwn(state.run.context, '_agentCoreClaim') || state.run.status !== checkpoint.result.status) fail('ACTIVE_RUN_RECOVERY_CLAIM_MISMATCH');
  if (state.actions.length !== source.actions.length || new Set(state.actions.map(action => action.callId)).size !== state.actions.length) fail('ACTIVE_RUN_RECOVERY_ACTION_MISMATCH');
  const pending: string[] = [], skipped: string[] = [], verification: string[] = [], unknown: string[] = [];
  for (const original of source.actions) {
    const stored = state.actions.find(action => action.callId === original.callId);
    const receipt = checkpoint.actions?.[original.callId];
    const expected = receipt ? { callId: receipt.call_id, domain: receipt.domain, action: receipt.action,
      targetId: receipt.target_id, targetName: receipt.target_name, payload: receipt.payload,
      status: receipt.status, executionFact: receipt.execution_fact } : original;
    if (!stored || !same(stored, expected)) fail('ACTIVE_RUN_RECOVERY_ACTION_MISMATCH');
    if (stored.status === 'prepared') pending.push(stored.callId);
    if (stored.status === 'skipped') skipped.push(stored.callId);
    if (stored.status === 'executed' || stored.status === 'failed' || stored.executionFact !== null) verification.push(stored.callId);
    if (stored.executionFact?.outcome === 'unknown') unknown.push(stored.callId);
  }
  return { runId: state.run.id, inboundRunId: row.id, stage: checkpoint.stage,
    sourceFingerprint: checkpointFingerprint(row.response), pendingCallIds: pending, skippedCallIds: skipped,
    verificationCallIds: verification, unknownCallIds: unknown,
    requiresDeliveryVerification: true, grantsExecution: false, allowsHandoff: false };
}

export interface ActiveRunRecoveryReader {
  load(context: TurnContext, threadId: string): Promise<{ snapshot: ActiveRunRecoverySnapshot; report: ActiveRunRecoveryReport } | null>;
}
/** The RPC chooses the oldest unknown before the latest completed turn and reads under owned locks. */
export function createActiveRunRecoveryReader(client: ActiveRunRpcClient,
  owner: { readonly id: string; readonly token: string }): ActiveRunRecoveryReader {
  const ownerId = owner.id, ownerToken = owner.token;
  return { async load(context, threadId) {
    const lease = requireInboundTurnLease();
    const turn = { ...context, capabilities: new Set(context.capabilities) };
    if (!turn.capabilities.has('agent_core.reconcile')) fail('ACTIVE_RUN_RECOVERY_ACCESS_DENIED');
    if (turn.runId !== ownerId || lease.inboundTurn.id !== ownerId || lease.inboundTurn.messageId !== turn.requestId
      || lease.inboundTurn.threadId !== threadId) fail('ACTIVE_RUN_RECOVERY_OWNER_MISMATCH');
    const fresh = async () => { turn.signal.throwIfAborted(); lease.signal.throwIfAborted(); await lease.assertActive();
      turn.signal.throwIfAborted(); lease.signal.throwIfAborted(); };
    await fresh();
    const args: JsonObject = { p_owner_id: ownerId, p_owner_token: ownerToken, p_user_id: turn.userId,
      p_request_id: turn.requestId, p_thread_id: threadId };
    const signal = AbortSignal.any([turn.signal, lease.signal, AbortSignal.timeout(15000)]);
    let abort: () => void = () => {};
    const cancelled = new Promise<never>((_resolve, reject) => {
      abort = () => reject(signal.reason);
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
    });
    let result: { readonly data: unknown; readonly error: unknown };
    try {
      result = await Promise.race([Promise.resolve(client.rpc('read_hermes_active_run_recovery', args)), cancelled]);
    } catch {
      signal.throwIfAborted(); fail('ACTIVE_RUN_RECOVERY_STORAGE_ERROR');
    } finally { signal.removeEventListener('abort', abort); }
    const { data, error } = result;
    await fresh();
    signal.throwIfAborted();
    if (error) fail('ACTIVE_RUN_RECOVERY_STORAGE_ERROR');
    // SQL NULL covers a foreign checkpoint, changed evidence or unavailable owner; never treat it as an empty conversation.
    if (data === null) fail('ACTIVE_RUN_RECOVERY_UNAVAILABLE');
    if (same(data, { absent: true })) return null;
    const snapshot = activeRunRecoverySnapshotSchema.parse(data);
    if (snapshot.anchor.id !== turn.runId || snapshot.anchor.message_id !== turn.requestId
      || snapshot.anchor.thread_id !== threadId || snapshot.prior.id === turn.runId) fail('ACTIVE_RUN_RECOVERY_OWNER_MISMATCH');
    const report = inspectActiveRunRecovery(snapshot, turn.userId, threadId);
    return { snapshot: structuredClone(snapshot), report };
  } };
}
