import { describe, it, expect, vi } from 'vitest';
import { jsonObjectSchema, type SuspendedRunSnapshot, type ApprovalDecision, type JsonObject } from '@templelabs/contracts';
import { createActiveRunTurnRuntime } from '../../../src/adapters/agent-core/active-run-turn-runtime.js';
import { validateActiveTurnCompletion, recoverActiveTurnCompletion, createActiveTurnFinalizer } from '../../../src/adapters/agent-core/active-turn-completion.js';
import { createOwnedBaseline } from '../../../src/adapters/agent-core/owned-baseline.js';
import { checkpointFingerprint } from '../../../src/adapters/agent-core/checkpoint-fingerprint.js';
import { withTurnLease } from '../../../src/agent/core/turn-lease.js';
import type { ActiveRunDecisionResult } from '../../../src/adapters/agent-core/active-run-ai-decision.js';
const user='00000000-0000-4000-8000-000000000001', owner='00000000-0000-4000-8000-000000000002', run='00000000-0000-4000-8000-000000000003', target='00000000-0000-4000-8000-000000000004';
function fixture() {
  const context={turn:{userId:user,runId:owner,requestId:'current',timezone:'America/Bogota',language:'es' as const,referenceTimeIso:new Date().toISOString(),capabilities:new Set(['agent_core.baseline.capture','agent_core.atomic_tasks','agent_core.delivery','agent_core.turn.finalize']),signal:new AbortController().signal},
    threadId:'thread',currentUserText:'Sí, elimina esa tarea',user:{id:user},deadlineMs:Date.now()+30000,authorizeWrite:vi.fn(async()=>true)};
  const snapshot:SuspendedRunSnapshot={runId:run,userId:user,threadId:'thread',status:'waiting_for_approval',expiresAtIso:new Date(Date.now()+60000).toISOString(),executionState:{kind:'generic_operation',context:{},waitingFor:null},
    actions:[{callId:'a',domain:'task',action:'delete',targetId:target,targetName:'Tarea',payload:{action:'delete',target},status:'prepared',executionFact:null}]};
  const planned={status:'success' as const,decision:{relation:'approval',decision:'approve_all',selectedCallIds:[],reply:'Prose ignored'} as ApprovalDecision,suggestedCallIds:[],usage:{inputTokens:1,outputTokens:1},
    binding:{runId:run,userId:user,threadId:'thread',inboundRunId:owner,requestId:'current',freshness:'snapshot' as const,grantsExecution:false as const,snapshotFingerprint:checkpointFingerprint(jsonObjectSchema.parse(snapshot))}} satisfies ActiveRunDecisionResult<ApprovalDecision>;
  const lease={inboundTurn:{id:owner,messageId:'current',threadId:'thread',response:{}},signal:new AbortController().signal,assertActive:vi.fn(async()=>{}),checkpoint:vi.fn(async()=>{})};
  const rpc=vi.fn(async(_name:string,_args:JsonObject):Promise<{data:unknown;error:unknown}>=>({data:null,error:null}));
  const transport={validate:vi.fn(),send:vi.fn(async()=>({messageId:'provider'}))};
  const runtime=createActiveRunTurnRuntime({rpc},{id:owner,token:'private'},transport);
  const apply=()=>withTurnLease(lease,()=>runtime.apply(snapshot,planned,context,async()=>true));
  const rebind=()=>{planned.binding={...planned.binding,snapshotFingerprint:checkpointFingerprint(jsonObjectSchema.parse(snapshot))};};
  return{context,snapshot,planned,lease,rpc,transport,runtime,apply,rebind};
}

