import {
  activeTurnCompletionSchema, deliveryManifestSchema, completionBaselineSchema, ownedBaselineReceiptSchema, activeRunCheckpointSchema,
  aiTranscriptSchema, productivityConversationSchema, jsonObjectSchema,
  type ActiveTurnCompletion, type AtomicTaskReceipt, type DeliveryManifest, type TurnContext, type JsonObject,
} from '@templelabs/contracts';
import { requireInboundTurnLease } from '../../agent/core/turn-lease.js';
import { WhatsAppProductivityPresenter } from '../../presentation/whatsapp-productivity-presenter.js';
import { checkpointFingerprint } from './checkpoint-fingerprint.js';
import { inboundStoredTurnSchema } from './inbound-checkpoint-reader.js';
import type { ActiveRunRpcClient } from './active-run-store.js';
function fail(code: string): never { throw Object.assign(new Error(code), { code }); }
const hash = (value: unknown) => checkpointFingerprint(jsonObjectSchema.parse(value));
export function buildActiveTurnCompletion(rawBaseline: unknown, rawManifest: DeliveryManifest, receipts: readonly AtomicTaskReceipt[]): ActiveTurnCompletion {
  rawManifest = deliveryManifestSchema.parse(structuredClone(rawManifest));
  const receipt = ownedBaselineReceiptSchema.parse(rawBaseline), candidate = receipt.candidate;
  const { prior: _prior, version: _version, ...identity } = candidate;
  const baseline = completionBaselineSchema.parse({ id: receipt.id, ...identity,
    candidateFingerprint: hash(candidate), input: receipt.input, conversation: receipt.conversation });
  const sourceResponse = { ...rawManifest.sourceResponse, agentCoreDeliveryManifest: {
    version: 1, manifestId: rawManifest.id, sourceFingerprint: hash(rawManifest.sourceResponse),
  } };
  return validateActiveTurnCompletion({ version: 1, kind: 'active_turn_completion', sourceFingerprint: hash(sourceResponse),
    sourceResponse, baseline, manifest: rawManifest, receipts, conversation: completedConversation(baseline, rawManifest, receipts) });
}
function completedConversation(baseline: ActiveTurnCompletion['baseline'], manifest: DeliveryManifest, receipts: readonly AtomicTaskReceipt[]) {
  const tasks = new Map(baseline.conversation.tasks.map(record => [record.id, record]));
  for (const receipt of receipts) {
    if (receipt.item.domain !== 'tasks') fail('ACTIVE_COMPLETION_RECEIPT_MISMATCH');
    for (const record of receipt.item.result!.records) tasks.set(record.id, record);
  }
  return productivityConversationSchema.parse({ ...baseline.conversation, tasks: [...tasks.values()],
    handledRequestIds: [...baseline.conversation.handledRequestIds, baseline.requestId],
    history: [...baseline.conversation.history, { role: 'user', content: baseline.input.userText },
      { role: 'assistant', content: manifest.entries.map(entry => entry.message.text).join('\n\n'), toolCalls: [] }],
  });
}
/** Semantic validation is repeated whenever a persisted completion is imported as history. */
export function validateActiveTurnCompletion(raw: unknown): ActiveTurnCompletion {
  const value = activeTurnCompletionSchema.parse(raw), { baseline, manifest, receipts } = value;
  const checkpoint = activeRunCheckpointSchema.parse(value.sourceResponse.agentCoreActiveRun);
  const marker = jsonObjectSchema.parse(value.sourceResponse.agentCoreBaseline);
  const deliveryMarker = jsonObjectSchema.parse(value.sourceResponse.agentCoreDeliveryManifest);
  const original = { ...value.sourceResponse }; delete original.agentCoreDeliveryManifest;
  if (['agentCore','agentCoreProductivity','agentCoreResolution','agentCoreActiveResolution','agentCoreActiveCompletion'].some(key => Object.hasOwn(value.sourceResponse,key))
    || checkpoint.stage !== 'final' || !['completed','cancelled'].includes(String(checkpoint.result.status))
    || baseline.userId !== checkpoint.userId || baseline.inboundRunId !== checkpoint.inboundRunId || baseline.activeRunId !== checkpoint.runId
    || baseline.requestId !== checkpoint.requestId || baseline.threadId !== checkpoint.snapshot.threadId
    || marker.version !== 1 || marker.inputRecorded !== true || marker.inputFingerprint !== hash(baseline.input) || marker.baselineId !== baseline.id || marker.candidateFingerprint !== baseline.candidateFingerprint
    || deliveryMarker.version !== 1 || deliveryMarker.manifestId !== manifest.id || deliveryMarker.sourceFingerprint !== hash(manifest.sourceResponse)
    || hash(original) !== hash(manifest.sourceResponse) || hash(value.sourceResponse) !== value.sourceFingerprint
    || manifest.userId !== baseline.userId || manifest.inboundRunId !== baseline.inboundRunId || manifest.activeRunId !== baseline.activeRunId
    || manifest.requestId !== baseline.requestId || manifest.threadId !== baseline.threadId || !manifest.entries.length
    || manifest.entries.some(entry => entry.state !== 'accepted' || entry.message.kind !== 'text' || entry.message.text.length > 4000)) fail('ACTIVE_COMPLETION_SOURCE_MISMATCH');
  const state = baseline.conversation;
  if (state.userId !== baseline.userId || state.handledRequestIds.includes(baseline.requestId)
    || new Set(state.handledRequestIds).size !== state.handledRequestIds.length || state.history.some(message => message.role === 'system')
    || state.history.length && !aiTranscriptSchema.safeParse(state.history).success
    || [state.tasks,state.reminders,state.events].some(records => new Set(records.map(record => record.id)).size !== records.length)) fail('ACTIVE_COMPLETION_BASELINE_INVALID');
  const seen = new Set<string>();
  for (const action of checkpoint.snapshot.actions) {
    const current = checkpoint.actions?.[action.callId];
    if (!current || action.domain !== 'task' || action.status !== 'prepared' || action.executionFact !== null) fail('ACTIVE_COMPLETION_ACTION_MISMATCH');
    if (current.status === 'skipped' && current.execution_fact === null) continue;
    const receipt = receipts.find(receipt => receipt.callId === action.callId);
    if (current.status !== 'executed' || !receipt || receipt.claimId !== checkpoint.claimId || receipt.userId !== baseline.userId
      || receipt.activeRunId !== baseline.activeRunId || receipt.inboundRunId !== baseline.inboundRunId || receipt.threadId !== baseline.threadId
      || receipt.targetId !== action.targetId || receipt.domainCall.params.action !== action.action) fail('ACTIVE_COMPLETION_RECEIPT_MISMATCH');
    const fact = { ...current.execution_fact }; delete fact._domainCall;
    if (hash(current.execution_fact?._domainCall) !== hash(receipt.domainCall) || hash(fact) !== hash(receipt.legacyResult)) fail('ACTIVE_COMPLETION_RECEIPT_MISMATCH');
    seen.add(receipt.callId);
  }
  const ordered = checkpoint.snapshot.actions.filter(action => checkpoint.actions?.[action.callId]?.status === 'executed').map(action => action.callId);
  if (checkpoint.result.status === 'completed' && !receipts.length || receipts.some((receipt,index) => receipt.callId !== ordered[index])
    || seen.size !== receipts.length || new Set(receipts.map(receipt => receipt.callId)).size !== receipts.length
    || checkpoint.result.status === 'cancelled' && receipts.length) fail('ACTIVE_COMPLETION_RECEIPT_MISMATCH');
  const language = checkpoint.decision.responseLanguage ?? baseline.input.language;
  if (language !== 'es' && language !== 'en') fail('ACTIVE_COMPLETION_SOURCE_MISMATCH');
  const reply = checkpoint.result.status === 'cancelled' ? (language === 'en' ? 'Cancelled. No pending changes were applied.' : 'Cancelado. No se aplicaron los cambios pendientes.')
    : new WhatsAppProductivityPresenter().render({ language, timezone: baseline.input.timezone, items: receipts.map(receipt => receipt.item), notices: [] }).text;
  if (manifest.entries.length !== 1 || manifest.entries[0]!.message.text !== reply
    || hash(completedConversation(baseline,manifest,receipts)) !== hash(value.conversation)
    || !aiTranscriptSchema.safeParse(value.conversation.history).success) fail('ACTIVE_COMPLETION_CONVERSATION_MISMATCH');
  return structuredClone(value);
}
export function recoverActiveTurnCompletion(raw: unknown, userId: string) {
  const row = inboundStoredTurnSchema.parse(raw), completion = validateActiveTurnCompletion(row.response?.agentCoreActiveCompletion);
  const source = { ...row.response }; delete source.agentCoreActiveCompletion;
  if (row.status !== 'completed' || completion.baseline.userId !== userId || completion.baseline.inboundRunId !== row.id
    || completion.baseline.requestId !== row.message_id || completion.baseline.threadId !== row.thread_id
    || completion.baseline.sequenceId !== row.sequence_id || hash(source) !== completion.sourceFingerprint) fail('ACTIVE_COMPLETION_OWNER_MISMATCH');
  return structuredClone(completion.conversation);
}
export function createActiveTurnFinalizer(client: ActiveRunRpcClient, rawOwner: { readonly id: string; readonly token: string }) {
  const owner = { ...rawOwner };
  return {
    async load(rawContext: TurnContext) {
      const context = { ...rawContext, capabilities: new Set(rawContext.capabilities) };
      const lease = requireInboundTurnLease();
      if (!context.capabilities.has('agent_core.turn.finalize')) fail('ACTIVE_COMPLETION_ACCESS_DENIED');
      if (owner.id !== context.runId || lease.inboundTurn.id !== owner.id || context.requestId !== lease.inboundTurn.messageId) fail('ACTIVE_COMPLETION_OWNER_MISMATCH');
      const signal = AbortSignal.any([context.signal,lease.signal,AbortSignal.timeout(15000)]);
      signal.throwIfAborted(); await lease.assertActive(); signal.throwIfAborted();
      let abort:()=>void=()=>{};
      const cancelled = new Promise<never>((_resolve,reject)=>{abort=()=>reject(signal.reason);signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();});
      let result:{readonly data:unknown;readonly error:unknown};
      try {result=await Promise.race([Promise.resolve(client.rpc('read_hermes_active_turn_completion',{p_owner_id:owner.id,p_owner_token:owner.token})),cancelled]);}
      catch {signal.throwIfAborted();fail('ACTIVE_COMPLETION_STORAGE_UNCERTAIN');}
      finally {signal.removeEventListener('abort',abort);}
      signal.throwIfAborted(); await lease.assertActive(); signal.throwIfAborted();
      if (result.error) fail('ACTIVE_COMPLETION_STORAGE_UNCERTAIN');
      if (result.data===null) fail('ACTIVE_COMPLETION_UNAVAILABLE');
      const data=jsonObjectSchema.parse(result.data);
      const completion=buildActiveTurnCompletion(data.baseline,data.manifest as unknown as DeliveryManifest,data.receipts as unknown as AtomicTaskReceipt[]);
      if (hash(completion.sourceResponse)!==hash(data.sourceResponse) || completion.baseline.inboundRunId!==owner.id
        || completion.baseline.userId!==context.userId || completion.baseline.requestId!==context.requestId
        || completion.baseline.threadId!==lease.inboundTurn.threadId) fail('ACTIVE_COMPLETION_OWNER_MISMATCH');
      return completion;
    },
    async finish(raw: unknown, rawContext: TurnContext) {
    const context = { ...rawContext, capabilities: new Set(rawContext.capabilities) };
    const completion = validateActiveTurnCompletion(raw), lease = requireInboundTurnLease();
    if (!context.capabilities.has('agent_core.turn.finalize')) fail('ACTIVE_COMPLETION_ACCESS_DENIED');
    if (owner.id !== context.runId || lease.inboundTurn.id !== owner.id || context.requestId !== lease.inboundTurn.messageId
      || completion.baseline.inboundRunId !== owner.id || completion.baseline.userId !== context.userId
      || completion.baseline.requestId !== context.requestId || completion.baseline.threadId !== lease.inboundTurn.threadId) fail('ACTIVE_COMPLETION_OWNER_MISMATCH');
    const signal = AbortSignal.any([context.signal,lease.signal,AbortSignal.timeout(15000)]);
    signal.throwIfAborted(); await lease.assertActive(); signal.throwIfAborted();
    let abort:()=>void=()=>{};
    const cancelled = new Promise<never>((_resolve,reject)=>{abort=()=>reject(signal.reason);signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();});
    let result:{readonly data:unknown;readonly error:unknown};
    try {
      const publish = async () => {
        result=await Promise.race([Promise.resolve(client.rpc('finish_hermes_active_turn',{p_owner_id:owner.id,p_owner_token:owner.token,p_expected:completion.sourceResponse,p_completion:jsonObjectSchema.parse(completion)})),cancelled]);
        signal.throwIfAborted();
        if (result.error) fail('ACTIVE_COMPLETION_STORAGE_UNCERTAIN');
        if (result.data!==true) fail('ACTIVE_COMPLETION_CONFLICT');
        return true;
      };
      if (lease.finalizeCurrent) await lease.finalizeCurrent(publish);
      else await publish();
    }
    catch {signal.throwIfAborted();fail('ACTIVE_COMPLETION_STORAGE_UNCERTAIN');}
    finally {signal.removeEventListener('abort',abort);}
    signal.throwIfAborted();
    // Successful finalization retires the lease. Do not renew or reassert that retired owner.
    return structuredClone(completion.conversation);
  } };
}
