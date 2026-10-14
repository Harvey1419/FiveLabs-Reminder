import {
  interruptedActiveCompletionEvidenceSchema, activeRunCheckpointSchema, jsonObjectSchema,
  type ActiveTurnCompletion, type InterruptedActiveCompletionEvidence, type TurnContext,
} from '@templelabs/contracts';
import { requireInboundTurnLease } from '../../agent/core/turn-lease.js';
import { inspectRecordedActiveRunRecovery } from './active-run-recovery.js';
import { conversationFromOwnedBaseline } from './owned-baseline.js';
import { buildActiveTurnCompletion } from './active-turn-completion.js';
import { checkpointFingerprint } from './checkpoint-fingerprint.js';
import type { ActiveRunRpcClient } from './active-run-store.js';

function fail(code: string): never { throw Object.assign(new Error(code), { code }); }
const hash = (value: unknown) => checkpointFingerprint(jsonObjectSchema.parse(value));
export interface InterruptedCompletionReport {
  readonly inboundRunId: string;
  readonly sourceFingerprint: string;
  readonly status: 'verifiable' | 'incomplete';
  readonly reason: 'complete_evidence' | 'unfinished_execution' | 'missing_baseline' | 'missing_manifest' | 'delivery_unconfirmed' | 'completion_unverifiable';
  readonly completion: ActiveTurnCompletion | null;
  readonly grantsExecution: false;
  readonly allowsHandoff: false;
}
/** Reconstruction preserves captured input; inspection does not publish or deliver anything. */
export function inspectInterruptedActiveCompletion(raw: unknown, userId: string, threadId: string): InterruptedCompletionReport {
  const evidence = interruptedActiveCompletionEvidenceSchema.parse(raw), { snapshot, baseline, manifest, receipts } = evidence;
  const source = inspectRecordedActiveRunRecovery(snapshot, userId, threadId);
  const report = (reason: InterruptedCompletionReport['reason'], completion: ActiveTurnCompletion | null = null): InterruptedCompletionReport => ({
    inboundRunId: source.inboundRunId, sourceFingerprint: source.sourceFingerprint,
    status: completion ? 'verifiable' : 'incomplete', reason, completion, grantsExecution: false, allowsHandoff: false,
  });
  const checkpoint = activeRunCheckpointSchema.parse(snapshot.prior.response.agentCoreActiveRun);
  if (checkpoint.stage !== 'final' || !['completed', 'cancelled'].includes(String(checkpoint.result.status))) return report('unfinished_execution');
  if (!baseline) return report('missing_baseline');
  const candidate = baseline.candidate;
  if (candidate.userId !== userId || candidate.inboundRunId !== snapshot.prior.id || candidate.requestId !== snapshot.prior.message_id
    || candidate.threadId !== threadId || candidate.sequenceId !== snapshot.prior.sequence_id || candidate.activeRunId !== snapshot.run.id
    || hash(conversationFromOwnedBaseline(candidate)) !== hash(baseline.conversation)) fail('INTERRUPTED_COMPLETION_BASELINE_MISMATCH');
  if (!manifest) return report('missing_manifest');
  if (manifest.entries.some(entry => entry.state !== 'accepted')) return report('delivery_unconfirmed');
  let completion: ActiveTurnCompletion;
  try { completion = buildActiveTurnCompletion(baseline, manifest, receipts); }
  catch { return report('completion_unverifiable'); }
  if (hash(completion.sourceResponse) !== source.sourceFingerprint || completion.baseline.sequenceId !== snapshot.prior.sequence_id) fail('INTERRUPTED_COMPLETION_SOURCE_MISMATCH');
  return report('complete_evidence', completion);
}

/** Oldest unknown only. SQL NULL is unavailable authority; explicit absence never means empty history. */
export function createInterruptedActiveCompletionReader(client: ActiveRunRpcClient, rawOwner: { readonly id: string; readonly token: string }) {
  const owner = { ...rawOwner };
  return { async load(rawContext: TurnContext, threadId: string): Promise<{ evidence: InterruptedActiveCompletionEvidence; report: InterruptedCompletionReport } | null> {
    const context = { ...rawContext, capabilities: new Set(rawContext.capabilities) }, lease = requireInboundTurnLease();
    if (!context.capabilities.has('agent_core.reconcile')) fail('INTERRUPTED_COMPLETION_ACCESS_DENIED');
    if (context.runId !== owner.id || lease.inboundTurn.id !== owner.id || lease.inboundTurn.messageId !== context.requestId
      || lease.inboundTurn.threadId !== threadId) fail('INTERRUPTED_COMPLETION_OWNER_MISMATCH');
    const signal = AbortSignal.any([context.signal, lease.signal, AbortSignal.timeout(15000)]);
    const fresh = async () => { signal.throwIfAborted(); await lease.assertActive(); signal.throwIfAborted(); };
    await fresh();
    let abort: () => void = () => {};
    const cancelled = new Promise<never>((_resolve, reject) => {
      abort = () => reject(signal.reason); signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) abort();
    });
    let result: { readonly data: unknown; readonly error: unknown };
    try { result = await Promise.race([Promise.resolve(client.rpc('read_hermes_interrupted_active_completion', {
      p_owner_id: owner.id, p_owner_token: owner.token, p_user_id: context.userId, p_request_id: context.requestId, p_thread_id: threadId,
    })), cancelled]); }
    catch { signal.throwIfAborted(); fail('INTERRUPTED_COMPLETION_STORAGE_UNCERTAIN'); }
    finally { signal.removeEventListener('abort', abort); }
    await fresh();
    if (result.error) fail('INTERRUPTED_COMPLETION_STORAGE_UNCERTAIN');
    if (result.data === null) fail('INTERRUPTED_COMPLETION_UNAVAILABLE');
    if (JSON.stringify(result.data) === '{"absent":true}') return null;
    const evidence = interruptedActiveCompletionEvidenceSchema.parse(result.data), anchor = evidence.snapshot.anchor;
    if (anchor.id !== owner.id || anchor.message_id !== context.requestId || anchor.thread_id !== threadId) fail('INTERRUPTED_COMPLETION_OWNER_MISMATCH');
    return { evidence: structuredClone(evidence), report: inspectInterruptedActiveCompletion(evidence, context.userId, threadId) };
  } };
}
