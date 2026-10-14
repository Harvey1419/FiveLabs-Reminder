import { describe, it, expect, vi } from 'vitest';
import { activeRunRecoverySnapshotSchema, type ActiveRunResolution, type JsonObject, type TurnContext } from '@templelabs/contracts';
import { reconcileActiveRun, recoverActiveRunHandoff, validateActiveRunResolution, createActiveRunResolutionStore,
  type ActiveRunResolutionEvidencePort, type ActiveRunResolutionStore } from '../../../src/adapters/agent-core/active-run-resolution.js';
import { checkpointFingerprint } from '../../../src/adapters/agent-core/checkpoint-fingerprint.js';
import { withTurnLease } from '../../../src/agent/core/turn-lease.js';
import { createProductivityStateRecovery } from '../../../src/adapters/agent-core/productivity-state-recovery.js';
import type { InboundCheckpointClient } from '../../../src/adapters/agent-core/inbound-checkpoint-reader.js';

const taskId = '11111111-1111-4111-8111-111111111111', claimId = '00000000-0000-4000-8000-000000000001';
const hash = (raw: unknown) => checkpointFingerprint(raw as JsonObject);
function fixture(overrides: Partial<TurnContext> = {}) {
  const original = { callId: 'a', domain: 'task', action: 'delete', targetId: taskId, targetName: 'Tarea', payload: { action: 'delete', taskIds: [taskId] }, status: 'prepared', executionFact: null };
  const snapshot = { runId: 'active', userId: 'owner', threadId: 'thread', status: 'waiting_for_approval',
    expiresAtIso: '2026-10-11T20:00:00Z', executionState: { kind: 'generic_operation', context: {}, waitingFor: null }, actions: [original] };
  const fact = { success: false, outcome: 'unknown', _domainCall: { toolName: 'manage_task', params: { action: 'delete', taskIds: [taskId] } } };
  const checkpoint = { version: 1, stage: 'claimed', runId: 'active', userId: 'owner', inboundRunId: 'prior', requestId: 'prior-message',
    snapshot, claimId, decision: { relation: 'approval', decision: 'approve_all' }, actions: { a: {
      id: claimId, run_id: 'active', call_id: 'a', domain: 'task', action: 'delete', target_id: taskId, target_name: 'Tarea',
      payload: original.payload, status: 'failed', execution_fact: fact, created_at: '2026-10-11T19:00:00Z', executed_at: null,
    } } };
  const source = activeRunRecoverySnapshotSchema.parse({
    anchor: { id: 'current', message_id: 'current-message', thread_id: 'thread', sequence_id: 10 },
    prior: { id: 'prior', message_id: 'prior-message', thread_id: 'thread', sequence_id: 1, status: 'unknown', response: { agentCoreActiveRun: checkpoint, other: { retained: true } } },
    run: { id: 'active', user_id: 'owner', thread_id: 'thread', status: 'running', kind: 'generic_operation', expires_at: snapshot.expiresAtIso,
      context: { _agentCoreClaim: { claimId, ownerId: 'prior', source: snapshot } }, waiting_for: null },
    actions: [{ ...original, status: 'failed', executionFact: fact }],
  });
  const task = { id: taskId, title: 'Tarea', description: null, priority: null, status: 'deleted', dueDateIso: null, entityId: null, entityName: null };
  const proof = { userId: 'owner', activeRunId: 'active', callId: 'a', actionFingerprint: hash(source.actions[0]), evidenceId: 'domain-audit', outcome: 'applied', coversCompanions: true,
    item: { domain: 'tasks', callId: 'a', toolName: 'task_delete', status: 'success', code: null, result: {
      operation: 'delete', records: [task], complete: true, coverage: 'operation', issues: [], flow: null,
      presentation: { canonicalCard: null, questions: [], cta: null },
    } } };
  const delivery = { userId: 'owner', inboundRunId: 'prior', sourceFingerprint: hash(source.prior.response), evidenceId: 'sender-audit', outcome: 'not_sent', messageIds: [] as string[] };
  const baseline = { userId: 'owner', threadId: 'thread', sourceFingerprint: hash(source.prior.response), conversation: { userId: 'owner',
    history: [{ role: 'user', content: 'Historial previo' }, { role: 'assistant', content: 'Respuesta previa', toolCalls: [] }],
    reminders: [], events: [], tasks: [{ ...task, id: '22222222-2222-4222-8222-222222222222', status: 'pending' }], handledRequestIds: ['older-message'] } };
  const context: TurnContext = { userId: 'owner', runId: 'current', requestId: 'current-message', language: 'es', timezone: 'America/Bogota',
    referenceTimeIso: '2026-10-12T01:00:00Z', capabilities: new Set(['agent_core.reconcile', 'agent_core.handoff']), signal: new AbortController().signal, ...overrides };
  const lease = { inboundTurn: { id: 'current', messageId: 'current-message', threadId: 'thread', response: {} }, signal: new AbortController().signal,
    assertActive: vi.fn(async () => {}), checkpoint: vi.fn(async () => {}) };
  const evidence: ActiveRunResolutionEvidencePort = { effect: vi.fn(async () => structuredClone(proof)), delivery: vi.fn(async () => structuredClone(delivery)), baseline: vi.fn(async () => structuredClone(baseline)) };
  const store: ActiveRunResolutionStore = { close: vi.fn(async () => true) };
  return { source, proof, delivery, baseline, context, lease, evidence, store,
    run: () => withTurnLease(lease, () => reconcileActiveRun(source, context, evidence, store)) };
}
async function resolved() {
  const f = fixture(); const conversation = await f.run();
  const resolution = vi.mocked(f.store.close).mock.calls[0]![1];
  const row = { ...f.source.prior, status: 'completed', response: { ...f.source.prior.response, agentCoreActiveResolution: resolution } };
  return { ...f, conversation, resolution, row };
}
describe('evidence-based active-run closure and handoff', () => {
  it('imports verified IDs while preserving prior history/references and original evidence', async () => {
    const f = await resolved();
    expect(f.conversation.history).toEqual(f.baseline.conversation.history);
    expect(f.conversation.tasks.map(task => task.id)).toEqual(['22222222-2222-4222-8222-222222222222', taskId]);
    expect(f.conversation.handledRequestIds).toEqual(['older-message', 'prior-message']);
    expect(f.resolution.grantsExecution).toBe(false); expect(f.resolution.runStatus).toBe('completed');
    expect((f.row.response as JsonObject).agentCoreActiveRun).toEqual(f.source.prior.response.agentCoreActiveRun);
    expect(recoverActiveRunHandoff(f.row, 'owner')).toEqual(f.conversation);
    expect(f.lease.checkpoint).not.toHaveBeenCalled();
  });
  it('closes a proven no-effect outcome without inventing resource references', async () => {
    const f = fixture(); vi.mocked(f.evidence.effect).mockResolvedValue({ ...f.proof, outcome: 'no_effect', item: null });
    expect((await f.run()).tasks).toEqual(f.baseline.conversation.tasks);
    expect(vi.mocked(f.store.close).mock.calls[0]![1].runStatus).toBe('failed');
  });
  it('accepts an independently confirmed whole-turn delivery and does not send again', async () => {
    const f = fixture(); f.delivery.outcome = 'accepted'; f.delivery.messageIds = ['provider-message'];
    await f.run(); expect(vi.mocked(f.store.close).mock.calls[0]![1].delivery.messageIds).toEqual(['provider-message']);
  });
  it.each(['owner', 'run', 'call', 'fingerprint', 'target', 'operation', 'partial', 'companion', 'emptyRecords', 'missingTarget', 'delivery', 'baseline', 'openHistory', 'unsupported', 'pending'])('rejects %s evidence before closure', async kind => {
    const f = fixture();
    if (kind === 'owner') f.proof.userId = 'foreign';
    if (kind === 'run') f.proof.activeRunId = 'foreign';
    if (kind === 'call') f.proof.callId = 'foreign';
    if (kind === 'fingerprint') f.proof.actionFingerprint = 'f'.repeat(64);
    if (kind === 'target') f.proof.item.result.records[0]!.id = claimId;
    if (kind === 'operation') { f.proof.item.toolName = 'task_complete'; f.proof.item.result.operation = 'complete'; }
    if (kind === 'partial') f.proof.item.status = 'partial';
    if (kind === 'companion') f.proof.coversCompanions = false;
    if (kind === 'emptyRecords') f.proof.item.result.records = [];
    if (kind === 'missingTarget') f.source.actions[0]!.targetId = null;
    if (kind === 'delivery') f.delivery.sourceFingerprint = 'f'.repeat(64);
    if (kind === 'baseline') f.baseline.userId = 'foreign';
    if (kind === 'openHistory') f.baseline.conversation.history = [{ role: 'assistant', content: '', toolCalls: [{ id: 'open', name: 'task_delete', arguments: {} }] }] as never;
    if (kind === 'unsupported') f.source.actions[0]!.domain = 'entity';
    if (kind === 'pending') f.source.actions[0]!.status = 'prepared';
    await expect(f.run()).rejects.toThrow(); expect(f.store.close).not.toHaveBeenCalled();
  });
  it('requires both host capabilities and exact current lease identity', async () => {
    const f = fixture({ capabilities: new Set(['agent_core.reconcile']) });
    await expect(f.run()).rejects.toThrow('ACTIVE_RUN_RESOLUTION_ACCESS_DENIED'); expect(f.evidence.effect).not.toHaveBeenCalled();
    const foreign = fixture(); foreign.lease.inboundTurn.messageId = 'foreign';
    await expect(foreign.run()).rejects.toThrow('ACTIVE_RUN_RESOLUTION_OWNER_MISMATCH');
  });
  it('stops on a closure conflict and never returns an unpersisted handoff', async () => {
    const f = fixture(); vi.mocked(f.store.close).mockResolvedValue(false);
    await expect(f.run()).rejects.toThrow('ACTIVE_RUN_RESOLUTION_CONFLICT');
  });
  it('keeps a consistently persisted pending action blocked before requesting any receipts', async () => {
    const f = fixture(); f.source.actions[0]!.status = 'prepared'; f.source.actions[0]!.executionFact = null;
    const checkpoint = f.source.prior.response.agentCoreActiveRun as JsonObject;
    const receipt = (checkpoint.actions as JsonObject).a as JsonObject;
    receipt.status = 'prepared'; receipt.execution_fact = null;
    await expect(f.run()).rejects.toThrow('ACTIVE_RUN_RESOLUTION_PENDING_ACTIONS');
    expect(f.evidence.effect).not.toHaveBeenCalled(); expect(f.store.close).not.toHaveBeenCalled();
  });
  it('rejects two receipts that disagree on the final state of the same reference', async () => {
    const f = fixture();
    const action = { ...structuredClone(f.source.actions[0]!), callId: 'b' }; f.source.actions.push(action);
    const checkpoint = f.source.prior.response.agentCoreActiveRun as JsonObject;
    const snapshot = checkpoint.snapshot as JsonObject;
    (snapshot.actions as JsonObject[]).push({ ...(snapshot.actions as JsonObject[])[0]!, callId: 'b' });
    const receipts = checkpoint.actions as JsonObject;
    receipts.b = { ...(receipts.a as JsonObject), id: '00000000-0000-4000-8000-000000000002', call_id: 'b' };
    (f.source.run.context._agentCoreClaim as JsonObject).source = snapshot;
    f.baseline.sourceFingerprint = hash(f.source.prior.response);
    f.delivery.sourceFingerprint = hash(f.source.prior.response);
    const second = structuredClone(f.proof); second.callId = 'b'; second.item.callId = 'b'; second.actionFingerprint = hash(action);
    second.item.result.records[0]!.title = 'Different final record';
    vi.mocked(f.evidence.effect).mockResolvedValueOnce(f.proof).mockResolvedValueOnce(second);
    await expect(f.run()).rejects.toThrow('ACTIVE_RUN_RESOLUTION_REFERENCE_CONFLICT'); expect(f.store.close).not.toHaveBeenCalled();
  });
  it('rejects missing/duplicate receipts and tampered stored conversations or source evidence', async () => {
    const f = await resolved();
    for (const change of ['missing', 'duplicate', 'conversation', 'source', 'status'] as const) {
      const value = structuredClone(f.resolution);
      if (change === 'missing') value.effects = [];
      if (change === 'duplicate') value.effects.push(value.effects[0]!);
      if (change === 'conversation') value.conversation.history = [];
      if (change === 'source') value.source.prior.response.other = { changed: true };
      if (change === 'status') value.runStatus = 'failed';
      expect(() => validateActiveRunResolution(value)).toThrow();
    }
    expect(() => recoverActiveRunHandoff({ ...f.row, response: { ...f.row.response, injected: true } }, 'owner')).toThrow('ACTIVE_RUN_HANDOFF_SOURCE_MISMATCH');
    expect(() => recoverActiveRunHandoff(f.row, 'foreign')).toThrow('ACTIVE_RUN_HANDOFF_SOURCE_MISMATCH');
  });
  it('rechecks a lost lease after evidence and handles a stalled evidence port cancellation', async () => {
    const f = fixture(); vi.mocked(f.evidence.effect).mockImplementation(async () => { f.lease.assertActive.mockRejectedValue(new Error('LEASE_LOST')); return f.proof; });
    await expect(f.run()).rejects.toThrow('LEASE_LOST'); expect(f.store.close).not.toHaveBeenCalled();
    const controller = new AbortController(), stalled = fixture({ signal: controller.signal });
    vi.mocked(stalled.evidence.effect).mockImplementation(async () => { controller.abort(new Error('cancelled')); return new Promise(() => {}); });
    await expect(stalled.run()).rejects.toThrow('cancelled'); expect(stalled.store.close).not.toHaveBeenCalled();
  });
  it('does not silently truncate a full handled-request ledger', async () => {
    const f = fixture(); f.baseline.conversation.handledRequestIds = Array.from({ length: 100 }, (_, i) => `old-${i}`);
    await expect(f.run()).rejects.toThrow(); expect(f.store.close).not.toHaveBeenCalled();
  });
  it('binds private RPC credentials, compares full source and fails without fallback', async () => {
    const f = await resolved(), rpc = vi.fn(async (_name: string, _args: JsonObject) => ({ data: true as unknown, error: null as unknown }));
    const store = createActiveRunResolutionStore({ rpc }, { id: 'current', token: 'secret' });
    expect(await store.close(f.source, f.resolution)).toBe(true);
    expect(rpc.mock.calls[0]![1]).toMatchObject({ p_owner_id: 'current', p_owner_token: 'secret', p_expected: f.source });
    rpc.mockRejectedValueOnce(new Error('secret')); await expect(store.close(f.source, f.resolution)).rejects.toThrow('ACTIVE_RUN_RESOLUTION_STORAGE_ERROR');
    rpc.mockResolvedValueOnce({ data: null, error: null }); await expect(store.close(f.source, f.resolution)).rejects.toThrow('ACTIVE_RUN_RESOLUTION_STORAGE_ERROR');
  });
  it('mixed recovery accepts only the verified handoff and preserves older unknown blocking', async () => {
    const f = await resolved(), next: TurnContext = { ...f.context, runId: 'next', requestId: 'next-message' };
    const answers = [{ data: { id: 'next', message_id: 'next-message', thread_id: 'thread', sequence_id: 20, status: 'running' }, error: null }, { data: null, error: null }, { data: f.row, error: null }];
    const client: InboundCheckpointClient = { from() {
      const query = { eq: () => query, lt: () => query, in: () => query, order: () => query, limit: () => query, abortSignal: () => query,
        maybeSingle: async () => answers.shift()! };
      return { select: () => query };
    } };
    const lease = { ...f.lease, inboundTurn: { ...f.lease.inboundTurn, id: 'next', messageId: 'next-message' } };
    const recovery = createProductivityStateRecovery(client);
    expect(await withTurnLease(lease, () => recovery.load(next, 'thread'))).toEqual(f.conversation);
    answers.push({ data: { id: 'next', message_id: 'next-message', thread_id: 'thread', sequence_id: 20, status: 'running' }, error: null },
      { data: { ...f.row, status: 'unknown' } as never, error: null });
    await expect(withTurnLease(lease, () => recovery.load(next, 'thread'))).rejects.toMatchObject({ code: 'PRIOR_TURN_RECONCILIATION_REQUIRED' });
  });
});
