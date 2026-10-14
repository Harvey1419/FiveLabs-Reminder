import {
  verifiedActiveRunEvidenceSchema, activeRunRecoverySnapshotSchema, aiTranscriptSchema, jsonObjectSchema,
  type VerifiedActiveRunEvidence, type ActiveRunRecoverySnapshot, type TurnContext,
} from '@templelabs/contracts';
import { requireInboundTurnLease } from '../../agent/core/turn-lease.js';
import { inspectActiveRunRecovery } from './active-run-recovery.js';
import { verifyActiveRunEffectEvidence, type ActiveRunResolutionEvidencePort } from './active-run-resolution.js';
import { checkpointFingerprint } from './checkpoint-fingerprint.js';
import type { ActiveRunRpcClient } from './active-run-store.js';

function fail(code: string): never { throw Object.assign(new Error(code), { code }); }
function hash(value: unknown) { return checkpointFingerprint(jsonObjectSchema.parse(value)); }
function validate(raw: unknown, source: ActiveRunRecoverySnapshot): VerifiedActiveRunEvidence {
  const receipt = verifiedActiveRunEvidenceSchema.parse(raw);
  const report = inspectActiveRunRecovery(source, source.run.user_id, source.run.thread_id);
  if (receipt.userId !== source.run.user_id || receipt.activeRunId !== source.run.id || receipt.inboundRunId !== source.prior.id
    || receipt.threadId !== source.run.thread_id || receipt.sourceFingerprint !== report.sourceFingerprint
    || receipt.proof.userId !== receipt.userId) fail('ACTIVE_RUN_EVIDENCE_BINDING_MISMATCH');
  let key: string;
  if (receipt.kind === 'effect') {
    if (!report.verificationCallIds.includes(receipt.proof.callId)) fail('ACTIVE_RUN_EVIDENCE_ACTION_NOT_DISPATCHED');
    verifyActiveRunEffectEvidence(source, receipt.proof);
    key = `${receipt.proof.callId}:${receipt.proof.actionFingerprint}`;
  } else {
    key = `${source.prior.id}:${report.sourceFingerprint}`;
    if (receipt.proof.sourceFingerprint !== report.sourceFingerprint) fail('ACTIVE_RUN_EVIDENCE_BINDING_MISMATCH');
    if (receipt.kind === 'delivery' && receipt.proof.inboundRunId !== source.prior.id) fail('ACTIVE_RUN_EVIDENCE_BINDING_MISMATCH');
    if (receipt.kind === 'baseline') {
      const state = receipt.proof.conversation;
      if (receipt.proof.threadId !== source.run.thread_id || state.userId !== receipt.userId
        || state.history.some(message => message.role === 'system') || state.history.length && !aiTranscriptSchema.safeParse(state.history).success
        || new Set(state.handledRequestIds).size !== state.handledRequestIds.length
        || [state.tasks, state.reminders, state.events].some(records => new Set(records.map(record => record.id)).size !== records.length)) fail('ACTIVE_RUN_EVIDENCE_BASELINE_INVALID');
    }
  }
  if (receipt.evidenceKey !== key) fail('ACTIVE_RUN_EVIDENCE_BINDING_MISMATCH');
  return receipt;
}
export interface ActiveRunEvidenceRegistry {
  register(receipt: VerifiedActiveRunEvidence, source: ActiveRunRecoverySnapshot, context: TurnContext): Promise<void>;
  readonly evidence: ActiveRunResolutionEvidencePort;
}
/** Durable receipts only; missing records never mean no effect/no send or an empty history. */
export function createActiveRunEvidenceRegistry(client: ActiveRunRpcClient,
  owner: { readonly id: string; readonly token: string }): ActiveRunEvidenceRegistry {
  const id = owner.id, token = owner.token;
  const invoke = async (raw: ActiveRunRecoverySnapshot, context: TurnContext, operation: 'read' | 'register', payload: unknown) => {
    const source = activeRunRecoverySnapshotSchema.parse(structuredClone(raw));
    const lease = requireInboundTurnLease(), turn = { ...context, capabilities: new Set(context.capabilities) };
    if (!turn.capabilities.has(operation === 'register' ? 'agent_core.evidence.register' : 'agent_core.reconcile')) fail('ACTIVE_RUN_EVIDENCE_ACCESS_DENIED');
    if (turn.userId !== source.run.user_id || turn.runId !== id || source.anchor.id !== id || source.anchor.message_id !== turn.requestId
      || lease.inboundTurn.id !== id || lease.inboundTurn.messageId !== turn.requestId || lease.inboundTurn.threadId !== source.run.thread_id) fail('ACTIVE_RUN_EVIDENCE_OWNER_MISMATCH');
    inspectActiveRunRecovery(source, turn.userId, lease.inboundTurn.threadId);
    const signal = AbortSignal.any([turn.signal, lease.signal, AbortSignal.timeout(15000)]);
    const fresh = async () => { signal.throwIfAborted(); await lease.assertActive(); signal.throwIfAborted(); };
    await fresh();
    const data = jsonObjectSchema.parse(structuredClone(payload));
    let abort: () => void = () => {};
    const cancelled = new Promise<never>((_resolve, reject) => {
      abort = () => reject(signal.reason); signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) abort();
    });
    let result: { readonly data: unknown; readonly error: unknown };
    try { result = await Promise.race([Promise.resolve(client.rpc('access_hermes_active_evidence', {
      p_owner_id: id, p_owner_token: token, p_expected: jsonObjectSchema.parse(source), p_operation: operation, p_payload: data,
    })), cancelled]); }
    catch { signal.throwIfAborted(); fail('ACTIVE_RUN_EVIDENCE_STORAGE_ERROR'); }
    finally { signal.removeEventListener('abort', abort); }
    await fresh();
    if (result.error) fail('ACTIVE_RUN_EVIDENCE_STORAGE_ERROR');
    if (result.data === null) fail('ACTIVE_RUN_EVIDENCE_UNAVAILABLE');
    return { raw: result.data, source };
  };
  const read = async (source: ActiveRunRecoverySnapshot, context: TurnContext, kind: VerifiedActiveRunEvidence['kind'], key: string) => {
    const result = await invoke(source, context, 'read', { kind, evidenceKey: key, sourceFingerprint: hash(source.prior.response) });
    const receipt = validate(result.raw, result.source);
    if (receipt.kind !== kind || receipt.evidenceKey !== key) fail('ACTIVE_RUN_EVIDENCE_BINDING_MISMATCH');
    return structuredClone(receipt.proof);
  };
  return {
    async register(raw, source, context) {
      const snapshot = activeRunRecoverySnapshotSchema.parse(structuredClone(source));
      const receipt = validate(structuredClone(raw), snapshot);
      const result = await invoke(snapshot, context, 'register', receipt);
      if (hash(validate(result.raw, result.source)) !== hash(receipt)) fail('ACTIVE_RUN_EVIDENCE_CONFLICT');
    },
    evidence: {
      effect: async (action, source, context) => {
        const current = source.actions.find(stored => stored.callId === action.callId);
        if (!current || hash(current) !== hash(action)) fail('ACTIVE_RUN_EVIDENCE_BINDING_MISMATCH');
        return read(source, context, 'effect', `${action.callId}:${hash(action)}`);
      },
      delivery: (source, context) => read(source, context, 'delivery', `${source.prior.id}:${hash(source.prior.response)}`),
      baseline: (source, context) => read(source, context, 'baseline', `${source.prior.id}:${hash(source.prior.response)}`),
    },
  };
}