function acceptComposition(f:ReturnType<typeof fixture>) {
  const operations:string[]=[];
  const candidate={version:1,userId:user,inboundRunId:owner,activeRunId:run,requestId:'current',threadId:'thread',sequenceId:1,prior:null};
  let manifest:Record<string,unknown>;
  let baselineSaved:unknown;
  const receiptSaved:unknown[]=[];
  f.rpc.mockImplementation(async(name,args)=>{
    operations.push(name+':'+String(args.p_operation??''));
    const payload=args.p_payload as JsonObject;
    if(name==='access_hermes_owned_baseline'){ baselineSaved={version:1,id:target,candidate,input:payload.input,conversation:{userId:user,history:[],tasks:[],reminders:[],events:[],handledRequestIds:[]}};return{data:args.p_operation==='candidate'?candidate:baselineSaved,error:null}; }
    if(name==='claim_hermes_active_run')return{data:{claimId:target,snapshot:f.snapshot,status:args.p_next_status},error:null};
    if(name==='mutate_hermes_active_run') {
      if(args.p_operation==='action') {
        const expected=payload.expected as JsonObject,updates=payload.updates as JsonObject;
        return{data:{id:target,run_id:run,call_id:expected.callId,domain:expected.domain,action:expected.action,target_id:expected.targetId,target_name:expected.targetName,
          payload:updates.payload??expected.payload,status:updates.status,execution_fact:updates.executionFact??null,created_at:new Date().toISOString(),executed_at:null},error:null};
      }
      if(args.p_operation==='run')return{data:{id:run,user_id:user,thread_id:'thread',status:payload.status},error:null};
      return{data:{},error:null};
    }
    if(name==='execute_hermes_atomic_task') {
      expect(operations).toContain('mutate_hermes_active_run:action');
      const action=f.snapshot.actions[0]!.action;
      const data={version:1,receiptId:target,userId:user,activeRunId:run,inboundRunId:owner,claimId:target,threadId:'thread',callId:'a',targetId:target,domainCall:args.p_call,companionReminderIds:[],
        item:{domain:'tasks',callId:'a',toolName:`task_${action}`,status:'success',code:null,result:{operation:action,complete:true,coverage:'operation',issues:[],flow:null,
          records:[{id:target,title:'Tarea verificada',description:null,priority:null,status:action==='delete'?'deleted':'completed',dueDateIso:null,entityId:null,entityName:null}],presentation:{canonicalCard:null,questions:[],cta:null}}},
        legacyResult:{success:true,complete:true,action:action==='delete'?'deleted_task':'completed_task',data:{id:target,title:'Tarea verificada'}}};
      receiptSaved.push(data);return{data,error:null};
    }
    if(name==='access_hermes_delivery_manifest') {
      if(args.p_operation==='seal')manifest={...payload.draft as JsonObject,id:target};
      const entry=(manifest.entries as Record<string,unknown>[])[0]!;
      if(args.p_operation==='attempt')entry.state='attempted';
      if(args.p_operation==='accept'){entry.state='accepted';entry.providerMessageId=payload.providerMessageId;}
      return{data:structuredClone(manifest!),error:null};
    }
    if(name==='read_hermes_active_turn_completion')return{data:{baseline:baselineSaved,manifest,receipts:receiptSaved,sourceResponse:{...manifest!.sourceResponse as JsonObject,agentCoreDeliveryManifest:{version:1,manifestId:manifest!.id,sourceFingerprint:checkpointFingerprint(manifest!.sourceResponse as JsonObject)}}},error:null};
    if(name==='finish_hermes_active_turn')return{data:true,error:null};
    throw new Error('Unexpected RPC');
  });
  return operations;
}
describe('owned approval execution and deterministic delivery composition',()=>{
  it.each(['delete','complete'] as const)('composes %s receipt cards and one ordered accepted delivery',async action=>{
    const f=fixture();f.snapshot.actions[0]!.action=action;f.snapshot.actions[0]!.payload={action,target};f.rebind();const operations=acceptComposition(f);
    const result=await f.apply();expect(result.status).toBe('completed');
    if(result.status==='completed'){expect(result.reply.text).toContain('Tarea verificada');expect(result.reply.text).not.toContain('Prose ignored');expect(result.manifest.entries[0]!.state).toBe('accepted');expect(result.conversation.history.map(message=>message.content)).toEqual(['Sí, elimina esa tarea',result.reply.text]);}
    expect(f.context.authorizeWrite).toHaveBeenCalledOnce();expect(f.transport.send).toHaveBeenCalledOnce();expect(f.lease.checkpoint).not.toHaveBeenCalled();
    expect(operations.indexOf('mutate_hermes_active_run:finish')).toBeLessThan(operations.indexOf('access_hermes_delivery_manifest:seal'));
  });
  it('cancels without invoking the task executor and delivers a deterministic cancellation',async()=>{
    const f=fixture();f.planned.decision={relation:'cancel',decision:null,selectedCallIds:[],reply:'ignored'};const operations=acceptComposition(f);
    const result=await f.apply();expect(result.status).toBe('completed');if(result.status==='completed')expect(result.reply.text).toContain('Cancelado');
    expect(operations.some(op=>op.startsWith('execute_hermes_atomic_task'))).toBe(false);expect(f.context.authorizeWrite).not.toHaveBeenCalled();expect(f.transport.send).toHaveBeenCalledOnce();
  });
  it.each(['foreignOwner','foreignBinding','continuation','unresolved','batch','unsupportedDomain','capability','expired','invalidTimezone','profile','invalidCallId','markedSnapshot'])('rejects %s before baseline persistence',async kind=>{
    const f=fixture();
    if(kind==='foreignOwner')f.context.user.id=target;
    if(kind==='foreignBinding')f.planned.binding={...f.planned.binding,requestId:'foreign'};
    if(kind==='continuation')f.snapshot.status='waiting_for_input';
    if(kind==='unresolved')f.snapshot.actions[0]!.payload={action:'delete',target:'Tarea'};
    if(kind==='batch')f.snapshot.actions[0]!.payload={action:'delete',taskIds:[target]};
    if(kind==='unsupportedDomain')f.snapshot.actions[0]!.domain='calendar';
    if(kind==='capability')f.context.turn.capabilities.clear();
    if(kind==='expired')f.context.deadlineMs=Date.now()-1;
    if(kind==='invalidTimezone')f.context.turn.timezone='not-a-timezone';
    if(kind==='invalidCallId')f.snapshot.actions[0]!.callId='invalid call';
    if(kind==='markedSnapshot')f.snapshot.executionState!.context._agentCoreClaim={};
    if(kind==='profile' && f.planned.status==='success')f.planned.decision={...f.planned.decision,profileUpdate:{field:'name',value:'Foreign',sourceQuote:'Foreign'}} as ApprovalDecision;
    if(kind!=='foreignBinding')f.rebind();
    await expect(f.apply()).rejects.toThrow();expect(f.rpc).not.toHaveBeenCalled();expect(f.transport.send).not.toHaveBeenCalled();
  });
  it('does not persist or send for an unrelated decision or refusal',async()=>{
    const f=fixture();if(f.planned.status==='success')f.planned.decision={relation:'unrelated',decision:null,selectedCallIds:[],reply:null};
    expect(await f.apply()).toEqual({status:'no_action'});expect(f.rpc).not.toHaveBeenCalled();
    const refused={...f.planned,status:'refused' as const,decision:null,suggestedCallIds:[] as const};
    expect(await withTurnLease(f.lease,()=>f.runtime.apply(f.snapshot,refused,f.context,async()=>true))).toEqual({status:'no_action'});
  });
  it('does not retry baseline failure, even when called again with the same proposal',async()=>{
    const f=fixture();await expect(f.apply()).rejects.toThrow('OWNED_BASELINE_UNAVAILABLE');
    await expect(f.apply()).rejects.toThrow('ACTIVE_TURN_REPLAY_FORBIDDEN');expect(f.rpc).toHaveBeenCalledOnce();expect(f.transport.send).not.toHaveBeenCalled();
  });
  it('admits only one simultaneous invocation on the same constructed owner',async()=>{
    const f=fixture();const results=await Promise.allSettled([f.apply(),f.apply()]);
    expect(results.every(result=>result.status==='rejected')).toBe(true);expect(f.rpc).toHaveBeenCalledOnce();
    expect(results.some(result=>result.status==='rejected' && result.reason.code==='ACTIVE_TURN_REPLAY_FORBIDDEN')).toBe(true);
  });
  it('bounds an uncooperative baseline RPC and does not dispatch after cancellation',async()=>{
    const f=fixture(),controller=new AbortController();f.context.turn.signal=controller.signal;f.rpc.mockImplementation(()=>new Promise(()=>{}));
    const pending=f.apply();await vi.waitFor(()=>expect(f.rpc).toHaveBeenCalledOnce());controller.abort(new Error('stop'));
    await expect(pending).rejects.toThrow('stop');expect(f.transport.send).not.toHaveBeenCalled();
  });
});

