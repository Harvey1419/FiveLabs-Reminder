import { describe, it, expect, vi } from 'vitest';
import { atomicTaskReceiptSchema, activeRunRecoverySnapshotSchema, type JsonObject, type TurnContext } from '@templelabs/contracts';
import { createAtomicTaskExecutor, createAtomicTaskEffectSource } from '../../../src/adapters/agent-core/atomic-task-executor.js';
import { withTurnLease } from '../../../src/agent/core/turn-lease.js';
const userId = '00000000-0000-4000-8000-000000000001', ownerId = '00000000-0000-4000-8000-000000000002', target = '00000000-0000-4000-8000-000000000003';
function fixture(action: 'complete' | 'delete' = 'complete') {
  const domainCall = { toolName: 'manage_task' as const, params: { action, target } };
  const receipt = atomicTaskReceiptSchema.parse({ version: 1, receiptId: target, userId, activeRunId: userId, inboundRunId: ownerId, claimId: userId,
    threadId: 'thread', callId: 'a', targetId: target, domainCall, companionReminderIds: [],
    item: { domain: 'tasks', callId: 'a', toolName: `task_${action}`, status: 'success', code: null, result: { operation: action, complete: true, coverage: 'operation', issues: [], flow: null,
      records: [{ id: target, title: 'Tarea', description: null, priority: 'medium', status: action === 'complete' ? 'completed' : 'deleted', dueDateIso: null, entityId: null, entityName: null }],
      presentation: { canonicalCard: null, questions: [], cta: null } } },
    legacyResult: { success: true, complete: true, action: action === 'complete' ? 'completed_task' : 'deleted_task', data: { id: target, title: 'Tarea' } },
  });
  const context: TurnContext = { userId, runId: ownerId, requestId: 'message', language: 'es', timezone: 'America/Bogota', referenceTimeIso: '2026-10-12T01:00:00Z',
    capabilities: new Set(['agent_core.atomic_tasks']), signal: new AbortController().signal };
  const lease = { inboundTurn: { id: ownerId, messageId: 'message', threadId: 'thread', response: {} }, signal: new AbortController().signal,
    assertActive: vi.fn(async () => {}), checkpoint: vi.fn(async () => {}) };
  const rpc = vi.fn(async (_name: string, _args: JsonObject): Promise<{ data: unknown; error: unknown }> => ({ data: structuredClone(receipt), error: null }));
  const authorize = vi.fn(async () => true), owner = { id: ownerId, token: 'private' };
  const execute = createAtomicTaskExecutor({ rpc }, owner, context, authorize);
  const call = { ...domainCall, user: { id: userId } };
  return { receipt, context, lease, rpc, authorize, owner, execute, call, run: () => withTurnLease(lease, () => execute(call)) };
}
describe('owned atomic task mutation executor', () => {
  it.each(['complete','delete'] as const)('returns the canonical %s result only from a bound durable receipt', async action => {
    const f = fixture(action); expect(await f.run()).toEqual(f.receipt.legacyResult);
    expect(f.rpc.mock.calls[0]).toEqual(['execute_hermes_atomic_task', { p_owner_id: ownerId, p_owner_token: 'private', p_user_id: userId, p_call: { toolName: 'manage_task', params: { action, target } } }]);
    expect(f.authorize).toHaveBeenCalledOnce(); expect(f.lease.assertActive).toHaveBeenCalledTimes(3);
  });
  it('exposes only a detached, validated transaction receipt to the composed presenter',async()=>{
    const f=fixture(),observe=vi.fn(receipt=>{receipt.legacyResult.success=false;receipt.item.callId='changed';});
    const execute=createAtomicTaskExecutor({rpc:f.rpc},f.owner,f.context,f.authorize,observe);
    expect(await withTurnLease(f.lease,()=>execute(f.call))).toEqual(f.receipt.legacyResult);expect(observe).toHaveBeenCalledOnce();
    const invalid=fixture();invalid.receipt.inboundRunId=target;
    const rejected=createAtomicTaskExecutor({rpc:invalid.rpc},invalid.owner,invalid.context,invalid.authorize,observe);
    await expect(withTurnLease(invalid.lease,()=>rejected(invalid.call))).rejects.toThrow();expect(observe).toHaveBeenCalledOnce();
  });
  it('requires host authorization before any mutation RPC', async () => {
    const f = fixture(); f.authorize.mockResolvedValue(false);
    await expect(f.run()).rejects.toThrow('ATOMIC_TASK_ACCESS_DENIED'); expect(f.rpc).not.toHaveBeenCalled();
  });
  it.each(['name','batch','extra'] as const)('rejects unsupported %s targets without a fallback', async kind => {
    const f = fixture(), params = kind === 'name' ? { action: 'complete', target: 'Tarea' } : kind === 'batch' ? { action: 'complete', taskIds: [target] } : { ...f.call.params, all: true };
    await expect(withTurnLease(f.lease, () => f.execute({ ...f.call, params }))).rejects.toThrow(); expect(f.rpc).not.toHaveBeenCalled();
  });
  it('rejects a foreign caller and changed current lease identity', async () => {
    const f = fixture(); f.call.user.id = target; await expect(f.run()).rejects.toThrow('ATOMIC_TASK_OWNER_MISMATCH'); expect(f.rpc).not.toHaveBeenCalled();
    const second = fixture(); second.lease.inboundTurn.messageId = 'foreign'; await expect(second.run()).rejects.toThrow('ATOMIC_TASK_OWNER_MISMATCH'); expect(second.rpc).not.toHaveBeenCalled();
  });
  it.each(['owner','thread','target','partial'] as const)('rejects a mismatched %s receipt after the RPC', async kind => {
    const f = fixture();
    if (kind === 'owner') f.receipt.inboundRunId = target;
    if (kind === 'thread') f.receipt.threadId = 'foreign';
    if (kind === 'target') f.receipt.targetId = userId;
    if (kind === 'partial') f.receipt.legacyResult.success = false;
    await expect(f.run()).rejects.toThrow();
  });
  it('captures private ownership and does not retry an indeterminate RPC outcome', async () => {
    const f = fixture(); f.owner.token = 'changed'; f.rpc.mockRejectedValue(new Error('secret'));
    await expect(f.run()).rejects.toThrow('ATOMIC_TASK_STORAGE_UNCERTAIN'); expect(f.rpc).toHaveBeenCalledOnce(); expect(f.rpc.mock.calls[0]![1].p_owner_token).toBe('private');
  });
  it('rejects non-admission without calling another executor', async () => {
    const f = fixture(); f.rpc.mockResolvedValue({ data: null, error: null }); await expect(f.run()).rejects.toThrow('ATOMIC_TASK_NOT_ADMITTED');
  });
  it('rejects a legacy success result for a different action or resource', async () => {
    const f = fixture(); f.receipt.legacyResult.action = 'deleted_task'; await expect(f.run()).rejects.toThrow();
    f.receipt.legacyResult.action = 'completed_task'; f.receipt.legacyResult.data = { id: userId }; await expect(f.run()).rejects.toThrow();
  });
  it('derives applied proof only from an owned transaction-linked receipt, never absence', async () => {
    const f = fixture(), prior = '00000000-0000-4000-8000-000000000004';
    const action = { callId: 'a', domain: 'task', action: 'complete', targetId: target, targetName: 'Tarea', payload: f.call.params, status: 'prepared', executionFact: null };
    const snapshot = { runId: f.receipt.activeRunId, userId, threadId: 'thread', status: 'waiting_for_approval', expiresAtIso: '2026-10-11T20:00:00Z',
      executionState: { kind: 'generic_operation', context: {}, waitingFor: null }, actions: [action] };
    const fact = { success: false, outcome: 'unknown', _domainCall: f.receipt.domainCall };
    const source = activeRunRecoverySnapshotSchema.parse({ anchor: { id: ownerId, message_id: 'message', thread_id: 'thread', sequence_id: 10 },
      prior: { id: prior, message_id: 'old-message', thread_id: 'thread', sequence_id: 1, status: 'unknown', response: { agentCoreActiveRun: {
        version: 1, stage: 'claimed', runId: snapshot.runId, userId, inboundRunId: prior, requestId: 'old-message', claimId: f.receipt.claimId, snapshot, decision: {}, actions: { a: {
          id: target, run_id: snapshot.runId, call_id: 'a', domain: 'task', action: 'complete', target_id: target, target_name: 'Tarea', payload: f.call.params,
          status: 'failed', execution_fact: fact, created_at: '2026-10-11T19:00:00Z', executed_at: null,
        } },
      } } },
      run: { id: snapshot.runId, user_id: userId, thread_id: 'thread', status: 'running', kind: 'generic_operation', expires_at: snapshot.expiresAtIso,
        context: { _agentCoreClaim: { claimId: f.receipt.claimId, ownerId: prior, source: snapshot } }, waiting_for: null },
      actions: [{ ...action, status: 'failed', executionFact: fact }],
    });
    const read = createAtomicTaskEffectSource({ rpc: f.rpc }, f.owner), context = { ...f.context, capabilities: new Set(['agent_core.reconcile']) };
    const lookup = () => withTurnLease(f.lease, () => read(source.actions[0]!, source, context));
    expect(await lookup()).toMatchObject({ outcome: 'applied', callId: 'a', coversCompanions: true, evidenceId: f.receipt.receiptId });
    f.rpc.mockResolvedValueOnce({ data: null, error: null }); await expect(lookup()).rejects.toThrow('ATOMIC_TASK_NOT_ADMITTED');
    f.receipt.activeRunId = target; await expect(lookup()).rejects.toThrow('ATOMIC_TASK_RECEIPT_MISMATCH');
  });
  it('does not accept a receipt after ownership loss or a stalled transport cancellation', async () => {
    const f = fixture(); f.lease.assertActive.mockResolvedValueOnce().mockResolvedValueOnce().mockRejectedValueOnce(new Error('LEASE_LOST'));
    await expect(f.run()).rejects.toThrow('LEASE_LOST');
    const stopped = fixture(), controller = new AbortController();
    const context = { ...stopped.context, signal: controller.signal };
    const execute = createAtomicTaskExecutor({ rpc: stopped.rpc }, stopped.owner, context, stopped.authorize);
    stopped.rpc.mockImplementation(async () => { controller.abort(new Error('cancelled')); return new Promise(() => {}); });
    await expect(withTurnLease(stopped.lease, () => execute(stopped.call))).rejects.toThrow('cancelled');
  });
});
