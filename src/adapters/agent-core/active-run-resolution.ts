import {
  activeRunRecoverySnapshotSchema, activeRunCheckpointSchema, activeRunEffectEvidenceSchema,
  activeRunDeliveryEvidenceSchema, activeRunBaselineEvidenceSchema, activeRunResolutionSchema,
  productivityConversationSchema, jsonObjectSchema,
  type ActiveRunRecoverySnapshot, type ActiveRunResolution, type ActiveRunEffectEvidence,
  type ProductivityConversation, type JsonObject, type TurnContext,
} from '@templelabs/contracts';
import { requireInboundTurnLease } from '../../agent/core/turn-lease.js';
import { inspectActiveRunRecovery } from './active-run-recovery.js';
import { checkpointFingerprint } from './checkpoint-fingerprint.js';
import type { ActiveRunRpcClient } from './active-run-store.js';
import { inboundStoredTurnSchema } from './inbound-checkpoint-reader.js';

type Action = ActiveRunRecoverySnapshot['actions'][number];
/** Trusted durable audit/provider adapters; current record existence and model text are insufficient. */
export interface ActiveRunResolutionEvidencePort {
  effect(action: Action, source: ActiveRunRecoverySnapshot, context: TurnContext): Promise<unknown>;
  delivery(source: ActiveRunRecoverySnapshot, context: TurnContext): Promise<unknown>;
  baseline(source: ActiveRunRecoverySnapshot, context: TurnContext): Promise<unknown>;
}
export interface ActiveRunResolutionStore {
  close(source: ActiveRunRecoverySnapshot, resolution: ActiveRunResolution): Promise<boolean>;
}
function fail(code: string): never { throw Object.assign(new Error(code), { code }); }
function hash(value: unknown) { return checkpointFingerprint(jsonObjectSchema.parse(value)); }
function merge(baseline: ProductivityConversation, effects: ActiveRunEffectEvidence[], requestId: string): ProductivityConversation {
  const reminders = new Map(baseline.reminders.map(record => [record.id, record]));
  const tasks = new Map(baseline.tasks.map(record => [record.id, record]));
  const events = new Map(baseline.events.map(record => [record.id, record]));
  const received = new Map<string, string>();
  for (const { item } of effects) {
    if (item && item.domain !== 'agenda' && (item.domain === 'calendar' || item.domain === 'reminders' || item.domain === 'tasks')) {
      for (const record of item.domain === 'calendar' ? item.result!.events : item.result!.records) {
        const key = `${item.domain}:${record.id}`, fingerprint = hash(record);
        if (received.has(key) && received.get(key) !== fingerprint) fail('ACTIVE_RUN_RESOLUTION_REFERENCE_CONFLICT');
        received.set(key, fingerprint);
      }
    }
    if (item?.domain === 'reminders') for (const record of item.result!.records) reminders.set(record.id, record);
    if (item?.domain === 'tasks') for (const record of item.result!.records) tasks.set(record.id, record);
    if (item?.domain === 'calendar') for (const event of item.result!.events) events.set(event.id, event);
  }
  // A full ledger/reference set requires explicit compaction; silently trimming would lose continuity.
  return productivityConversationSchema.parse({ ...baseline, reminders: [...reminders.values()], tasks: [...tasks.values()], events: [...events.values()],
    handledRequestIds: baseline.handledRequestIds.includes(requestId) ? baseline.handledRequestIds : [...baseline.handledRequestIds, requestId] });
}
function verifyEffects(source: ActiveRunRecoverySnapshot, effects: ActiveRunEffectEvidence[]) {
  const report = inspectActiveRunRecovery(source, source.run.user_id, source.run.thread_id);
  if (report.pendingCallIds.length) fail('ACTIVE_RUN_RESOLUTION_PENDING_ACTIONS');
  if (source.actions.some(action => !['task', 'reminder', 'calendar'].includes(action.domain))) fail('ACTIVE_RUN_RESOLUTION_UNSUPPORTED_DOMAIN');
  if (effects.length !== report.verificationCallIds.length || effects.some(proof => !report.verificationCallIds.includes(proof.callId))) fail('ACTIVE_RUN_RESOLUTION_MISSING_EVIDENCE');
  for (const proof of effects) verifyActiveRunEffectEvidence(source, proof);
}
export function verifyActiveRunEffectEvidence(source: ActiveRunRecoverySnapshot, raw: unknown): ActiveRunEffectEvidence {
    const proof = activeRunEffectEvidenceSchema.parse(raw);
    const action = source.actions.find(action => action.callId === proof.callId)!;
    if (!action) fail('ACTIVE_RUN_RESOLUTION_EVIDENCE_MISMATCH');
    if (!['task', 'reminder', 'calendar'].includes(action.domain)) fail('ACTIVE_RUN_RESOLUTION_UNSUPPORTED_DOMAIN');
    if (proof.userId !== source.run.user_id || proof.activeRunId !== source.run.id || proof.actionFingerprint !== hash(action)) fail('ACTIVE_RUN_RESOLUTION_EVIDENCE_MISMATCH');
    const item = proof.item;
    if (!item) return proof;
    const domain = action.domain === 'task' ? 'tasks' : action.domain === 'reminder' ? 'reminders' : 'calendar';
    if (item.domain !== domain || item.result!.operation !== action.action || item.result!.coverage !== 'operation') fail('ACTIVE_RUN_RESOLUTION_OPERATION_MISMATCH');
    if (item.domain === 'calendar' && item.result!.companion === 'unconfirmed'
      || 'issues' in item.result! && item.result!.issues.some(issue => issue.code === 'COMPANION_OUTCOME_UNVERIFIED')) fail('ACTIVE_RUN_RESOLUTION_COMPANION_UNKNOWN');
    const records = item.domain === 'calendar' ? item.result!.events : item.result!.records;
    if (!records.length || action.targetId !== null && !records.some(record => record.id === action.targetId)) fail('ACTIVE_RUN_RESOLUTION_TARGET_MISMATCH');
    if (action.action !== 'create' && !action.targetId) fail('ACTIVE_RUN_RESOLUTION_TARGET_REQUIRED');
    return proof;
}
function terminal(source: ActiveRunRecoverySnapshot, effects: ActiveRunEffectEvidence[]): ActiveRunResolution['runStatus'] {
  return source.run.status === 'cancelled' ? 'cancelled' : effects.some(proof => proof.outcome === 'no_effect') ? 'failed' : 'completed';
}
/** Semantic revalidation also runs when mixed-engine recovery imports a persisted handoff. */
export function validateActiveRunResolution(raw: unknown): ActiveRunResolution {
  const resolution = activeRunResolutionSchema.parse(raw), source = resolution.source;
  const checkpoint = activeRunCheckpointSchema.parse(source.prior.response.agentCoreActiveRun);
  if (resolution.userId !== source.run.user_id || resolution.runId !== source.prior.id || resolution.requestId !== source.prior.message_id
    || resolution.threadId !== source.run.thread_id || resolution.activeRunId !== source.run.id || resolution.claimId !== checkpoint.claimId
    || resolution.sourceFingerprint !== hash(source.prior.response) || resolution.snapshotFingerprint !== hash(source)) fail('ACTIVE_RUN_RESOLUTION_SOURCE_MISMATCH');
  verifyEffects(source, resolution.effects);
  if (resolution.runStatus !== terminal(source, resolution.effects)
    || hash(resolution.conversation) !== hash(merge(resolution.baseline, resolution.effects, resolution.requestId))) fail('ACTIVE_RUN_RESOLUTION_CONVERSATION_MISMATCH');
  return resolution;
}
export function recoverActiveRunHandoff(raw: unknown, userId: string): ProductivityConversation {
  const row = inboundStoredTurnSchema.parse(raw);
  if (row.status !== 'completed' || !row.response || ['agentCore', 'agentCoreProductivity', 'agentCoreResolution'].some(key => Object.hasOwn(row.response!, key))) fail('ACTIVE_RUN_HANDOFF_ENGINE_MISMATCH');
  const resolution = validateActiveRunResolution(row.response.agentCoreActiveResolution);
  const original = { ...row.response }; delete original.agentCoreActiveResolution;
  if (resolution.userId !== userId || resolution.runId !== row.id || resolution.requestId !== row.message_id
    || resolution.threadId !== row.thread_id || resolution.source.prior.sequence_id !== row.sequence_id
    || hash(original) !== resolution.sourceFingerprint) fail('ACTIVE_RUN_HANDOFF_SOURCE_MISMATCH');
  return structuredClone(resolution.conversation);
}
/** No dispatch or sender port is present: this operation can only certify and close historical work. */
export async function reconcileActiveRun(raw: unknown, context: TurnContext, evidence: ActiveRunResolutionEvidencePort, store: ActiveRunResolutionStore) {
  const source = activeRunRecoverySnapshotSchema.parse(structuredClone(raw));
  const lease = requireInboundTurnLease(), turn = { ...context, capabilities: new Set(context.capabilities) };
  const signal = AbortSignal.any([turn.signal, lease.signal, AbortSignal.timeout(15000)]);
  if (!turn.capabilities.has('agent_core.reconcile') || !turn.capabilities.has('agent_core.handoff')) fail('ACTIVE_RUN_RESOLUTION_ACCESS_DENIED');
  if (source.anchor.id !== turn.runId || source.anchor.message_id !== turn.requestId || source.anchor.thread_id !== lease.inboundTurn.threadId
    || lease.inboundTurn.id !== turn.runId || lease.inboundTurn.messageId !== turn.requestId || source.run.user_id !== turn.userId) fail('ACTIVE_RUN_RESOLUTION_OWNER_MISMATCH');
  const fresh = async () => { signal.throwIfAborted(); await lease.assertActive(); signal.throwIfAborted(); };
  const bounded = async <T>(work: () => Promise<T>): Promise<T> => {
    signal.throwIfAborted();
    let abort: () => void = () => {};
    const cancelled = new Promise<never>((_resolve, reject) => {
      abort = () => reject(signal.reason); signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
    });
    try { return await Promise.race([work(), cancelled]); }
    finally { signal.removeEventListener('abort', abort); }
  };
  await fresh();
  const report = inspectActiveRunRecovery(source, turn.userId, lease.inboundTurn.threadId);
  if (report.pendingCallIds.length) fail('ACTIVE_RUN_RESOLUTION_PENDING_ACTIONS');
  const effects: ActiveRunEffectEvidence[] = [];
  for (const callId of report.verificationCallIds) {
    await fresh();
    const action = source.actions.find(action => action.callId === callId)!;
    effects.push(activeRunEffectEvidenceSchema.parse(await bounded(() => evidence.effect(structuredClone(action), structuredClone(source), turn))));
  }
  verifyEffects(source, effects);
  await fresh();
  const delivery = activeRunDeliveryEvidenceSchema.parse(await bounded(() => evidence.delivery(structuredClone(source), turn)));
  await fresh();
  const base = activeRunBaselineEvidenceSchema.parse(await bounded(() => evidence.baseline(structuredClone(source), turn)));
  if (base.userId !== turn.userId || base.threadId !== source.run.thread_id || base.sourceFingerprint !== report.sourceFingerprint) fail('ACTIVE_RUN_RESOLUTION_BASELINE_MISMATCH');
  const checkpoint = activeRunCheckpointSchema.parse(source.prior.response.agentCoreActiveRun);
  const resolution = validateActiveRunResolution({ version: 1, kind: 'active_run_handoff', grantsExecution: false,
    userId: turn.userId, runId: source.prior.id, requestId: source.prior.message_id, threadId: source.run.thread_id,
    activeRunId: source.run.id, claimId: checkpoint.claimId, sourceFingerprint: report.sourceFingerprint,
    snapshotFingerprint: hash(source), decidedAtIso: turn.referenceTimeIso, runStatus: terminal(source, effects), source,
    baseline: base.conversation, conversation: merge(base.conversation, effects, source.prior.message_id), effects, delivery });
  await fresh();
  if (!await bounded(() => store.close(structuredClone(source), structuredClone(resolution)))) fail('ACTIVE_RUN_RESOLUTION_CONFLICT');
  await fresh();
  return structuredClone(resolution.conversation);
}
export function createActiveRunResolutionStore(client: ActiveRunRpcClient, owner: { readonly id: string; readonly token: string }): ActiveRunResolutionStore {
  const id = owner.id, token = owner.token;
  return { async close(source, raw) {
    const resolution = validateActiveRunResolution(raw);
    if (hash(source) !== resolution.snapshotFingerprint || source.anchor.id !== id) fail('ACTIVE_RUN_RESOLUTION_SOURCE_MISMATCH');
    let result: { readonly data: unknown; readonly error: unknown };
    try { result = await client.rpc('resolve_hermes_active_run', { p_owner_id: id, p_owner_token: token,
      p_expected: jsonObjectSchema.parse(source), p_resolution: jsonObjectSchema.parse(resolution) }); }
    catch { fail('ACTIVE_RUN_RESOLUTION_STORAGE_ERROR'); }
    if (result.error) fail('ACTIVE_RUN_RESOLUTION_STORAGE_ERROR');
    if (typeof result.data !== 'boolean') fail('ACTIVE_RUN_RESOLUTION_STORAGE_ERROR');
    return result.data;
  } };
}
