import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { interruptedActiveCompletionEvidenceSchema, jsonObjectSchema, activeRunCheckpointSchema, type JsonObject } from '@templelabs/contracts';
import { inspectInterruptedActiveCompletion, createInterruptedActiveCompletionReader } from '../../../src/adapters/agent-core/interrupted-active-completion.js';
import { inspectActiveRunRecovery } from '../../../src/adapters/agent-core/active-run-recovery.js';
import { recoverActiveTurnCompletion } from '../../../src/adapters/agent-core/active-turn-completion.js';
import { withTurnLease } from '../../../src/agent/core/turn-lease.js';

// Frozen actual SQL envelope from a disposable completed-task/accepted-delivery interruption fixture.
function evidence() {
  return interruptedActiveCompletionEvidenceSchema.parse(JSON.parse(readFileSync(
    new URL('../../fixtures/agent-core/interrupted-completion-evidence.json', import.meta.url), 'utf8')));
}
function fixture() {
  const state = evidence(), anchor = state.snapshot.anchor;
  const context = { userId: state.snapshot.run.user_id, runId: anchor.id, requestId: anchor.message_id,
    language: 'es' as const, timezone: 'America/Bogota', referenceTimeIso: new Date().toISOString(),
    capabilities: new Set(['agent_core.reconcile']), signal: new AbortController().signal };
  const lease = { inboundTurn: { id: anchor.id, messageId: anchor.message_id, threadId: anchor.thread_id, response: {} },
    signal: new AbortController().signal, assertActive: vi.fn(async () => {}), checkpoint: vi.fn(async () => {}) };
  const rpc = vi.fn(async (_name: string, _args: JsonObject): Promise<{ data: unknown; error: unknown }> => ({ data: state, error: null }));
  const owner = { id: anchor.id, token: 'private' };
  const reader = createInterruptedActiveCompletionReader({ rpc }, owner);
  return { state, context, lease, rpc, owner, reader,
    load: () => withTurnLease(lease, () => reader.load(context, anchor.thread_id)) };
}

