import {
  ownedBaselineCandidateSchema, ownedBaselineReceiptSchema, ownedBaselineInputSchema, productivityCheckpointSchema,
  activeRunRecoverySnapshotSchema, activeRunBaselineEvidenceSchema, jsonObjectSchema,
  type OwnedBaselineCandidate, type OwnedBaselineInput, type ProductivityConversation, type TurnContext, type JsonObject,
} from '@templelabs/contracts';
import { requireInboundTurnLease } from '../../agent/core/turn-lease.js';
import { recoverActiveTurnCompletion } from './active-turn-completion.js';
import { recoverActiveRunHandoff } from './active-run-resolution.js';
import { inspectActiveRunRecovery } from './active-run-recovery.js';
import { checkpointFingerprint } from './checkpoint-fingerprint.js';
import type { ActiveRunRpcClient } from './active-run-store.js';
function fail(code: string): never { throw Object.assign(new Error(code), { code }); }
const hash = (value: unknown) => checkpointFingerprint(jsonObjectSchema.parse(value));
/** Reconstruct only from an owned closed checkpoint, or SQL-certified absence of all prior turns. */
export function conversationFromOwnedBaseline(raw: unknown): ProductivityConversation {
  const candidate = ownedBaselineCandidateSchema.parse(raw), prior = candidate.prior;
  let conversation: ProductivityConversation;
  if (!prior) conversation = { userId: candidate.userId, history: [], reminders: [], tasks: [], events: [], handledRequestIds: [] };
  else if (Object.hasOwn(prior.response, 'agentCoreActiveCompletion')) conversation = recoverActiveTurnCompletion(prior, candidate.userId);
  else if (Object.hasOwn(prior.response, 'agentCoreActiveResolution')) conversation = recoverActiveRunHandoff(prior, candidate.userId);
  else {
    if (['agentCore', 'agentCoreResolution', 'agentCoreActiveRun', 'agentCoreDeliveryManifest', 'agentCoreBaseline'].some(key => Object.hasOwn(prior.response, key))) fail('OWNED_BASELINE_ENGINE_MISMATCH');
    const checkpoint = productivityCheckpointSchema.parse(prior.response.agentCoreProductivity);
    if (checkpoint.userId !== candidate.userId || checkpoint.runId !== prior.id || checkpoint.requestId !== prior.message_id
      || checkpoint.phase !== 'completed') fail('OWNED_BASELINE_CHECKPOINT_MISMATCH');
    conversation = checkpoint.completed!.conversation;
  }
  // Also enforces closed transcripts, unique references/handled IDs and no replay of the current request.
  return structuredClone(ownedBaselineReceiptSchema.parse({ version: 1, id: '00000000-0000-4000-8000-000000000001', candidate, conversation }).conversation);
}
export function createOwnedBaseline(client: ActiveRunRpcClient, rawOwner: { readonly id: string; readonly token: string }) {
  const owner = { ...rawOwner };
  const invoke = async (operation: 'candidate' | 'capture' | 'read', payload: JsonObject, context: TurnContext) => {
    const lease = requireInboundTurnLease(), turn = { ...context, capabilities: new Set(context.capabilities) };
    if (!turn.capabilities.has(operation === 'read' ? 'agent_core.reconcile' : 'agent_core.baseline.capture')) fail('OWNED_BASELINE_ACCESS_DENIED');
    if (turn.runId !== owner.id || lease.inboundTurn.id !== owner.id || turn.requestId !== lease.inboundTurn.messageId) fail('OWNED_BASELINE_OWNER_MISMATCH');
    const signal = AbortSignal.any([turn.signal, lease.signal, AbortSignal.timeout(15000)]);
    const fresh = async () => { signal.throwIfAborted(); await lease.assertActive(); signal.throwIfAborted(); };
    await fresh();
    let abort: () => void = () => {};
    const cancelled = new Promise<never>((_resolve, reject) => {
      abort = () => reject(signal.reason); signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) abort();
    });
    let result: { readonly data: unknown; readonly error: unknown };
    try { result = await Promise.race([Promise.resolve(client.rpc('access_hermes_owned_baseline', {
      p_owner_id: owner.id, p_owner_token: owner.token, p_operation: operation, p_payload: structuredClone(payload),
    })), cancelled]); }
    catch { signal.throwIfAborted(); fail('OWNED_BASELINE_STORAGE_UNCERTAIN'); }
    finally { signal.removeEventListener('abort', abort); }
    await fresh();
    if (result.error) fail('OWNED_BASELINE_STORAGE_UNCERTAIN');
    if (result.data === null) fail('OWNED_BASELINE_UNAVAILABLE');
    return result.data;
  };
  const bind = (candidate: OwnedBaselineCandidate, context: TurnContext, inboundId = owner.id, requestId = context.requestId) => {
    if (candidate.userId !== context.userId || candidate.inboundRunId !== inboundId || candidate.requestId !== requestId
      || candidate.threadId !== requireInboundTurnLease().inboundTurn.threadId) fail('OWNED_BASELINE_OWNER_MISMATCH');
  };
  return {
    async capture(activeRunId: string, context: TurnContext, rawInput?: OwnedBaselineInput) {
      const input = rawInput === undefined ? undefined : ownedBaselineInputSchema.parse(structuredClone(rawInput));
      const turn = { ...context, capabilities: new Set(context.capabilities) };
      const candidate = ownedBaselineCandidateSchema.parse(await invoke('candidate', { userId: turn.userId, activeRunId }, turn));
      bind(candidate, turn);
      if (candidate.activeRunId !== activeRunId) fail('OWNED_BASELINE_OWNER_MISMATCH');
      const conversation = conversationFromOwnedBaseline(candidate);
      const receipt = ownedBaselineReceiptSchema.parse(await invoke('capture', {
        userId: turn.userId, activeRunId, candidate: jsonObjectSchema.parse(candidate), candidateFingerprint: hash(candidate),
        conversation: jsonObjectSchema.parse(conversation), ...(input ? { input: jsonObjectSchema.parse(input), inputFingerprint: hash(input) } : {}),
      }, turn));
      if (hash(receipt.candidate) !== hash(candidate) || hash(receipt.conversation) !== hash(conversation)
        || hash({ input: receipt.input ?? null }) !== hash({ input: input ?? null })) fail('OWNED_BASELINE_RECEIPT_MISMATCH');
      return structuredClone(receipt);
    },
    async baseline(raw: unknown, context: TurnContext) {
      const source = activeRunRecoverySnapshotSchema.parse(structuredClone(raw));
      if (source.anchor.id !== owner.id || source.anchor.message_id !== context.requestId || source.run.user_id !== context.userId) fail('OWNED_BASELINE_OWNER_MISMATCH');
      inspectActiveRunRecovery(source, context.userId, requireInboundTurnLease().inboundTurn.threadId);
      const receipt = ownedBaselineReceiptSchema.parse(await invoke('read', { expected: jsonObjectSchema.parse(source) }, context));
      const candidate = receipt.candidate;
      bind(candidate, context, source.prior.id, source.prior.message_id);
      const marker = jsonObjectSchema.parse(source.prior.response.agentCoreBaseline);
      if (candidate.activeRunId !== source.run.id || candidate.sequenceId !== source.prior.sequence_id
        || marker.version !== 1 || marker.baselineId !== receipt.id || marker.candidateFingerprint !== hash(candidate)
        || hash(conversationFromOwnedBaseline(candidate)) !== hash(receipt.conversation)) fail('OWNED_BASELINE_RECEIPT_MISMATCH');
      return activeRunBaselineEvidenceSchema.parse({ userId: context.userId, threadId: candidate.threadId,
        sourceFingerprint: hash(source.prior.response), conversation: receipt.conversation });
    },
  };
}
