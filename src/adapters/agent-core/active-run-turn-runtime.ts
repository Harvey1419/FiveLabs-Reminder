import {
  approvalDecisionSchema, ownedBaselineInputSchema, atomicTaskCallSchema, activeRunCheckpointSchema, jsonObjectSchema,
  suspendedRunSnapshotSchema, type SuspendedRunSnapshot, type ApprovalDecision,
  type AtomicTaskReceipt, type JsonObject, type ProductivityDelivery, type TurnContext,
} from '@templelabs/contracts';
import { requireInboundTurnLease } from '../../agent/core/turn-lease.js';
import { WhatsAppProductivityPresenter } from '../../presentation/whatsapp-productivity-presenter.js';
import { ActiveRunExecutionBridge, type ActiveRunExecutionContext } from './active-run-execution.js';
import { createActiveRunStore, type ActiveRunStore } from './active-run-store.js';
import type { ActiveRunRpcClient } from './active-run-store.js';
import type { ActiveRunDecisionResult } from './active-run-ai-decision.js';
import { createAtomicTaskExecutor } from './atomic-task-executor.js';
import { createActiveTurnFinalizer } from './active-turn-completion.js';
import { createOwnedBaseline } from './owned-baseline.js';
import { createDeliveryManifest, type ManifestDeliveryTransport } from './delivery-manifest.js';
import { checkpointFingerprint } from './checkpoint-fingerprint.js';

