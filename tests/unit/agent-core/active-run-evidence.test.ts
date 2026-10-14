import { describe, it, expect, vi } from 'vitest';
import { activeRunRecoverySnapshotSchema, verifiedActiveRunEvidenceSchema,
  type JsonObject, type TurnContext, type VerifiedActiveRunEvidence } from '@templelabs/contracts';
import { createActiveRunEvidenceRegistry } from '../../../src/adapters/agent-core/active-run-evidence.js';
import { reconcileActiveRun, type ActiveRunResolutionStore } from '../../../src/adapters/agent-core/active-run-resolution.js';
import { checkpointFingerprint } from '../../../src/adapters/agent-core/checkpoint-fingerprint.js';
import { withTurnLease } from '../../../src/agent/core/turn-lease.js';

const uuid = '00000000-0000-4000-8000-000000000001';
function fixture(overrides: Partial<TurnContext> = {}) {
  const original = { callId: 'a', domain: 'task', action: 'delete', targetId: uuid, targetName: 'Tarea', payload: { action: 'delete' }, status: 'prepared', executionFact: null };
  const snapshot = { runId: 'active', userId: 'owner', threadId: 'thread', status: 'waiting_for_approval', expiresAtIso: '2026-10-11T20:00:00Z',
    executionState: { kind: 'generic_operation', context: {}, waitingFor: null }, actions: [original] };
  const fact = { outcome: 'unknown', success: false };
  const source = activeRunRecoverySnapshotSchema.parse({ anchor: { id: 'current', message_id: 'current-message', thread_id: 'thread', sequence_id: 10 },
    prior: { id: 'prior', message_id: 'prior-message', thread_id: 'thread', sequence_id: 1, status: 'unknown', response: { agentCoreActiveRun: {
      version: 1, stage: 'claimed', runId: 'active', userId: 'owner', inboundRunId: 'prior', requestId: 'prior-message', snapshot, claimId: uuid, decision: {},
      actions: { a: { id: uuid, run_id: 'active', call_id: 'a', domain: 'task', action: 'delete', target_id: uuid, target_name: 'Tarea', payload: original.payload,
        status: 'failed', execution_fact: fact, created_at: '2026-10-11T19:00:00Z', executed_at: null } },
    } } },
    run: { id: 'active', user_id: 'owner', thread_id: 'thread', status: 'running', kind: 'generic_operation', expires_at: snapshot.expiresAtIso,
      context: { _agentCoreClaim: { claimId: uuid, ownerId: 'prior', source: snapshot } }, waiting_for: null },
    actions: [{ ...original, status: 'failed', executionFact: fact }],
  });
  const hash = (value: unknown) => checkpointFingerprint(value as JsonObject), fingerprint = hash(source.prior.response);
  const common = { version: 1, userId: 'owner', activeRunId: 'active', inboundRunId: 'prior', threadId: 'thread', sourceFingerprint: fingerprint, verifiedAtIso: '2026-10-12T01:00:00Z' };
  const receipts = [
    { ...common, kind: 'effect', authority: 'domain_audit', evidenceKey: `a:${hash(source.actions[0])}`, proof: { userId: 'owner', activeRunId: 'active', callId: 'a',
      actionFingerprint: hash(source.actions[0]), evidenceId: 'independent-audit', outcome: 'no_effect', coversCompanions: true, item: null } },
    { ...common, kind: 'delivery', authority: 'delivery_audit', evidenceKey: `prior:${fingerprint}`, proof: { userId: 'owner', inboundRunId: 'prior', sourceFingerprint: fingerprint,
      evidenceId: 'whole-turn-delivery-audit', outcome: 'not_sent', messageIds: [] } },
    { ...common, kind: 'baseline', authority: 'owned_checkpoint', evidenceKey: `prior:${fingerprint}`, proof: { userId: 'owner', threadId: 'thread', sourceFingerprint: fingerprint,
      conversation: { userId: 'owner', history: [{ role: 'user', content: 'Conservado' }], tasks: [], reminders: [], events: [], handledRequestIds: ['old'] } } },
  ].map(raw => verifiedActiveRunEvidenceSchema.parse(raw));
  const context: TurnContext = { userId: 'owner', runId: 'current', requestId: 'current-message', language: 'es', timezone: 'America/Bogota', referenceTimeIso: '2026-10-12T01:00:00Z',
    capabilities: new Set(['agent_core.reconcile', 'agent_core.handoff', 'agent_core.evidence.register']), signal: new AbortController().signal, ...overrides };
  const lease = { inboundTurn: { id: 'current', messageId: 'current-message', threadId: 'thread', response: {} }, signal: new AbortController().signal,
    assertActive: vi.fn(async () => {}), checkpoint: vi.fn(async () => {}) };
  const rows = new Map<string, unknown>();
  const rpc = vi.fn(async (_name: string, args: JsonObject): Promise<{ data: unknown; error: unknown }> => {
    const payload = args.p_payload as JsonObject, key = `${payload.kind}:${payload.evidenceKey}`;
    if (args.p_operation === 'register' && !rows.has(key)) rows.set(key, structuredClone(payload));
    return { data: rows.get(key) ?? null, error: null };
  });
  const owner = { id: 'current', token: 'private-token' };
  const registry = createActiveRunEvidenceRegistry({ rpc }, owner);
  const run = <T>(work: () => Promise<T>) => withTurnLease(lease, work);
  const register = (receipt = receipts[0]!) => run(() => registry.register(receipt, source, context));
  return { source, receipts, context, lease, rpc, rows, owner, registry, run, register };
}
describe('persisted independently verified active-run evidence', () => {
  it('registers typed receipts then supplies persisted proofs to the actual reconciler', async () => {
    const f = fixture(); for (const receipt of f.receipts) await f.register(receipt);
    const close = vi.fn(async () => true), store: ActiveRunResolutionStore = { close };
    const state = await f.run(() => reconcileActiveRun(f.source, f.context, f.registry.evidence, store));
    expect(state.history).toEqual([{ role: 'user', content: 'Conservado' }]); expect(state.handledRequestIds).toEqual(['old', 'prior-message']);
    expect(close).toHaveBeenCalledOnce(); expect(f.rows.size).toBe(3);
    expect(f.rpc.mock.calls.every(([name]) => name === 'access_hermes_active_evidence')).toBe(true);
    expect(f.rpc.mock.calls[0]![1]).toMatchObject({ p_owner_id: 'current', p_owner_token: 'private-token', p_expected: f.source });
  });
  it('allows an exact duplicate but rejects a different receipt for the same immutable key', async () => {
    const f = fixture(); await f.register(); await f.register();
    const changed = structuredClone(f.receipts[0]!); changed.verifiedAtIso = '2026-10-12T01:01:00Z';
    await expect(f.register(changed)).rejects.toThrow('ACTIVE_RUN_EVIDENCE_CONFLICT'); expect(f.rows.size).toBe(1);
  });
  it.each(['effect', 'delivery', 'baseline'] as const)('missing %s evidence does not mean no effect, no send or empty history', async kind => {
    const f = fixture();
    const lookup = kind === 'effect' ? () => f.registry.evidence.effect(f.source.actions[0]!, f.source, f.context)
      : () => f.registry.evidence[kind](f.source, f.context);
    await expect(f.run(lookup)).rejects.toThrow('ACTIVE_RUN_EVIDENCE_UNAVAILABLE');
  });
  it.each(['userId','activeRunId','inboundRunId','threadId','sourceFingerprint','evidenceKey','authority'] as const)('rejects changed %s before persistence', async key => {
    const f = fixture(), receipt = structuredClone(f.receipts[0]!) as unknown as Record<string, unknown>;
    receipt[key] = key === 'sourceFingerprint' ? 'f'.repeat(64) : 'foreign';
    await expect(f.register(receipt as VerifiedActiveRunEvidence)).rejects.toThrow(); expect(f.rpc).not.toHaveBeenCalled();
  });
  it('rejects a changed action fingerprint or proof owner independently of the envelope', async () => {
    const f = fixture(), receipt = structuredClone(f.receipts[0]!); if (receipt.kind !== 'effect') throw new Error();
    receipt.proof.actionFingerprint = 'f'.repeat(64);
    await expect(f.register(receipt)).rejects.toThrow(); expect(f.rpc).not.toHaveBeenCalled();
  });
  it('does not publish an unsupported domain as a mixed-engine receipt', async () => {
    const f = fixture(); f.source.actions[0]!.domain = 'entity';
    const checkpoint = f.source.prior.response.agentCoreActiveRun as JsonObject;
    ((checkpoint.actions as JsonObject).a as JsonObject).domain = 'entity';
    const snapshot = checkpoint.snapshot as JsonObject;
    (snapshot.actions as JsonObject[])[0]!.domain = 'entity';
    (f.source.run.context._agentCoreClaim as JsonObject).source = snapshot;
    const receipt = structuredClone(f.receipts[0]!); if (receipt.kind !== 'effect') throw new Error();
    receipt.sourceFingerprint = checkpointFingerprint(f.source.prior.response);
    receipt.proof.actionFingerprint = checkpointFingerprint(f.source.actions[0]! as unknown as JsonObject);
    receipt.evidenceKey = `a:${receipt.proof.actionFingerprint}`;
    await expect(f.register(receipt)).rejects.toThrow('ACTIVE_RUN_RESOLUTION_UNSUPPORTED_DOMAIN'); expect(f.rpc).not.toHaveBeenCalled();
  });
  it('requires a separately authorized registrar and exact current lease', async () => {
    const f = fixture({ capabilities: new Set(['agent_core.reconcile']) });
    await expect(f.register()).rejects.toThrow('ACTIVE_RUN_EVIDENCE_ACCESS_DENIED'); expect(f.rpc).not.toHaveBeenCalled();
    const other = fixture(); other.lease.inboundTurn.messageId = 'foreign';
    await expect(other.register()).rejects.toThrow('ACTIVE_RUN_EVIDENCE_OWNER_MISMATCH');
  });
  it('rejects invalid/open baseline histories before publication', async () => {
    const f = fixture(), receipt = structuredClone(f.receipts[2]!); if (receipt.kind !== 'baseline') throw new Error();
    receipt.proof.conversation.history = [{ role: 'assistant', content: '', toolCalls: [{ id: 'open', name: 'task_delete', arguments: {} }] }];
    await expect(f.register(receipt)).rejects.toThrow('ACTIVE_RUN_EVIDENCE_BASELINE_INVALID'); expect(f.rpc).not.toHaveBeenCalled();
  });
  it('rejects corrupted persisted data rather than returning a legacy success flag', async () => {
    const f = fixture(); await f.register();
    const key = [...f.rows.keys()][0]!; f.rows.set(key, { success: true, outcome: 'success' });
    await expect(f.run(() => f.registry.evidence.effect(f.source.actions[0]!, f.source, f.context))).rejects.toThrow();
  });
  it('rejects a foreign receipt returned despite the scoped request', async () => {
    const f = fixture(); f.rpc.mockResolvedValueOnce({ data: f.receipts[2], error: null });
    await expect(f.run(() => f.registry.evidence.delivery(f.source, f.context))).rejects.toThrow('ACTIVE_RUN_EVIDENCE_BINDING_MISMATCH');
  });
  it('captures private credentials and rejects unsafe storage failure diagnostics', async () => {
    const f = fixture(); f.owner.token = 'caller-changed'; await f.register();
    expect(f.rpc.mock.calls[0]![1].p_owner_token).toBe('private-token');
    f.rpc.mockRejectedValueOnce(new Error('secret-diagnostic'));
    await expect(f.register()).rejects.toThrow('ACTIVE_RUN_EVIDENCE_STORAGE_ERROR');
  });
  it('rechecks lost ownership and interrupts a stalled RPC', async () => {
    const f = fixture(); f.lease.assertActive.mockResolvedValueOnce().mockRejectedValueOnce(new Error('LEASE_LOST'));
    await expect(f.register()).rejects.toThrow('LEASE_LOST');
    const controller = new AbortController(), stalled = fixture({ signal: controller.signal });
    stalled.rpc.mockImplementationOnce(async () => { controller.abort(new Error('cancelled')); return new Promise(() => {}); });
    await expect(stalled.register()).rejects.toThrow('cancelled');
  });
});