describe('interrupted recorded-input completion inspection', () => {
  it('reconstructs captured user input and accepted reply exactly once while granting no handoff', () => {
    const state = evidence(), original = structuredClone(state);
    const report = inspectInterruptedActiveCompletion(state, state.snapshot.run.user_id, state.snapshot.prior.thread_id);
    expect(report).toMatchObject({ status: 'verifiable', reason: 'complete_evidence', grantsExecution: false, allowsHandoff: false });
    expect(report.completion?.conversation.history.slice(0, 2)).toEqual(state.baseline!.conversation.history);
    expect(report.completion?.conversation.history[2]?.content).toBe(state.baseline!.input!.userText);
    expect(report.completion?.conversation.history[3]?.content).toBe(state.manifest!.entries[0]!.message.text);
    expect(report.completion?.conversation.handledRequestIds).toEqual([...state.baseline!.conversation.handledRequestIds, state.snapshot.prior.message_id]);
    expect(state).toEqual(original);
    expect(() => recoverActiveTurnCompletion({ ...state.snapshot.prior, response: { ...state.snapshot.prior.response, agentCoreActiveCompletion: jsonObjectSchema.parse(report.completion) } }, state.snapshot.run.user_id)).toThrow('ACTIVE_COMPLETION_OWNER_MISMATCH');
  });

  it('keeps the legacy recovery guard against dropping recorded input', () => {
    const f = fixture();
    expect(() => inspectActiveRunRecovery(f.state.snapshot, f.context.userId, f.lease.inboundTurn.threadId)).toThrow('ACTIVE_RUN_RECOVERY_COMPLETION_REQUIRED');
  });

  it.each(['baseline', 'manifest'] as const)('reports missing %s without inventing proof', field => {
    const f = fixture(); f.state[field] = null;
    expect(inspectInterruptedActiveCompletion(f.state, f.context.userId, f.lease.inboundTurn.threadId)).toMatchObject({ status: 'incomplete', reason: `missing_${field}`, completion: null, grantsExecution: false, allowsHandoff: false });
  });

  it.each(['ready', 'attempted', 'unknown'] as const)('never treats %s delivery as accepted', state => {
    const f = fixture(); f.state.manifest!.entries[0]!.state = state; f.state.manifest!.entries[0]!.providerMessageId = null;
    expect(inspectInterruptedActiveCompletion(f.state, f.context.userId, f.lease.inboundTurn.threadId)).toMatchObject({ reason: 'delivery_unconfirmed', completion: null });
  });

  it.each(['missingReceipt', 'changedReceipt', 'changedInput', 'changedCard'] as const)('cannot reconstruct completion from %s', kind => {
    const f = fixture();
    if (kind === 'missingReceipt') f.state.receipts = [];
    if (kind === 'changedReceipt') f.state.receipts[0]!.legacyResult = { ...f.state.receipts[0]!.legacyResult, data: { ...jsonObjectSchema.parse(f.state.receipts[0]!.legacyResult.data), title: 'Forged' } };
    if (kind === 'changedInput') f.state.baseline!.input!.userText = 'Forged input';
    if (kind === 'changedCard') f.state.manifest!.entries[0]!.message.text = 'Forged card';
    expect(inspectInterruptedActiveCompletion(f.state, f.context.userId, f.lease.inboundTurn.threadId)).toMatchObject({ status: 'incomplete', reason: 'completion_unverifiable', completion: null });
  });

  it.each(['owner', 'action', 'context', 'waitingFor', 'expiry', 'baselineHistory', 'baselineSequence', 'completedStatus', 'changedMarker'] as const)('rejects changed authoritative %s', kind => {
    const f = fixture();
    if (kind === 'owner') f.state.snapshot.run.user_id = 'foreign';
    if (kind === 'action') f.state.snapshot.actions[0]!.targetName = 'changed';
    if (kind === 'context') f.state.snapshot.run.context.changed = true;
    if (kind === 'waitingFor') f.state.snapshot.run.waiting_for = { changed: true };
    if (kind === 'expiry') f.state.snapshot.run.expires_at = '2040-01-01T00:00:00Z';
    if (kind === 'baselineHistory') f.state.baseline!.conversation.history = [];
    if (kind === 'baselineSequence') f.state.baseline!.candidate.sequenceId++;
    if (kind === 'changedMarker') (f.state.snapshot.prior.response.agentCoreBaseline as JsonObject).candidateFingerprint = 'a'.repeat(64);
    if (kind === 'completedStatus') f.state.snapshot.prior.status = 'completed';
    expect(() => inspectInterruptedActiveCompletion(f.state, f.context.userId, f.lease.inboundTurn.threadId)).toThrow();
  });

  it('inspects through a single bounded read without invoking checkpoint or dispatch', async () => {
    const f = fixture(); const result = await f.load();
    expect(result?.report.status).toBe('verifiable');
    expect(f.rpc).toHaveBeenCalledExactlyOnceWith('read_hermes_interrupted_active_completion', {
      p_owner_id: f.owner.id, p_owner_token: f.owner.token, p_user_id: f.context.userId, p_request_id: f.context.requestId, p_thread_id: f.lease.inboundTurn.threadId,
    });
    expect(f.lease.checkpoint).not.toHaveBeenCalled(); expect(f.lease.assertActive).toHaveBeenCalledTimes(2);
  });

  it.each(['capability', 'owner', 'request', 'thread'] as const)('rejects current %s before reading SQL', async kind => {
    const f = fixture();
    if (kind === 'capability') f.context.capabilities.clear();
    if (kind === 'owner') f.context.runId = 'foreign';
    if (kind === 'request') f.context.requestId = 'foreign';
    if (kind === 'thread') f.lease.inboundTurn.threadId = 'foreign';
    await expect(f.load()).rejects.toThrow(); expect(f.rpc).not.toHaveBeenCalled();
  });

  it('distinguishes explicit absence from unavailable authority', async () => {
    const f = fixture(); f.rpc.mockResolvedValueOnce({ data: { absent: true }, error: null }); expect(await f.load()).toBeNull();
    f.rpc.mockResolvedValueOnce({ data: null, error: null }); await expect(f.load()).rejects.toThrow('INTERRUPTED_COMPLETION_UNAVAILABLE');
  });

  it('rejects a source envelope bound to a different current anchor', async () => {
    const f = fixture(); f.state.snapshot.anchor.message_id = 'foreign';
    await expect(f.load()).rejects.toThrow('INTERRUPTED_COMPLETION_OWNER_MISMATCH');
  });

  it('stops an uncooperative RPC on cancellation and never retries', async () => {
    const f = fixture(), controller = new AbortController(); f.context.signal = controller.signal;
    f.rpc.mockImplementation(() => new Promise(() => {}));
    const pending = f.load(); await vi.waitFor(() => expect(f.rpc).toHaveBeenCalledOnce());
    controller.abort(new Error('cancelled')); await expect(pending).rejects.toThrow('cancelled'); expect(f.rpc).toHaveBeenCalledOnce();
  });

  it('rejects an observation if lease ownership is lost while SQL responds', async () => {
    const f = fixture(); f.lease.assertActive.mockResolvedValueOnce().mockRejectedValueOnce(new Error('lease lost'));
    await expect(f.load()).rejects.toThrow('lease lost'); expect(f.rpc).toHaveBeenCalledOnce();
  });

  it('retains unknown failed actions for verification rather than authorizing replay', () => {
    const f = fixture(), checkpoint = activeRunCheckpointSchema.parse(f.state.snapshot.prior.response.agentCoreActiveRun);
    if (checkpoint.stage !== 'final') throw new Error('Final fixture required');
    checkpoint.result.status = 'failed'; f.state.snapshot.run.status = 'failed';
    const stored = checkpoint.actions![f.state.snapshot.actions[0]!.callId]!;
    stored.status = 'failed'; stored.execution_fact = { success: false, outcome: 'unknown', _domainCall: f.state.receipts[0]!.domainCall };
    f.state.snapshot.actions[0]!.status = 'failed'; f.state.snapshot.actions[0]!.executionFact = stored.execution_fact;
    f.state.snapshot.prior.response.agentCoreActiveRun = jsonObjectSchema.parse(checkpoint);
    expect(inspectInterruptedActiveCompletion(f.state, f.context.userId, f.lease.inboundTurn.threadId)).toMatchObject({ reason: 'unfinished_execution', completion: null, grantsExecution: false, allowsHandoff: false });
  });
});
