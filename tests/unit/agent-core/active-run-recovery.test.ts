import { describe, expect, it, vi } from 'vitest';
import { activeRunCheckpointSchema, type JsonObject, type TurnContext } from '@templelabs/contracts';
import { inspectActiveRunRecovery, createActiveRunRecoveryReader } from '../../../src/adapters/agent-core/active-run-recovery.js';
import { withTurnLease } from '../../../src/agent/core/turn-lease.js';

const claimId = '00000000-0000-4000-8000-000000000001';
function fixture(overrides: Partial<TurnContext> = {}) {
  const action = { callId: 'a', domain: 'task', action: 'delete', targetId: 'task', targetName: 'Tarea',
    payload: { action: 'delete', taskIds: ['task'] }, status: 'prepared' as const, executionFact: null };
  const source = { runId: 'suspended', userId: 'owner', threadId: 'thread', status: 'waiting_for_approval' as const,
    expiresAtIso: '2026-10-11T20:00:00Z', executionState: { kind: 'generic_operation' as const, context: { timezone: 'America/Bogota' }, waitingFor: null }, actions: [action] };
  const checkpoint = { version: 1 as const, stage: 'claimed' as const, runId: source.runId, userId: 'owner',
    inboundRunId: 'prior', requestId: 'prior-message', snapshot: source,
    decision: { relation: 'approval', decision: 'approve_all' }, claimId };
  const state = {
    anchor: { id: 'current', message_id: 'current-message', thread_id: 'thread', sequence_id: 10 },
    prior: { id: 'prior', message_id: 'prior-message', thread_id: 'thread', sequence_id: 1, status: 'unknown' as const,
      response: { agentCoreActiveRun: checkpoint, legacyMetadata: { retained: true } } as JsonObject },
    run: { id: source.runId, user_id: 'owner', thread_id: 'thread', status: 'running', kind: source.executionState.kind,
      context: { ...source.executionState.context, _agentCoreClaim: { claimId, ownerId: 'prior', source } } as JsonObject,
      waiting_for: null, expires_at: source.expiresAtIso },
    actions: [structuredClone(action)] as Array<Record<string, unknown>>,
  };
  const turn: TurnContext = { runId: 'current', requestId: 'current-message', userId: 'owner', language: 'es', timezone: 'America/Bogota',
    referenceTimeIso: '2026-10-12T20:00:00Z', capabilities: new Set(['agent_core.reconcile']), signal: new AbortController().signal, ...overrides };
  const lease = { inboundTurn: { id: turn.runId, messageId: turn.requestId, threadId: 'thread', response: {} },
    signal: new AbortController().signal, assertActive: vi.fn(async () => {}), checkpoint: vi.fn(async () => {}) };
  const rpc = vi.fn(async (_name: string, _args: JsonObject): Promise<{ data: unknown; error: unknown }> => ({ data: structuredClone(state), error: null }));
  const owner = { id: 'current', token: 'private-token' };
  const reader = createActiveRunRecoveryReader({ rpc }, owner);
  return { state, checkpoint, turn, lease, rpc, owner, reader, run: () => withTurnLease(lease, () => reader.load(turn, 'thread')) };
}
function fence(f: ReturnType<typeof fixture>, outcome = 'unknown') {
  const stored = { id: claimId, run_id: 'suspended', call_id: 'a', domain: 'task', action: 'delete', target_id: 'task',
    target_name: 'Tarea', payload: { action: 'delete', taskIds: ['task'] }, status: 'failed',
    execution_fact: { success: false, outcome, _domainCall: { toolName: 'manage_task', params: { action: 'delete', taskIds: ['task'] } } },
    created_at: '2026-10-11T19:00:00Z', executed_at: null };
  const checkpoint = { ...f.checkpoint, actions: { a: stored } };
  f.state.prior.response.agentCoreActiveRun = checkpoint;
  f.state.actions[0] = { ...f.state.actions[0], status: stored.status, executionFact: stored.execution_fact };
  return checkpoint;
}
describe('read-only active-run recovery', () => {
  it('retains expired historical evidence without granting replay or handoff', () => {
    const f = fixture(), before = structuredClone(f.state);
    expect(inspectActiveRunRecovery(f.state, 'owner', 'thread')).toMatchObject({ pendingCallIds: ['a'], verificationCallIds: [],
      grantsExecution: false, allowsHandoff: false, requiresDeliveryVerification: true });
    expect(f.state).toEqual(before);
  });
  it('identifies an unknown write fence, even when the run is already terminal', () => {
    const f = fixture(); fence(f); f.state.run.status = 'failed';
    expect(inspectActiveRunRecovery(f.state, 'owner', 'thread')).toMatchObject({ pendingCallIds: [], verificationCallIds: ['a'], unknownCallIds: ['a'] });
  });
  it('does not certify executed actions from a success receipt or final reply', () => {
    const f = fixture(), checkpoint = fence(f, 'success');
    checkpoint.actions.a.status = 'executed'; f.state.actions[0]!.status = 'executed';
    f.state.run.status = 'completed'; delete f.state.run.context._agentCoreClaim;
    f.state.prior.response.agentCoreActiveRun = { ...checkpoint, stage: 'final', result: { success: true, status: 'completed', reply: 'Listo' } };
    expect(inspectActiveRunRecovery(f.state, 'owner', 'thread')).toMatchObject({ verificationCallIds: ['a'], unknownCallIds: [], allowsHandoff: false });
  });
  it('reports omitted actions separately without interpreting them as executed', () => {
    const f = fixture(), checkpoint = fence(f);
    checkpoint.actions.a.status = 'skipped'; checkpoint.actions.a.execution_fact = null as never;
    f.state.actions[0]!.status = 'skipped'; f.state.actions[0]!.executionFact = null;
    expect(inspectActiveRunRecovery(f.state, 'owner', 'thread')).toMatchObject({ skippedCallIds: ['a'], verificationCallIds: [] });
  });
  it('compares PostgreSQL microseconds while accepting equivalent timestamp offsets', () => {
    const f = fixture(); f.checkpoint.snapshot.expiresAtIso = '2026-10-11T20:00:00.000001Z';
    f.state.run.expires_at = '2026-10-11T15:00:00.000001-05:00';
    expect(inspectActiveRunRecovery(f.state, 'owner', 'thread').pendingCallIds).toEqual(['a']);
    f.state.run.expires_at = '2026-10-11T20:00:00.000002Z';
    expect(() => inspectActiveRunRecovery(f.state, 'owner', 'thread')).toThrow('ACTIVE_RUN_RECOVERY_STATE_MISMATCH');
  });
  it.each(['user', 'thread', 'inbound', 'request', 'run', 'kind', 'context', 'expiry', 'claim', 'missingClaim', 'action', 'extra', 'duplicate', 'receiptTarget', 'version', 'finalStatus'])('rejects altered %s evidence', kind => {
    const f = fixture();
    if (kind === 'user') f.state.run.user_id = 'foreign';
    if (kind === 'thread') f.state.prior.thread_id = 'foreign';
    if (kind === 'inbound') f.checkpoint.inboundRunId = 'foreign';
    if (kind === 'request') f.checkpoint.requestId = 'foreign';
    if (kind === 'run') f.state.run.id = 'foreign';
    if (kind === 'kind') f.state.run.kind = 'task_mutation' as never;
    if (kind === 'context') f.state.run.context.timezone = 'UTC';
    if (kind === 'expiry') f.state.run.expires_at = '2026-10-11T21:00:00Z';
    if (kind === 'claim') (f.state.run.context._agentCoreClaim as JsonObject).ownerId = 'foreign';
    if (kind === 'missingClaim') delete f.state.run.context._agentCoreClaim;
    if (kind === 'action') f.state.actions[0]!.payload = { changed: true };
    if (kind === 'extra' || kind === 'duplicate') f.state.actions.push({ ...f.state.actions[0], callId: kind === 'extra' ? 'b' : 'a' });
    if (kind === 'receiptTarget') fence(f).actions.a.target_id = 'foreign';
    if (kind === 'version') (f.state.prior.response.agentCoreActiveRun as JsonObject).version = 2;
    if (kind === 'finalStatus') {
      delete f.state.run.context._agentCoreClaim;
      f.state.prior.response.agentCoreActiveRun = { ...f.checkpoint, stage: 'final', result: { success: true, status: 'completed' } };
    }
    expect(() => inspectActiveRunRecovery(f.state, 'owner', 'thread')).toThrow();
  });
  it.each(['agentCore', 'agentCoreProductivity', 'agentCoreResolution', 'agentCoreActiveResolution'])('rejects mixed %s namespaces', key => {
    const f = fixture(); f.state.prior.response[key] = {};
    expect(() => inspectActiveRunRecovery(f.state, 'owner', 'thread')).toThrow('ACTIVE_RUN_RECOVERY_ENGINE_MISMATCH');
  });
  it('requires complete execution metadata, known final status and per-action identity', () => {
    const f = fixture();
    expect(activeRunCheckpointSchema.safeParse({ ...f.checkpoint, snapshot: { ...f.checkpoint.snapshot, executionState: undefined } }).success).toBe(false);
    expect(activeRunCheckpointSchema.safeParse({ ...f.checkpoint, stage: 'final', result: {} }).success).toBe(false);
    const checkpoint = fence(f); checkpoint.actions.a.call_id = 'foreign';
    expect(activeRunCheckpointSchema.safeParse(checkpoint).success).toBe(false);
  });
  it('binds private credentials and rechecks the lease after the atomic read', async () => {
    const f = fixture(); f.owner.token = 'changed-after-construction';
    expect((await f.run())?.report).toMatchObject({ runId: 'suspended', pendingCallIds: ['a'] });
    expect(f.rpc.mock.calls[0]).toEqual(['read_hermes_active_run_recovery', {
      p_owner_id: 'current', p_owner_token: 'private-token', p_user_id: 'owner', p_request_id: 'current-message', p_thread_id: 'thread',
    }]);
    expect(f.lease.assertActive).toHaveBeenCalledTimes(2);
  });
  it('returns empty only on the explicit SQL absence marker', async () => {
    const f = fixture(); f.rpc.mockResolvedValueOnce({ data: { absent: true }, error: null }); expect(await f.run()).toBeNull();
    f.rpc.mockResolvedValueOnce({ data: null, error: null }); await expect(f.run()).rejects.toThrow('ACTIVE_RUN_RECOVERY_UNAVAILABLE');
  });
  it('rejects a forged current anchor and future or self-referencing prior evidence', async () => {
    const f = fixture(); f.state.anchor.message_id = 'foreign';
    await expect(f.run()).rejects.toThrow('ACTIVE_RUN_RECOVERY_OWNER_MISMATCH');
    f.state.anchor.message_id = 'current-message'; f.state.prior.sequence_id = 10;
    await expect(f.run()).rejects.toThrow('ACTIVE_RUN_RECOVERY_ORDER_MISMATCH');
    f.state.prior.sequence_id = 1; f.state.prior.id = 'current';
    await expect(f.run()).rejects.toThrow('ACTIVE_RUN_RECOVERY_OWNER_MISMATCH');
  });
  it('rejects capability and identity errors before storage access', async () => {
    const capabilities = new Set<string>(), f = fixture({ capabilities });
    await expect(f.run()).rejects.toThrow('ACTIVE_RUN_RECOVERY_ACCESS_DENIED'); expect(f.rpc).not.toHaveBeenCalled();
    capabilities.add('agent_core.reconcile'); f.lease.inboundTurn.messageId = 'foreign';
    await expect(f.run()).rejects.toThrow('ACTIVE_RUN_RECOVERY_OWNER_MISMATCH'); expect(f.rpc).not.toHaveBeenCalled();
  });
  it('fails safely on storage failure without exposing backend diagnostics', async () => {
    const f = fixture(); f.rpc.mockRejectedValueOnce(new Error('secret-token'));
    await expect(f.run()).rejects.toThrow('ACTIVE_RUN_RECOVERY_STORAGE_ERROR');
    f.rpc.mockResolvedValueOnce({ data: f.state, error: { message: 'secret-token' } });
    await expect(f.run()).rejects.toThrow('ACTIVE_RUN_RECOVERY_STORAGE_ERROR');
  });
  it('does not return evidence after lease loss or ignore cancellation during a stalled RPC', async () => {
    const f = fixture(); f.lease.assertActive.mockResolvedValueOnce().mockRejectedValueOnce(new Error('LEASE_LOST'));
    await expect(f.run()).rejects.toThrow('LEASE_LOST');
    const controller = new AbortController(), stalled = fixture({ signal: controller.signal });
    stalled.rpc.mockImplementationOnce(async () => { controller.abort(new Error('cancelled')); return new Promise(() => {}); });
    await expect(stalled.run()).rejects.toThrow('cancelled');
  });
});
