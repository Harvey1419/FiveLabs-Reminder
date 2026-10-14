import { describe, it, expect, vi } from 'vitest';
import { deliveryManifestSchema, activeRunRecoverySnapshotSchema, type JsonObject, type TurnContext, type DeliveryManifest } from '@templelabs/contracts';
import { createDeliveryManifest, type ManifestDeliveryTransport } from '../../../src/adapters/agent-core/delivery-manifest.js';
import { createKapsoTextTransport } from '../../../src/adapters/agent-core/kapso-text-transport.js';
import { withTurnLease } from '../../../src/agent/core/turn-lease.js';
import { checkpointFingerprint } from '../../../src/adapters/agent-core/checkpoint-fingerprint.js';
const user='00000000-0000-4000-8000-000000000001', owner='00000000-0000-4000-8000-000000000002', run='00000000-0000-4000-8000-000000000003', id='00000000-0000-4000-8000-000000000004';
function fixture() {
  const action={callId:'a',domain:'task',action:'delete',targetId:id,targetName:'Tarea',payload:{action:'delete',target:id},status:'skipped',executionFact:null};
  const snapshot={runId:run,userId:user,threadId:'thread',status:'waiting_for_approval',expiresAtIso:'2026-10-11T20:00:00Z',actions:[action],executionState:{kind:'generic_operation',context:{},waitingFor:null}};
  const response:JsonObject={agentCoreActiveRun:{version:1,stage:'final',runId:run,userId:user,inboundRunId:owner,requestId:'request',claimId:id,snapshot,decision:{},result:{success:false,status:'cancelled'}}};
  const context:TurnContext={userId:user,runId:owner,requestId:'request',language:'es',timezone:'America/Bogota',referenceTimeIso:'2026-10-12T01:00:00Z',capabilities:new Set(['agent_core.delivery']),signal:new AbortController().signal};
  const lease={inboundTurn:{id:owner,messageId:'request',threadId:'thread',response:{}},signal:new AbortController().signal,assertActive:vi.fn(async()=>{}),checkpoint:vi.fn(async()=>{})};
  const messages=[{id:'request:reply:0',kind:'text' as const,text:'Primero'},{id:'request:reply:1',kind:'text' as const,text:'Segundo'}];
  let stored:DeliveryManifest | undefined;
  const operations:string[]=[];
  const rpc=vi.fn(async(_name:string,args:JsonObject):Promise<{data:unknown;error:unknown}>=>{
    const op=String(args.p_operation),payload=args.p_payload as JsonObject;operations.push(op);
    if(op==='seal') {if(stored)return{data:null,error:null};stored=deliveryManifestSchema.parse({...payload.draft as JsonObject,id});}
    else if(op!=='read') {
      const entry=stored!.entries.find(entry=>entry.message.id===(payload.message as JsonObject).id)!;
      if(op==='attempt') {if(entry.state!=='ready')return{data:null,error:null};entry.state='attempted';}
      if(op==='accept') {if(entry.state!=='attempted')return{data:null,error:null};entry.state='accepted';entry.providerMessageId=String(payload.providerMessageId);}
      if(op==='unknown') {if(entry.state!=='attempted')return{data:null,error:null};entry.state='unknown';}
    }
    return{data:structuredClone(stored),error:null};
  });
  const api=createDeliveryManifest({rpc},{id:owner,token:'private'});
  const send=vi.fn(async()=>({messageId:'provider-1'})),transport:ManifestDeliveryTransport={validate:vi.fn(),send};
  const work=<T>(cb:()=>Promise<T>)=>withTurnLease(lease,cb);
  const seal=()=>work(()=>api.seal(response,messages,context));
  const prior=(manifest:DeliveryManifest)=>activeRunRecoverySnapshotSchema.parse({anchor:{id:owner,message_id:'request',thread_id:'thread',sequence_id:10},
    prior:{id:owner,message_id:'request',thread_id:'thread',sequence_id:1,status:'unknown',response:{...response,agentCoreDeliveryManifest:{version:1,manifestId:manifest.id,sourceFingerprint:checkpointFingerprint(response)}}},
    run:{id:run,user_id:user,thread_id:'thread',status:'cancelled',kind:'generic_operation',context:{},waiting_for:null,expires_at:snapshot.expiresAtIso},actions:[action]});
  return{api,rpc,context,lease,response,messages,transport,send,work,seal,operations,stored:()=>stored!,prior};
}
describe('sealed delivery plans and provider receipt fences',()=>{
  it('seals the full plan then persists an attempt before transport and an acceptance afterward',async()=>{
    const f=fixture(),plan=await f.seal();
    f.send.mockImplementation(async()=>{expect(f.stored().entries[0]!.state).toBe('attempted');return{messageId:'provider-1'};});
    const after=await f.work(()=>f.api.send(plan,plan.entries[0]!.message.id,f.context,f.transport,async()=>true));
    expect(after.entries[0]).toMatchObject({state:'accepted',providerMessageId:'provider-1'});expect(f.operations).toEqual(['seal','attempt','accept']);
    expect(f.send).toHaveBeenCalledOnce();expect(f.rpc.mock.calls[0]![1]).toMatchObject({p_owner_id:owner,p_owner_token:'private'});
  });
  it('does not replay an accepted or attempted message, even with an old local ready plan',async()=>{
    const f=fixture(),plan=await f.seal();const after=await f.work(()=>f.api.send(plan,plan.entries[0]!.message.id,f.context,f.transport,async()=>true));
    await expect(f.work(()=>f.api.send(after,after.entries[0]!.message.id,f.context,f.transport,async()=>true))).rejects.toThrow('DELIVERY_MANIFEST_REPLAY_FORBIDDEN');
    await expect(f.work(()=>f.api.send(plan,plan.entries[0]!.message.id,f.context,f.transport,async()=>true))).rejects.toThrow('DELIVERY_MANIFEST_NOT_ADMITTED');expect(f.send).toHaveBeenCalledOnce();
  });
  it('keeps an unknown transport outcome non-replayable and never retries the provider',async()=>{
    const f=fixture(),plan=await f.seal();f.send.mockRejectedValue(new Error('response lost'));
    await expect(f.work(()=>f.api.send(plan,plan.entries[0]!.message.id,f.context,f.transport,async()=>true))).rejects.toThrow('DELIVERY_MANIFEST_OUTCOME_UNKNOWN');
    expect(f.stored().entries[0]!.state).toBe('unknown');expect(f.send).toHaveBeenCalledOnce();
  });
  it('retains the attempted fence when acceptance persistence fails after provider success',async()=>{
    const f=fixture(),plan=await f.seal(),base=f.rpc.getMockImplementation()!;
    f.rpc.mockImplementation(async(name,args)=>args.p_operation==='accept'||args.p_operation==='unknown'?{data:null,error:{message:'private'}}:base(name,args));
    await expect(f.work(()=>f.api.send(plan,plan.entries[0]!.message.id,f.context,f.transport,async()=>true))).rejects.toThrow('DELIVERY_MANIFEST_OUTCOME_UNKNOWN');
    expect(f.stored().entries[0]!.state).toBe('attempted');expect(f.send).toHaveBeenCalledOnce();
  });
  it('does not downgrade a durably accepted message when the acceptance response is lost',async()=>{
    const f=fixture(),plan=await f.seal(),base=f.rpc.getMockImplementation()!;
    f.rpc.mockImplementation(async(name,args)=>{const result=await base(name,args);if(args.p_operation==='accept')throw new Error('lost');return result;});
    await expect(f.work(()=>f.api.send(plan,plan.entries[0]!.message.id,f.context,f.transport,async()=>true))).rejects.toThrow('DELIVERY_MANIFEST_OUTCOME_UNKNOWN');
    expect(f.stored().entries[0]!.state).toBe('accepted');expect(f.stored().entries[0]!.providerMessageId).toBe('provider-1');
  });
  it('authorizes and validates supported content before creating a send fence',async()=>{
    const f=fixture(),plan=await f.seal();
    await expect(f.work(()=>f.api.send(plan,plan.entries[0]!.message.id,f.context,f.transport,async()=>false))).rejects.toThrow('DELIVERY_MANIFEST_ACCESS_DENIED');
    expect(f.operations).toEqual(['seal']);expect(f.send).not.toHaveBeenCalled();
    f.transport.validate=()=>{throw new Error('unsupported');};await expect(f.work(()=>f.api.send(plan,plan.entries[0]!.message.id,f.context,f.transport,async()=>true))).rejects.toThrow('unsupported');expect(f.operations).toEqual(['seal']);
  });
  it('rejects altered source, owner, entry ordering and duplicate identities',async()=>{
    const f=fixture();await expect(f.work(()=>f.api.seal({...f.response,agentCoreActiveRun:{}},f.messages,f.context))).rejects.toThrow();
    await expect(f.work(()=>f.api.seal(f.response,[f.messages[1]!,f.messages[0]!],f.context))).rejects.toThrow();
    await expect(f.work(()=>f.api.seal(f.response,[f.messages[0]!,f.messages[0]!],f.context))).rejects.toThrow();
    const plan=await f.seal();plan.userId=id;await expect(f.work(()=>f.api.send(plan,plan.entries[0]!.message.id,f.context,f.transport,async()=>true))).rejects.toThrow('DELIVERY_MANIFEST_OWNER_MISMATCH');
  });
  it('rejects changed immutable plan metadata in a storage receipt before transport',async()=>{
    const f=fixture(),plan=await f.seal(),base=f.rpc.getMockImplementation()!;
    f.rpc.mockImplementation(async(name,args)=>{const result=await base(name,args);const data=structuredClone(result.data) as DeliveryManifest;if(args.p_operation==='attempt')data.threadId='foreign';return{data,error:null};});
    await expect(f.work(()=>f.api.send(plan,plan.entries[0]!.message.id,f.context,f.transport,async()=>true))).rejects.toThrow('DELIVERY_MANIFEST_RECEIPT_MISMATCH');expect(f.send).not.toHaveBeenCalled();
  });
  it('requires a manifest to prove no send and blocks partial/unknown delivery evidence',async()=>{
    const f=fixture(),plan=await f.seal(),source=f.prior(plan),recoveryId='00000000-0000-4000-8000-000000000005';
    source.anchor.id=recoveryId;source.anchor.message_id='recover';
    const lease={...f.lease,inboundTurn:{...f.lease.inboundTurn,id:recoveryId,messageId:'recover'}};
    const context={...f.context,runId:recoveryId,requestId:'recover',capabilities:new Set(['agent_core.reconcile'])};
    const api=createDeliveryManifest({rpc:f.rpc},{id:recoveryId,token:'new-private'});
    const read=()=>withTurnLease(lease,()=>api.delivery(source,context));
    expect(await read()).toMatchObject({outcome:'not_sent',messageIds:[]});
    f.stored().entries[0]!.state='attempted';await expect(read()).rejects.toThrow('DELIVERY_MANIFEST_RECONCILIATION_REQUIRED');
    f.stored().entries[0]!.state='accepted';f.stored().entries[0]!.providerMessageId='provider-1';await expect(read()).rejects.toThrow('DELIVERY_MANIFEST_RECONCILIATION_REQUIRED');
    f.stored().entries[1]!.state='accepted';f.stored().entries[1]!.providerMessageId='provider-2';expect(await read()).toMatchObject({outcome:'accepted',messageIds:['provider-1','provider-2']});
    f.rpc.mockResolvedValueOnce({data:null,error:null});await expect(read()).rejects.toThrow('DELIVERY_MANIFEST_NOT_ADMITTED');
  });
  it('captures recipient ownership and sends the existing text wire shape exactly once',async()=>{
    const fetcher=vi.fn<typeof fetch>(async()=>new Response(JSON.stringify({messages:[{id:'wamid.receipt'}]}),{status:200}));
    const config={userId:user,apiKey:'private',phoneNumberId:'123',recipient:{kind:'phone' as const,value:'573001234567'}};
    const transport=createKapsoTextTransport(config,fetcher);config.recipient.value='573009999999';
    const f=fixture();expect(await transport.send(f.messages[0]!,f.context)).toEqual({messageId:'wamid.receipt'});
    expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body))).toEqual({messaging_product:'whatsapp',to:'573001234567',type:'text',text:{body:'Primero'}});
    await expect(transport.send(f.messages[0]!,{...f.context,userId:id})).rejects.toThrow('DELIVERY_RECIPIENT_OWNER_MISMATCH');expect(fetcher).toHaveBeenCalledOnce();
  });
  it('does not retry explicit provider rejection or a missing acceptance identity',async()=>{
    const fetcher=vi.fn(async()=>new Response('{}',{status:429}));const transport=createKapsoTextTransport({userId:user,apiKey:'key',phoneNumberId:'123',recipient:{kind:'bsuid',value:'bsuid'}},fetcher);
    const f=fixture();await expect(transport.send(f.messages[0]!,f.context)).rejects.toThrow('DELIVERY_PROVIDER_UNCONFIRMED');expect(fetcher).toHaveBeenCalledOnce();
    fetcher.mockResolvedValue(new Response('{}',{status:200}));await expect(transport.send(f.messages[0]!,f.context)).rejects.toThrow();expect(fetcher).toHaveBeenCalledTimes(2);
  });
});