function fail(code: string): never { throw Object.assign(new Error(code), { code }); }
const json = (value: unknown) => jsonObjectSchema.parse(value);
const hash = (value: unknown) => checkpointFingerprint(json(value));
/** One owned approval turn. Unsupported domains/continuations require a separately admitted runtime. */
export function createActiveRunTurnRuntime(client: ActiveRunRpcClient,
  rawOwner: { readonly id: string; readonly token: string }, transport: ManifestDeliveryTransport) {
  const owner = { ...rawOwner };
  let attempted = false;
  return {
    async apply(rawSnapshot: SuspendedRunSnapshot, rawDecision: ActiveRunDecisionResult<ApprovalDecision>,
      rawContext: ActiveRunExecutionContext,
      authorizeDelivery: (message: ProductivityDelivery, context: TurnContext) => boolean | Promise<boolean>) {
      const snapshot = suspendedRunSnapshotSchema.parse(structuredClone(rawSnapshot));
      const planned = structuredClone(rawDecision), lease = requireInboundTurnLease();
      const context = { ...rawContext, user: structuredClone(rawContext.user),
        turn: { ...rawContext.turn, capabilities: new Set(rawContext.turn.capabilities) } };
      const turn = context.turn, binding = planned.binding;
      if (attempted) fail('ACTIVE_TURN_REPLAY_FORBIDDEN');
      if (snapshot.userId !== turn.userId || context.user.id !== turn.userId || snapshot.threadId !== context.threadId
        || owner.id !== turn.runId || lease.inboundTurn.id !== owner.id || lease.inboundTurn.messageId !== turn.requestId
        || lease.inboundTurn.threadId !== context.threadId || binding.runId !== snapshot.runId || binding.userId !== turn.userId
        || binding.threadId !== context.threadId || binding.inboundRunId !== owner.id || binding.requestId !== turn.requestId
        || binding.freshness !== 'snapshot' || binding.grantsExecution !== false || binding.snapshotFingerprint !== hash(snapshot)) fail('ACTIVE_TURN_OWNER_MISMATCH');
      if (snapshot.status !== 'waiting_for_approval' || !snapshot.executionState || snapshot.executionState.kind !== 'generic_operation'
        || Object.hasOwn(snapshot.executionState.context, '_agentCoreClaim')
        || snapshot.actions.some(action => action.domain !== 'task' || action.status !== 'prepared' || action.executionFact !== null
          || !/^[\w.:-]+$/.test(action.callId))) fail('ACTIVE_TURN_UNSUPPORTED_STATE');
      if (planned.status === 'refused') return { status: 'no_action' as const };
      const decision = approvalDecisionSchema.parse(planned.decision);
      const cancel = decision.relation === 'cancel' || decision.relation === 'approval' && decision.decision === 'reject';
      if (!cancel && decision.relation !== 'approval') return { status: 'no_action' as const };
      const ids = decision.decision === 'approve_all' ? snapshot.actions.map(action => action.callId) : decision.selectedCallIds;
      if (!cancel && (!ids.length || new Set(ids).size !== ids.length || ids.some(id => !snapshot.actions.some(action => action.callId === id)))) fail('ACTIVE_TURN_INVALID_SELECTION');
      if (decision.profileUpdate) fail('ACTIVE_TURN_PROFILE_UPDATE_UNSUPPORTED');
      const selected = cancel ? [] : snapshot.actions.filter(action => ids.includes(action.callId));
      for (const action of selected) {
        const call = atomicTaskCallSchema.parse({ toolName: 'manage_task', params: action.payload });
        if (action.domain !== 'task' || action.action !== call.params.action || action.targetId !== call.params.target) fail('ACTIVE_TURN_UNSUPPORTED_ACTION');
      }
      if (['agentCore','agentCoreProductivity','agentCoreActiveRun','agentCoreActiveResolution','agentCoreDeliveryManifest','agentCoreBaseline','agentCoreActiveCompletion'].some(key => Object.hasOwn(lease.inboundTurn.response, key))) fail('ACTIVE_TURN_RECONCILIATION_REQUIRED');
      for (const capability of ['agent_core.baseline.capture','agent_core.delivery','agent_core.turn.finalize', ...(!cancel ? ['agent_core.atomic_tasks'] : [])]) {
        if (!turn.capabilities.has(capability)) fail('ACTIVE_TURN_ACCESS_DENIED');
      }
      const input = ownedBaselineInputSchema.parse({ userText: context.currentUserText, language: turn.language, timezone: turn.timezone });
      const now = context.now ?? Date.now;
      const deadline = Math.min(context.deadlineMs, Date.parse(snapshot.expiresAtIso), now() + 60000);
      if (!Number.isFinite(deadline) || !Number.isFinite(now()) || deadline <= now()) fail('ACTIVE_TURN_EXPIRED');
      // Validate presenter configuration before any persistence or business mutation.
      new Intl.DateTimeFormat('en', { timeZone: turn.timezone }).format();
      const signal = AbortSignal.any([turn.signal, lease.signal, AbortSignal.timeout(Math.max(1, Math.ceil(deadline - now())))]);
      context.turn = { ...turn, signal }; context.deadlineMs = deadline;
      signal.throwIfAborted(); await lease.assertActive(); signal.throwIfAborted();
      if (attempted) fail('ACTIVE_TURN_REPLAY_FORBIDDEN');
      attempted = true;
      let abort: () => void = () => {};
      const cancelled = new Promise<never>((_resolve, reject) => {
        abort = () => reject(signal.reason); signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) abort();
      });
      const work = async () => {
        const baseline = await createOwnedBaseline(client, owner).capture(snapshot.runId, context.turn, input);
        if (new Set([...baseline.conversation.tasks.map(task => task.id), ...selected.map(action => action.targetId)]).size > 50
          || baseline.conversation.handledRequestIds.length >= 100) fail('ACTIVE_TURN_HISTORY_CAPACITY_REACHED');
        const response: JsonObject = { ...structuredClone(lease.inboundTurn.response), agentCoreBaseline: {
          version: 1, baselineId: baseline.id, candidateFingerprint: hash(baseline.candidate), inputRecorded: true, inputFingerprint: hash(input),
        } };
        const receipts: AtomicTaskReceipt[] = [];
        const actualStore = createActiveRunStore(client, owner);
        // Reconstruct from acknowledged writes; seal checks the entire response against actual SQL state.
        const store: ActiveRunStore = {
          async claim(source, status, proposal) {
            const claim = await actualStore.claim(source, status, proposal);
            if (claim) response.agentCoreActiveRun = json({ version: 1, stage: 'claimed', runId: source.runId,
              userId: source.userId, inboundRunId: owner.id, requestId: context.turn.requestId, snapshot: source,
              decision: proposal, claimId: claim.claimId });
            return claim;
          },
          async mutate(claim, operation, payload) {
            const receipt = await actualStore.mutate(claim, operation, payload);
            const checkpoint = response.agentCoreActiveRun as JsonObject;
            if (operation === 'action') checkpoint.actions = { ...(checkpoint.actions as JsonObject ?? {}), [String(payload.callId)]: receipt };
            if (operation === 'finish') { checkpoint.stage = 'final'; checkpoint.result = payload; }
            return receipt;
          },
        };
        const execute = createAtomicTaskExecutor(client, owner, context.turn, async () => true,
          receipt => receipts.push(structuredClone(receipt)));
        // Actual write authorization is enforced by the bridge immediately before every persisted dispatch fence.
        const execution = await new ActiveRunExecutionBridge(store, execute).apply(snapshot, planned, context);
        if ('status' in execution && ['not_acquired','no_action'].includes(String(execution.status))) return { status: String(execution.status) as 'not_acquired' | 'no_action' };
        const checkpoint = activeRunCheckpointSchema.parse(response.agentCoreActiveRun);
        if (receipts.length !== selected.length || new Set(receipts.map(receipt => receipt.callId)).size !== receipts.length
          || receipts.some(receipt => receipt.activeRunId !== snapshot.runId || receipt.claimId !== checkpoint.claimId
            || !selected.some(action => action.callId === receipt.callId && action.targetId === receipt.targetId && action.action === receipt.domainCall.params.action))) fail('ACTIVE_TURN_RECEIPTS_INCOMPLETE');
        const language = decision.responseLanguage ?? context.turn.language;
        const reply = cancel ? { text: language === 'en' ? 'Cancelled. No pending changes were applied.' : 'Cancelado. No se aplicaron los cambios pendientes.', ctas: [], flows: [] }
          : new WhatsAppProductivityPresenter().render({ language, timezone: context.turn.timezone, items: receipts.map(receipt => receipt.item), notices: [] });
        if (reply.ctas.length || reply.flows.length) fail('ACTIVE_TURN_UNSUPPORTED_PRESENTATION');
        const message: ProductivityDelivery = { id: `${encodeURIComponent(context.turn.requestId)}:reply:0`, kind: 'text', text: reply.text };
        transport.validate(structuredClone(message));
        const delivery = createDeliveryManifest(client, owner);
        let manifest = await delivery.seal(response, [message], context.turn);
        let uncertain = false;
        try { manifest = await delivery.send(manifest, message.id, context.turn, transport, authorizeDelivery); }
        catch (error) {
          if (!(error instanceof Error) || !('code' in error) || error.code !== 'DELIVERY_MANIFEST_OUTCOME_UNKNOWN') throw error;
          uncertain = true;
        }
        signal.throwIfAborted(); await lease.assertActive(); signal.throwIfAborted();
        const finalizer = createActiveTurnFinalizer(client,owner);
        let completion;
        try { completion = await finalizer.load(context.turn); }
        catch (error) { if (uncertain) fail('DELIVERY_MANIFEST_OUTCOME_UNKNOWN'); throw error; }
        const conversation = await finalizer.finish(completion,context.turn);
        manifest = completion.manifest;
        return { status: 'completed' as const, execution, manifest, reply: structuredClone(reply), conversation, completion };
      };
      try { return await Promise.race([work(), cancelled]); }
      finally { signal.removeEventListener('abort', abort); }
    },
  };
}
