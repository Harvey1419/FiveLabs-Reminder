import {
  deliveryManifestSchema, activeRunCheckpointSchema, activeRunRecoverySnapshotSchema,
  activeRunDeliveryEvidenceSchema, jsonObjectSchema, type DeliveryManifest,
  type ProductivityDelivery, type JsonObject, type TurnContext,
} from '@templelabs/contracts';
import { requireInboundTurnLease } from '../../agent/core/turn-lease.js';
import type { ActiveRunRpcClient } from './active-run-store.js';
import { checkpointFingerprint } from './checkpoint-fingerprint.js';
import { inspectActiveRunRecovery } from './active-run-recovery.js';

function fail(code: string): never { throw Object.assign(new Error(code), { code }); }
const hash = (value: unknown) => checkpointFingerprint(jsonObjectSchema.parse(value));
export interface ManifestDeliveryTransport {
  validate(message: ProductivityDelivery): void;
  send(message: ProductivityDelivery, context: TurnContext): Promise<{ readonly messageId: string }>;
}
export function createDeliveryManifest(client: ActiveRunRpcClient, rawOwner: { readonly id: string; readonly token: string }) {
  const owner = { id: rawOwner.id, token: rawOwner.token };
  const rpc = async (operation: string, payload: JsonObject, context: TurnContext, capability: string) => {
    const lease = requireInboundTurnLease(), turn = { ...context, capabilities: new Set(context.capabilities) };
    if (!turn.capabilities.has(capability)) fail('DELIVERY_MANIFEST_ACCESS_DENIED');
    if (turn.runId !== owner.id || lease.inboundTurn.id !== owner.id || turn.requestId !== lease.inboundTurn.messageId) fail('DELIVERY_MANIFEST_OWNER_MISMATCH');
    const signal = AbortSignal.any([turn.signal, lease.signal, AbortSignal.timeout(15000)]);
    const fresh = async () => { signal.throwIfAborted(); await lease.assertActive(); signal.throwIfAborted(); };
    await fresh();
    let abort: () => void = () => {};
    const cancelled = new Promise<never>((_resolve,reject) => { abort=()=>reject(signal.reason);
      signal.addEventListener('abort',abort,{once:true}); if(signal.aborted) abort(); });
    let result: { readonly data: unknown; readonly error: unknown };
    try { result=await Promise.race([Promise.resolve(client.rpc('access_hermes_delivery_manifest', {
      p_owner_id: owner.id, p_owner_token: owner.token, p_operation: operation, p_payload: structuredClone(payload),
    })), cancelled]); }
    catch { signal.throwIfAborted(); fail('DELIVERY_MANIFEST_STORAGE_UNCERTAIN'); }
    finally { signal.removeEventListener('abort',abort); }
    await fresh();
    if(result.error) fail('DELIVERY_MANIFEST_STORAGE_UNCERTAIN');
    if(result.data===null) fail('DELIVERY_MANIFEST_NOT_ADMITTED');
    return deliveryManifestSchema.parse(result.data);
  };
  const validateOwner = (manifest: DeliveryManifest, context: TurnContext) => {
    if(manifest.userId!==context.userId || manifest.inboundRunId!==owner.id || manifest.requestId!==context.requestId
      || manifest.threadId!==requireInboundTurnLease().inboundTurn.threadId) fail('DELIVERY_MANIFEST_OWNER_MISMATCH');
  };
  const samePlan = (left: DeliveryManifest, right: DeliveryManifest) => {
    const immutable = (manifest: DeliveryManifest) => ({...manifest,entries:manifest.entries.map(entry=>({message:entry.message}))});
    if(hash(immutable(left))!==hash(immutable(right))) fail('DELIVERY_MANIFEST_RECEIPT_MISMATCH');
  };
  return {
    async seal(expectedResponse: JsonObject, messages: readonly ProductivityDelivery[], context: TurnContext): Promise<DeliveryManifest> {
      const expected = jsonObjectSchema.parse(structuredClone(expectedResponse));
      const checkpoint = activeRunCheckpointSchema.parse(expected.agentCoreActiveRun);
      if(checkpoint.stage!=='final' || checkpoint.userId!==context.userId || checkpoint.inboundRunId!==context.runId
        || checkpoint.requestId!==context.requestId || checkpoint.snapshot.threadId!==requireInboundTurnLease().inboundTurn.threadId) fail('DELIVERY_MANIFEST_OWNER_MISMATCH');
      const draft=deliveryManifestSchema.parse({version:1,id:'00000000-0000-4000-8000-000000000001',userId:context.userId,
        inboundRunId:context.runId,activeRunId:checkpoint.runId,requestId:context.requestId,threadId:checkpoint.snapshot.threadId,
        sourceResponse:expected,entries:messages.map(message=>({message:structuredClone(message),state:'ready',providerMessageId:null}))});
      const manifest=await rpc('seal',{expectedResponse:expected,sourceFingerprint:hash(expected),draft:jsonObjectSchema.parse(draft)},context,'agent_core.delivery');
      validateOwner(manifest,context);
      if(hash({...manifest,id:draft.id})!==hash(draft)) fail('DELIVERY_MANIFEST_RECEIPT_MISMATCH');
      return manifest;
    },
    async send(raw: DeliveryManifest, messageId: string, context: TurnContext, transport: ManifestDeliveryTransport,
      authorize: (message: ProductivityDelivery, context: TurnContext) => boolean | Promise<boolean>): Promise<DeliveryManifest> {
      const manifest=deliveryManifestSchema.parse(structuredClone(raw)), turn={...context,capabilities:new Set(context.capabilities)};
      validateOwner(manifest,turn);
      const entry=manifest.entries.find(entry=>entry.message.id===messageId);
      if(!entry || entry.state!=='ready') fail('DELIVERY_MANIFEST_REPLAY_FORBIDDEN');
      const message=structuredClone(entry.message);
      transport.validate(structuredClone(message));
      if(!turn.capabilities.has('agent_core.delivery') || !await authorize(structuredClone(message),{...turn,capabilities:new Set(turn.capabilities)})) fail('DELIVERY_MANIFEST_ACCESS_DENIED');
      const attempted=await rpc('attempt',{manifestId:manifest.id,message:jsonObjectSchema.parse(message)},turn,'agent_core.delivery');
      samePlan(attempted,manifest);
      const changed=attempted.entries.find(item=>item.message.id===message.id);
      if(attempted.id!==manifest.id || !changed || changed.state!=='attempted' || hash(changed.message)!==hash(message)) fail('DELIVERY_MANIFEST_RECEIPT_MISMATCH');
      const lease=requireInboundTurnLease();
      const signal=AbortSignal.any([turn.signal,lease.signal,AbortSignal.timeout(15000)]);
      signal.throwIfAborted(); await lease.assertActive(); signal.throwIfAborted();
      let abort:()=>void=()=>{};
      const cancelled=new Promise<never>((_resolve,reject)=>{abort=()=>reject(signal.reason); signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();});
      try {
        const receipt=await Promise.race([transport.send(structuredClone(message),{...turn,capabilities:new Set(turn.capabilities),signal}),cancelled]);
        if(!receipt || typeof receipt.messageId!=='string' || !receipt.messageId.trim()) fail('DELIVERY_MANIFEST_OUTCOME_UNKNOWN');
        const accepted=await rpc('accept',{manifestId:manifest.id,message:jsonObjectSchema.parse(message),providerMessageId:receipt.messageId},turn,'agent_core.delivery');
        samePlan(accepted,manifest);
        const stored=accepted.entries.find(item=>item.message.id===message.id);
        if(accepted.id!==manifest.id || stored?.state!=='accepted' || stored.providerMessageId!==receipt.messageId) fail('DELIVERY_MANIFEST_RECEIPT_MISMATCH');
        return accepted;
      } catch {
        // Persist uncertainty when ownership survives; a retained attempted fence is equally non-replayable.
        await rpc('unknown',{manifestId:manifest.id,message:jsonObjectSchema.parse(message)},turn,'agent_core.delivery').catch(()=>{});
        fail('DELIVERY_MANIFEST_OUTCOME_UNKNOWN');
      } finally {signal.removeEventListener('abort',abort);}
    },
    async delivery(raw: unknown, context: TurnContext) {
      const source=activeRunRecoverySnapshotSchema.parse(structuredClone(raw));
      if(source.anchor.id!==context.runId || source.anchor.message_id!==context.requestId || source.run.user_id!==context.userId) fail('DELIVERY_MANIFEST_OWNER_MISMATCH');
      inspectActiveRunRecovery(source,context.userId,requireInboundTurnLease().inboundTurn.threadId);
      const manifest=await rpc('read',{expected:jsonObjectSchema.parse(source)},context,'agent_core.reconcile');
      const original={...source.prior.response}; delete original.agentCoreDeliveryManifest;
      const marker=jsonObjectSchema.parse(source.prior.response.agentCoreDeliveryManifest);
      if(manifest.userId!==context.userId || manifest.inboundRunId!==source.prior.id || manifest.activeRunId!==source.run.id
        || manifest.threadId!==source.run.thread_id || manifest.requestId!==source.prior.message_id || marker.version!==1
        || marker.manifestId!==manifest.id || marker.sourceFingerprint!==hash(manifest.sourceResponse)
        || hash(original)!==hash(manifest.sourceResponse)) fail('DELIVERY_MANIFEST_RECEIPT_MISMATCH');
      if(manifest.entries.some(entry=>entry.state==='attempted' || entry.state==='unknown')
        || manifest.entries.some(entry=>entry.state==='accepted') && manifest.entries.some(entry=>entry.state==='ready')) fail('DELIVERY_MANIFEST_RECONCILIATION_REQUIRED');
      const ids=manifest.entries.flatMap(entry=>entry.providerMessageId ? [entry.providerMessageId] : []);
      return activeRunDeliveryEvidenceSchema.parse({userId:context.userId,inboundRunId:source.prior.id,
        sourceFingerprint:hash(source.prior.response),evidenceId:manifest.id,outcome:ids.length ? 'accepted' : 'not_sent',messageIds:ids});
    },
  };
}