async function savedCompletion() {
  const f=fixture();acceptComposition(f);const result=await f.apply();
  if(result.status!=='completed')throw new Error('Expected completed fixture');
  const row={id:owner,message_id:'current',thread_id:'thread',sequence_id:1,status:'completed',response:{...result.completion.sourceResponse,agentCoreActiveCompletion:result.completion}};
  return{...f,result,row};
}
describe('atomic completed turn history',()=>{
  it('imports the exact accepted exchange and preserves it as the next owned baseline',async()=>{
    const f=await savedCompletion();expect(recoverActiveTurnCompletion(f.row,user)).toEqual(f.result.conversation);
    const nextId='00000000-0000-4000-8000-000000000005',nextRun='00000000-0000-4000-8000-000000000006';
    const context={...f.context.turn,runId:nextId,requestId:'next'};
    const candidate={version:1,userId:user,inboundRunId:nextId,activeRunId:nextRun,requestId:'next',threadId:'thread',sequenceId:2,prior:f.row};
    const rpc=vi.fn(async(_name:string,args:JsonObject)=>({data:args.p_operation==='candidate'?candidate:{version:1,id:target,candidate,conversation:f.result.conversation},error:null}));
    const lease={...f.lease,inboundTurn:{...f.lease.inboundTurn,id:nextId,messageId:'next'}};
    const captured=await withTurnLease(lease,()=>createOwnedBaseline({rpc},{id:nextId,token:'new-private'}).capture(nextRun,context));
    expect(captured.conversation.history).toHaveLength(2);expect(captured.conversation.handledRequestIds).toEqual(['current']);
  });
  it.each(['input','assistant','prefix','record','receipt','source','fingerprint','duplicateHandled','currentReplay','foreignRun','claimed'])('rejects altered %s completion history',async kind=>{
    const f=await savedCompletion(),value=structuredClone(f.result.completion);
    if(kind==='input')value.baseline.input.userText='Forged';
    if(kind==='assistant')value.conversation.history.at(-1)!.content='Forged';
    if(kind==='prefix')value.baseline.conversation.history.push({role:'user',content:'Forged history'});
    if(kind==='record')value.conversation.tasks[0]!.title='Forged';
    if(kind==='receipt')value.receipts[0]!.domainCall.params.target=user;
    if(kind==='source')value.sourceResponse.changed=true;
    if(kind==='fingerprint')value.sourceFingerprint='f'.repeat(64);
    if(kind==='duplicateHandled')value.conversation.handledRequestIds.push('current');
    if(kind==='currentReplay')value.baseline.conversation.handledRequestIds.push('current');
    if(kind==='foreignRun')value.baseline.activeRunId=user;
    if(kind==='claimed')(value.sourceResponse.agentCoreActiveRun as JsonObject).stage='claimed';
    expect(()=>validateActiveTurnCompletion(value)).toThrow();
  });
  it.each(['unknown','sequence','thread','user'])('rejects %s row ownership when importing a completion',async kind=>{
    const f=await savedCompletion();const row={...f.row};let expectedUser=user;
    if(kind==='unknown')row.status='unknown';
    if(kind==='sequence')row.sequence_id=99;
    if(kind==='thread')row.thread_id='foreign';
    if(kind==='user')expectedUser=target;
    expect(()=>recoverActiveTurnCompletion(row,expectedUser)).toThrow();
  });
  it('does not reassert a retired lease after acknowledged finalization',async()=>{
    const f=await savedCompletion();let retired=false;
    f.lease.assertActive.mockImplementation(async()=>{if(retired)throw new Error('retired');});
    const rpc=vi.fn(async()=>{retired=true;return{data:true,error:null};});
    const finalizer=createActiveTurnFinalizer({rpc},{id:owner,token:'private'});
    expect(await withTurnLease(f.lease,()=>finalizer.finish(f.result.completion,f.context.turn))).toEqual(f.result.conversation);
    expect(rpc).toHaveBeenCalledOnce();
  });
  it('bounds an uncooperative finalization RPC without retrying after cancellation',async()=>{
    const f=await savedCompletion(),controller=new AbortController();
    const rpc=vi.fn(()=>new Promise<{data:unknown;error:unknown}>(()=>{}));
    const finalizer=createActiveTurnFinalizer({rpc},{id:owner,token:'private'});
    const result=withTurnLease(f.lease,()=>finalizer.finish(f.result.completion,{...f.context.turn,signal:controller.signal}));
    await vi.waitFor(()=>expect(rpc).toHaveBeenCalledOnce());controller.abort(new Error('cancelled'));
    await expect(result).rejects.toThrow('cancelled');expect(rpc).toHaveBeenCalledOnce();
  });
  it('reports a lost finalization reply as uncertain while the persisted completion stays recoverable',async()=>{
    const f=await savedCompletion();const rpc=vi.fn(async()=>{throw new Error('Lost committed reply');});
    const finalizer=createActiveTurnFinalizer({rpc},{id:owner,token:'private'});
    await expect(withTurnLease(f.lease,()=>finalizer.finish(f.result.completion,f.context.turn))).rejects.toThrow('ACTIVE_COMPLETION_STORAGE_UNCERTAIN');
    expect(recoverActiveTurnCompletion(f.row,user)).toEqual(f.result.conversation);expect(rpc).toHaveBeenCalledOnce();
  });
});
