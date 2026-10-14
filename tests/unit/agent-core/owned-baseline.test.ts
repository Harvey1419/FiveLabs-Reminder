import { describe, it, expect, vi } from 'vitest';
import { jsonObjectSchema, productivityCheckpointSchema, activeRunRecoverySnapshotSchema } from '@templelabs/contracts';
import { conversationFromOwnedBaseline, createOwnedBaseline } from '../../../src/adapters/agent-core/owned-baseline.js';
import { createActiveRunRecoveryRuntime } from '../../../src/adapters/agent-core/active-run-recovery-runtime.js';
import { checkpointFingerprint } from '../../../src/adapters/agent-core/checkpoint-fingerprint.js';
import { claimAgentCoreLease } from '../../../src/adapters/agent-core/inbound-admission.js';
import { withTurnLease } from '../../../src/agent/core/turn-lease.js';
const user='00000000-0000-4000-8000-000000000001', owner='00000000-0000-4000-8000-000000000002', run='00000000-0000-4000-8000-000000000003', id='00000000-0000-4000-8000-000000000004';
const empty={userId:user,history:[],tasks:[],reminders:[],events:[],handledRequestIds:[]};
function fixture() {
  const conversation={...empty,history:[{role:'user' as const,content:'Historia'},{role:'assistant' as const,content:'Respuesta',toolCalls:[]}],handledRequestIds:['older']};
  const checkpoint=productivityCheckpointSchema.parse({version:1,userId:user,runId:id,requestId:'older',phase:'completed',start:{conversation:empty,text:'Historia'},effects:[],
    completed:{conversation,uiPayload:{language:'es' as const,timezone:'America/Bogota',items:[],notices:[]},reply:{text:'Respuesta',ctas:[],flows:[]},requiresReconciliation:false},
    deliveries:[{message:{id:'older:reply:0',kind:'text',text:'Respuesta'},status:'accepted',messageId:'provider-old'}]});
  const candidate={version:1,userId:user,inboundRunId:owner,activeRunId:run,requestId:'current',threadId:'thread',sequenceId:10,
    prior:{id,message_id:'older',thread_id:'thread',sequence_id:1,status:'completed',response:{agentCoreProductivity:checkpoint}}};
  const context={userId:user,runId:owner,requestId:'current',language:'es' as const,timezone:'America/Bogota',referenceTimeIso:new Date().toISOString(),capabilities:new Set(['agent_core.baseline.capture']),signal:new AbortController().signal};
  const lease={inboundTurn:{id:owner,messageId:'current',threadId:'thread',response:{}},signal:new AbortController().signal,assertActive:vi.fn(async()=>{}),checkpoint:vi.fn(async()=>{})};
  const rpc=vi.fn(async(_name:string,args:Record<string,unknown>)=>({data:args.p_operation==='candidate'?structuredClone(candidate):{version:1,id,candidate:structuredClone(candidate),conversation:structuredClone(conversation)},error:null}));
  const api=createOwnedBaseline({rpc},{id:owner,token:'private'});
  return {candidate,conversation,context,lease,rpc,api,capture:()=>withTurnLease(lease,()=>api.capture(run,context))};
}
describe('authoritative owned baseline capture',()=>{
  it('preserves closed history and handled IDs from the exact completed checkpoint',async()=>{
    const f=fixture();expect(conversationFromOwnedBaseline(f.candidate)).toEqual(f.conversation);
    const receipt=await f.capture();expect(receipt.conversation).toEqual(f.conversation);expect(f.rpc).toHaveBeenCalledTimes(2);
    expect(f.rpc.mock.calls[1]![1]).toMatchObject({p_owner_id:owner,p_owner_token:'private',p_operation:'capture'});
    expect(f.lease.checkpoint).not.toHaveBeenCalled();
  });
  it('constructs genesis only from an explicit SQL candidate with no prior turn',()=>{
    const f=fixture();expect(conversationFromOwnedBaseline({...f.candidate,prior:null})).toEqual(empty);
  });
  it.each(['foreign','running','oldNamespace','order','openHistory','duplicateLedger','currentReplay','unknownDelivery','missingCheckpoint'])('rejects %s continuity',kind=>{
    const f=fixture(),candidate=jsonObjectSchema.parse(f.candidate),prior=candidate.prior as Record<string,unknown>;
    const response=prior.response as Record<string,unknown>,checkpoint=response.agentCoreProductivity as Record<string,unknown>;
    if(kind==='foreign')checkpoint.userId=id;
    if(kind==='running')prior.status='running';
    if(kind==='oldNamespace')response.agentCore={version:1};
    if(kind==='order')prior.sequence_id=100;
    if(kind==='openHistory')(checkpoint.completed as Record<string,unknown>).conversation={...f.conversation,history:[{role:'assistant',content:null,toolCalls:[{id:'open',name:'task_read',arguments:{}}]}]};
    if(kind==='duplicateLedger')(checkpoint.completed as Record<string,unknown>).conversation={...f.conversation,handledRequestIds:['older','older']};
    if(kind==='currentReplay')(checkpoint.completed as Record<string,unknown>).conversation={...f.conversation,handledRequestIds:['older','current']};
    if(kind==='unknownDelivery')(checkpoint.deliveries as Record<string,unknown>[])[0]!.status='unknown';
    if(kind==='missingCheckpoint')delete response.agentCoreProductivity;
    expect(()=>conversationFromOwnedBaseline(candidate)).toThrow();
  });
  it('does not use an unavailable candidate as an empty baseline',async()=>{
    const f=fixture();f.rpc.mockResolvedValueOnce({data:null as never,error:null});
    await expect(f.capture()).rejects.toMatchObject({code:'OWNED_BASELINE_UNAVAILABLE'});expect(f.rpc).toHaveBeenCalledOnce();
  });
  it('rejects a forged stored conversation even when its metadata matches',async()=>{
    const f=fixture();f.rpc.mockImplementationOnce(async()=>({data:f.candidate,error:null}));
    f.rpc.mockImplementationOnce(async()=>({data:{version:1,id,candidate:f.candidate,conversation:{...f.conversation,history:[]}},error:null}));
    await expect(f.capture()).rejects.toMatchObject({code:'OWNED_BASELINE_RECEIPT_MISMATCH'});
  });
  it('requires capture capability and matching thread before storing anything',async()=>{
    const f=fixture();f.context.capabilities=new Set();await expect(f.capture()).rejects.toMatchObject({code:'OWNED_BASELINE_ACCESS_DENIED'});expect(f.rpc).not.toHaveBeenCalled();
    f.context.capabilities=new Set(['agent_core.baseline.capture']);f.candidate.threadId='foreign';f.candidate.prior.thread_id='foreign';
    await expect(f.capture()).rejects.toMatchObject({code:'OWNED_BASELINE_OWNER_MISMATCH'});expect(f.rpc).toHaveBeenCalledOnce();
  });
  it('stops an uncooperative RPC promptly on cancellation',async()=>{
    const f=fixture(),controller=new AbortController();f.context.signal=controller.signal;f.rpc.mockImplementation(()=>new Promise(()=>{}));
    const result=f.capture();await vi.waitFor(()=>expect(f.rpc).toHaveBeenCalledOnce());controller.abort(new Error('cancelled'));
    await expect(result).rejects.toThrow('cancelled');expect(f.rpc).toHaveBeenCalledOnce();
  });
  it.each(['valid','marker','conversation','foreignRun','missing'])('validates persisted recovery baseline %s',async kind=>{
    const f=fixture(),recoveryId='00000000-0000-4000-8000-000000000005';
    const action={callId:'a',domain:'task',action:'delete',targetId:id,targetName:'Tarea',payload:{action:'delete',target:id},status:'skipped',executionFact:null};
    const snapshot={runId:run,userId:user,threadId:'thread',status:'waiting_for_approval',expiresAtIso:'2026-10-11T20:00:00Z',actions:[action],executionState:{kind:'generic_operation',context:{},waitingFor:null}};
    const hash=checkpointFingerprint;
    const source=activeRunRecoverySnapshotSchema.parse({anchor:{id:recoveryId,message_id:'next',thread_id:'thread',sequence_id:11},
      prior:{id:owner,message_id:'current',thread_id:'thread',sequence_id:10,status:'unknown',response:{agentCoreBaseline:{version:1,baselineId:id,candidateFingerprint:hash(jsonObjectSchema.parse(f.candidate))},
        agentCoreActiveRun:{version:1,stage:'final',runId:run,userId:user,inboundRunId:owner,requestId:'current',claimId:id,snapshot,decision:{},result:{success:false,status:'cancelled'}}}},
      run:{id:run,user_id:user,thread_id:'thread',status:'cancelled',kind:'generic_operation',context:{},waiting_for:null,expires_at:snapshot.expiresAtIso},actions:[action]});
    const context={...f.context,runId:recoveryId,requestId:'next',capabilities:new Set(['agent_core.reconcile'])};
    const lease={...f.lease,inboundTurn:{...f.lease.inboundTurn,id:recoveryId,messageId:'next'}};
    const receipt={version:1,id,candidate:structuredClone(f.candidate),conversation:structuredClone(f.conversation)};
    if(kind==='marker')(source.prior.response.agentCoreBaseline as Record<string,unknown>).candidateFingerprint='f'.repeat(64);
    if(kind==='conversation')receipt.conversation.history=[];
    if(kind==='foreignRun')receipt.candidate.activeRunId=id;
    f.rpc.mockResolvedValueOnce({data:kind==='missing'?null:receipt,error:null} as never);
    const api=createOwnedBaseline({rpc:f.rpc},{id:recoveryId,token:'recovery-private'});
    const read=withTurnLease(lease,()=>api.baseline(source,context));
    if(kind==='valid')expect(await read).toMatchObject({userId:user,conversation:f.conversation});
    else await expect(read).rejects.toThrow();
  });
  it('blocks baseline markers at other engine admission but allows one active-run claim',()=>{
    const f=fixture(),lease={...f.lease,inboundTurn:{...f.lease.inboundTurn,response:{agentCoreBaseline:{version:1}}}};
    expect(()=>claimAgentCoreLease(lease)).toThrow('Inbound turn requires reconciliation');
    claimAgentCoreLease(lease,'active_run');expect(()=>claimAgentCoreLease(lease,'active_run')).toThrow('Inbound turn requires reconciliation');
  });
  it('composes only actual recovery ports and preserves explicit absence without model calls',async()=>{
    const f=fixture();f.context.capabilities=new Set(['agent_core.reconcile','agent_core.handoff']);
    const rpc=vi.fn(async()=>({data:{absent:true},error:null}));const runtime=createActiveRunRecoveryRuntime({rpc},{id:owner,token:'private'});
    expect(await withTurnLease(f.lease,()=>runtime.recover(f.context,'thread'))).toBeNull();
    expect(rpc).toHaveBeenCalledOnce();expect(rpc.mock.calls[0]).toBeDefined();
  });
});
