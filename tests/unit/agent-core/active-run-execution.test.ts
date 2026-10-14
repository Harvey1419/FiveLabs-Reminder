import { describe, expect, it, vi } from 'vitest';
import { type JsonObject, type SuspendedRunSnapshot, type ApprovalDecision, type ContinuationDecision, type TurnContext } from '@templelabs/contracts';
import { withTurnLease, type InboundTurnLease } from '../../../src/agent/core/turn-lease.js';
import { ActiveRunExecutionBridge, projectSuspendedAgentRun, type ActiveRunExecutionContext } from '../../../src/adapters/agent-core/active-run-execution.js';
import { createActiveRunStore, type ActiveRunStore } from '../../../src/adapters/agent-core/active-run-store.js';
import { checkpointFingerprint } from '../../../src/adapters/agent-core/checkpoint-fingerprint.js';
import type { ActiveRunDecisionResult } from '../../../src/adapters/agent-core/active-run-ai-decision.js';
import type { LegacyDomainExecutionCall } from '../../../src/agent/core/agent-run.js';

const instant = Date.parse('2026-10-11T19:00:00Z');
function snapshot(status: SuspendedRunSnapshot['status'] = 'waiting_for_approval'): SuspendedRunSnapshot {
  return projectSuspendedAgentRun({ id: 'suspended', user_id: 'owner', thread_id: 'thread', status, kind: 'generic_operation',
    context: { timezone: 'America/Bogota', referenceTime: new Date(instant).toISOString() }, waiting_for: null,
    expires_at: new Date(instant+60000).toISOString() }, ['first','second','done'].map(call_id => ({
      call_id, domain: 'task', action: 'delete', target_id: call_id, target_name: call_id,
      payload: { action: 'delete', taskIds: [call_id] }, status: call_id==='done' ? 'executed' : 'prepared',
      execution_fact: call_id==='done' ? { success: true } : null,
    })));
}
function context(runId = 'inbound', requestId = 'request'): ActiveRunExecutionContext {
  const turn: TurnContext = { runId, requestId, userId: 'owner', timezone: 'America/Bogota', language: 'es',
    referenceTimeIso: new Date(instant).toISOString(), capabilities: new Set(), signal: new AbortController().signal };
  return { turn, threadId: 'thread', user: { id: 'owner' }, currentUserText: 'La segunda', deadlineMs: instant+30000, now: () => instant,
    authorizeWrite: vi.fn(async () => true) };
}
function lease(ctx = context()): InboundTurnLease {
  return { inboundTurn: { id: ctx.turn.runId, messageId: ctx.turn.requestId, threadId: ctx.threadId, response: {} },
    signal: new AbortController().signal, assertActive: vi.fn(async () => {}), checkpoint: vi.fn(async () => {}) };
}
function decision(source: SuspendedRunSnapshot, ctx = context(), value: ApprovalDecision | ContinuationDecision = {
  relation: 'approval', decision: 'approve_subset', selectedCallIds: ['second'], reply: null,
}): ActiveRunDecisionResult<ApprovalDecision | ContinuationDecision> {
  return { status: 'success', decision: value, usage: { inputTokens: 1, outputTokens: 1 }, suggestedCallIds: [],
    binding: { runId: source.runId, userId: source.userId, threadId: source.threadId, inboundRunId: ctx.turn.runId, requestId: ctx.turn.requestId,
      freshness: 'snapshot', grantsExecution: false, snapshotFingerprint: checkpointFingerprint(source as unknown as JsonObject) } };
}
function fixture(source = snapshot()) {
  const records = new Map(source.actions.map(action => [action.callId, structuredClone(action)]));
  const operations: string[] = []; let claimed = false;
  const store: ActiveRunStore = {
    claim: vi.fn(async (expected, status) => {
      if (claimed || checkpointFingerprint(expected as unknown as JsonObject)!==checkpointFingerprint(source as unknown as JsonObject)) return null;
      claimed=true; operations.push('claim'); return { claimId: '00000000-0000-4000-8000-000000000001', snapshot: structuredClone(source), status };
    }),
    mutate: vi.fn(async (_claim, operation, payload) => {
      operations.push(operation);
      if (operation==='action') {
        const current = records.get(String(payload.callId))!;
        if (JSON.stringify(current)!==JSON.stringify(payload.expected)) throw new Error('ACTION_CAS_CONFLICT');
        const updates = payload.updates as JsonObject;
        const updated = { ...current, status: updates.status, payload: updates.payload ?? current.payload, executionFact: updates.executionFact ?? null };
        records.set(current.callId, updated as typeof current);
        return { run_id: source.runId, call_id: current.callId, domain: current.domain, action: current.action,
          target_id: current.targetId, target_name: current.targetName, payload: updated.payload, status: updated.status, execution_fact: updated.executionFact } as JsonObject;
      }
      if(operation==='run')return{id:source.runId,user_id:source.userId,thread_id:source.threadId,status:payload.status} as JsonObject;
      return {};
    }),
  };
  const execute = vi.fn(async (_call: LegacyDomainExecutionCall): Promise<JsonObject> => { operations.push('tool'); return { success: true, action: 'deleted', data: {}, rawSummary: 'Done' }; });
  return { store, records, operations, execute, bridge: new ActiveRunExecutionBridge(store,execute) };
}
describe('owned active-run execution bridge', () => {
  it('executes only the selected pending action with authorization and durable fence before dispatch', async () => {
    const source = snapshot(), ctx = context(), f = fixture(source);
    const result = await withTurnLease(lease(ctx), () => f.bridge.apply(source,decision(source,ctx),ctx));
    expect(result).toMatchObject({ success: true, executedCount: 1 }); expect(f.execute).toHaveBeenCalledTimes(1);
    expect(f.execute.mock.calls[0]?.[0]).toMatchObject({ user: { id: 'owner' }, params: { taskIds: ['second'] } });
    const toolIndex = f.operations.indexOf('tool'); expect(f.operations.slice(0,toolIndex)).toContain('action');
    expect(f.records.get('first')?.status).toBe('skipped'); expect(f.records.get('done')?.status).toBe('executed');
    expect(f.operations.at(-1)).toBe('finish'); expect(ctx.authorizeWrite).toHaveBeenCalledTimes(1);
  });
  it('approve_all expands to pending actions without repeating an executed action', async () => {
    const source=snapshot(),ctx=context(),f=fixture(source);
    await withTurnLease(lease(ctx),()=>f.bridge.apply(source,decision(source,ctx,{relation:'approval',decision:'approve_all',selectedCallIds:[],reply:null}),ctx));
    expect(f.execute).toHaveBeenCalledTimes(2); expect(f.records.get('done')?.status).toBe('executed');
  });
  it('uses the actual continuation schedule resolver and preserves prior confirmed actions', async () => {
    const source=snapshot('waiting_for_input'), ctx=context();
    source.actions=source.actions.filter(a=>a.callId!=='first');
    source.actions.find(a=>a.callId==='second')!.payload={domain:'reminder',action:'create',content:'Llamar',missingFields:['schedule']};
    source.actions.find(a=>a.callId==='second')!.domain='reminder'; source.actions.find(a=>a.callId==='second')!.action='create';
    const f=fixture(source);
    const result=await withTurnLease(lease(ctx),()=>f.bridge.apply(source,decision(source,ctx,{relation:'resume',suppliedFields:{},actionInputs:[{callId:'second',fields:{schedule:{kind:'relative_offset',offsetMinutes:0}}}],reply:null}),ctx));
    expect(result).toMatchObject({success:true});
    expect(f.execute.mock.calls[0]?.[0]).toMatchObject({toolName:'manage_reminder',params:{items:[{content:'Llamar',targetTime:new Date(instant).toISOString()}]}});
    expect(f.records.get('done')?.status).toBe('executed');
  });
  it.each(['waiting_for_approval','waiting_for_input'] as const)('cancels %s pending state without external effects or destroying prior evidence',async status=>{
    const source=snapshot(status),ctx=context(),f=fixture(source);
    const value: ApprovalDecision|ContinuationDecision=status==='waiting_for_approval'?{relation:'cancel',decision:null,selectedCallIds:[],reply:null}:{relation:'cancel',suppliedFields:{},reply:null};
    expect(await withTurnLease(lease(ctx),()=>f.bridge.apply(source,decision(source,ctx,value),ctx))).toMatchObject({status:'cancelled',executed:false});
    expect(f.execute).not.toHaveBeenCalled(); expect(f.records.get('done')?.status).toBe('executed');
  });
  it.each(['owner','thread','request','binding','missingMetadata','selection','failed'])('rejects %s before a database claim',async issue=>{
    const source=snapshot(),ctx={...context()},f=fixture(source);let planned=decision(source,ctx);
    if(issue==='owner')ctx.user={id:'foreign'};
    if(issue==='thread')ctx.threadId='foreign';
    if(issue==='request')planned={...planned,binding:{...planned.binding,requestId:'foreign'}};
    if(issue==='binding')source.actions[0]!.payload={changed:true};
    if(issue==='missingMetadata')delete source.executionState;
    if(issue==='selection' && planned.status==='success')planned={...planned,decision:{relation:'approval',decision:'approve_subset',selectedCallIds:['done'],reply:null}};
    if(issue==='failed'){source.actions[0]!.status='failed';planned={...planned,binding:{...planned.binding,snapshotFingerprint:checkpointFingerprint(source as unknown as JsonObject)}};}
    await expect(withTurnLease(lease(context()),()=>f.bridge.apply(source,planned,ctx))).rejects.toThrow();
    expect(f.store.claim).not.toHaveBeenCalled();expect(f.execute).not.toHaveBeenCalled();
  });
  it('stops a changed proposal at the atomic store comparison',async()=>{
    const source=snapshot(),ctx=context(),changed=structuredClone(source);changed.executionState!.context.timezone='UTC';
    const f=fixture(changed);
    expect(await withTurnLease(lease(ctx),()=>f.bridge.apply(source,decision(source,ctx),ctx))).toMatchObject({status:'not_acquired',executed:false});
    expect(f.execute).not.toHaveBeenCalled();
  });
  it('two independently leased arrivals cannot both acquire the same suspended run',async()=>{
    const source=snapshot(),first=context(),second=context('inbound-2','request-2'),f=fixture(source);
    const results=await Promise.all([withTurnLease(lease(first),()=>f.bridge.apply(source,decision(source,first),first)),withTurnLease(lease(second),()=>f.bridge.apply(source,decision(source,second),second))]);
    expect(results.filter(r=>r.success)).toHaveLength(1);expect(f.execute).toHaveBeenCalledTimes(1);
  });
  it('denied authorization occurs before any write fence or tool',async()=>{
    const source=snapshot(),ctx={...context(),authorizeWrite:async()=>false},f=fixture(source);
    await expect(withTurnLease(lease(ctx),()=>f.bridge.apply(source,decision(source,ctx,{relation:'approval',decision:'approve_all',selectedCallIds:[],reply:null}),ctx))).rejects.toThrow('ACTIVE_RUN_WRITE_DENIED');
    expect(f.execute).not.toHaveBeenCalled();expect(f.operations.filter(op=>op==='action')).toHaveLength(0);
  });
  it('missing fence receipt prevents external effects',async()=>{
    const source=snapshot(),ctx=context(),f=fixture(source),base=f.store.mutate;
    f.store.mutate=async(c,op,payload)=>{if(op==='action'&&(payload.updates as JsonObject).executionFact)throw new Error('FENCE_FAILED');return base(c,op,payload);};
    await expect(withTurnLease(lease(ctx),()=>f.bridge.apply(source,decision(source,ctx),ctx))).rejects.toThrow('FENCE_FAILED');expect(f.execute).not.toHaveBeenCalled();
  });
  it('rejects a storage response that claims success but did not store the exact fence',async()=>{
    const source=snapshot(),ctx=context(),f=fixture(source),base=f.store.mutate;
    f.store.mutate=async(c,op,payload)=>{const value=await base(c,op,payload);return op==='action'&&(payload.updates as JsonObject).executionFact?{...value,status:'prepared'}:value;};
    await expect(withTurnLease(lease(ctx),()=>f.bridge.apply(source,decision(source,ctx),ctx))).rejects.toThrow('INVALID_ACTIVE_RUN_WRITE_RECEIPT');expect(f.execute).not.toHaveBeenCalled();
  });
  it('expired execution budgets are blocked before any claim',async()=>{
    const source=snapshot(),ctx={...context(),deadlineMs:instant},f=fixture(source);
    await expect(withTurnLease(lease(ctx),()=>f.bridge.apply(source,decision(source,ctx),ctx))).rejects.toThrow('ACTIVE_RUN_EXECUTION_EXPIRED');expect(f.store.claim).not.toHaveBeenCalled();
  });
  it('unknown tool outcomes stop later writes and demand reconciliation',async()=>{
    const source=snapshot(),ctx=context(),f=fixture(source);
    f.execute.mockRejectedValue(new Error('lost receipt'));
    await expect(withTurnLease(lease(ctx),()=>f.bridge.apply(source,decision(source,ctx,{relation:'approval',decision:'approve_all',selectedCallIds:[],reply:null}),ctx))).rejects.toThrow('ACTIVE_RUN_RECONCILIATION_REQUIRED');
    expect(f.execute).toHaveBeenCalledTimes(1);expect(f.records.get('first')?.executionFact?.outcome).toBe('unknown');
  });
  it('blocks a foreign checkpoint namespace on the inbound lease',async()=>{
    const source=snapshot(),ctx=context(),f=fixture(source),l=lease(ctx);
    l.inboundTurn.response.agentCoreActiveRun={version:1};
    await expect(withTurnLease(l,()=>f.bridge.apply(source,decision(source,ctx),ctx))).rejects.toMatchObject({code:'INBOUND_RECONCILIATION_REQUIRED'});expect(f.store.claim).not.toHaveBeenCalled();
  });
  it('lost lease after authorization prevents a write',async()=>{
    const source=snapshot(),ctx={...context()},f=fixture(source),l=lease(ctx);let lost=false;
    l.assertActive=async()=>{if(lost)throw new Error('LEASE_LOST');};ctx.authorizeWrite=async()=>{lost=true;return true;};
    await expect(withTurnLease(l,()=>f.bridge.apply(source,decision(source,ctx),ctx))).rejects.toThrow('LEASE_LOST');expect(f.execute).not.toHaveBeenCalled();
  });
  it('rejects forbidden canonical continuation fields independently of the decision adapter',async()=>{
    const source=snapshot('waiting_for_input'),ctx=context(),f=fixture(source);
    await expect(withTurnLease(lease(ctx),()=>f.bridge.apply(source,decision(source,ctx,{relation:'resume',suppliedFields:{},actionInputs:[{callId:'second',fields:{domain:'admin'}}],reply:null}),ctx))).rejects.toThrow('INVALID_ACTIVE_RUN_DECISION');expect(f.store.claim).not.toHaveBeenCalled();
  });
  it('the RPC adapter fails closed without a storage fallback and binds the private owner token',async()=>{
    const rpc=vi.fn(async(_name:string,_args:JsonObject):Promise<{data:unknown;error:unknown}>=>({data:null,error:null}));
    const store=createActiveRunStore({rpc},{id:'inbound',token:'private-token'}),source=snapshot();
    expect(await store.claim(source,'running',{})).toBeNull();expect(rpc.mock.calls[0]?.[1]).toMatchObject({p_owner_id:'inbound',p_owner_token:'private-token'});
    rpc.mockResolvedValue({data:null,error:{message:'private diagnostic'}});
    await expect(store.claim(source,'running',{})).rejects.toThrow('ACTIVE_RUN_STORAGE_ERROR');expect(JSON.stringify(store)).not.toContain('private-token');
  });
});
