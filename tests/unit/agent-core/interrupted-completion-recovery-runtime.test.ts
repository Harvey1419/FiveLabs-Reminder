import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { interruptedActiveCompletionEvidenceSchema, jsonObjectSchema, type JsonObject } from '@templelabs/contracts';
import { inspectInterruptedActiveCompletion } from '../../../src/adapters/agent-core/interrupted-active-completion.js';
import { createInterruptedCompletionRecoveryRuntime } from '../../../src/adapters/agent-core/interrupted-completion-recovery-runtime.js';
import { recoverActiveTurnCompletion } from '../../../src/adapters/agent-core/active-turn-completion.js';
import { withTurnLease } from '../../../src/agent/core/turn-lease.js';

function fixture() {
  const evidence = interruptedActiveCompletionEvidenceSchema.parse(JSON.parse(readFileSync(
    new URL('../../fixtures/agent-core/interrupted-completion-evidence.json', import.meta.url), 'utf8')));
  const anchor = evidence.snapshot.anchor, userId = evidence.snapshot.run.user_id;
  const completion = inspectInterruptedActiveCompletion(evidence, userId, anchor.thread_id).completion!;
  const closed = { ...evidence.snapshot.prior, status: 'completed', response: { ...evidence.snapshot.prior.response, agentCoreActiveCompletion: jsonObjectSchema.parse(completion) } };
  const context = { userId, runId: anchor.id, requestId: anchor.message_id, language: 'es' as const, timezone: 'America/Bogota',
    referenceTimeIso: new Date().toISOString(), capabilities: new Set(['agent_core.reconcile', 'agent_core.handoff']), signal: new AbortController().signal };
  const lease = { inboundTurn: { id: anchor.id, messageId: anchor.message_id, threadId: anchor.thread_id, response: {} as JsonObject },
    signal: new AbortController().signal, assertActive: vi.fn(async () => {}), checkpoint: vi.fn(async () => {}), finalizeCurrent: vi.fn(async () => {}) };
  const owner = { id: anchor.id, token: 'private' };
  const rpc = vi.fn(async (name: string, _args: JsonObject): Promise<{ data: unknown; error: unknown }> => {
    if (name === 'read_hermes_interrupted_active_completion') return { data: structuredClone(evidence), error: null };
    if (name === 'resolve_hermes_interrupted_active_completion' || name === 'observe_hermes_interrupted_active_completion') return { data: structuredClone(closed), error: null };
    throw new Error('Unexpected RPC');
  });
  const runtime = createInterruptedCompletionRecoveryRuntime({ rpc }, owner);
  return { evidence, completion, closed, context, lease, owner, rpc, runtime,
    recover: () => withTurnLease(lease, () => runtime.recover(context, anchor.thread_id)) };
}

describe('transactional interrupted completion recovery runtime', () => {
  it('publishes one verified historical certificate while keeping the current turn active', async () => {
    const f = fixture(), result = await f.recover();
    expect(result).toMatchObject({ status: 'completed', publication: 'acknowledged', requiresHistoryReload: true, grantsExecution: false });
    expect(result?.conversation).toEqual(recoverActiveTurnCompletion(f.closed, f.context.userId));
    expect(f.rpc.mock.calls.map(call => call[0])).toEqual(['read_hermes_interrupted_active_completion', 'resolve_hermes_interrupted_active_completion']);
    expect(f.rpc.mock.calls[1]![1]).toMatchObject({ p_expected: f.evidence, p_completion: f.completion, p_owner_token: 'private' });
    expect(f.lease.checkpoint).not.toHaveBeenCalled(); expect(f.lease.finalizeCurrent).not.toHaveBeenCalled();
    expect(f.lease.inboundTurn.response).toEqual({});
    await expect(f.recover()).rejects.toThrow('INTERRUPTED_COMPLETION_REPLAY_FORBIDDEN'); expect(f.rpc).toHaveBeenCalledTimes(2);
  });

  it('admits only one concurrent invocation on the constructed owner', async () => {
    const f = fixture(); const results = await Promise.allSettled([f.recover(), f.recover()]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter(result => result.status === 'rejected')).toHaveLength(1);
    expect(f.rpc).toHaveBeenCalledTimes(2);
  });

  it.each(['reconcile', 'handoff', 'owner', 'request', 'thread', 'started'] as const)('rejects missing/changed %s before storage', async kind => {
    const f = fixture();
    if (kind === 'reconcile') f.context.capabilities.delete('agent_core.reconcile');
    if (kind === 'handoff') f.context.capabilities.delete('agent_core.handoff');
    if (kind === 'owner') f.context.runId = 'foreign';
    if (kind === 'request') f.context.requestId = 'foreign';
    if (kind === 'thread') f.lease.inboundTurn.threadId = 'foreign';
    if (kind === 'started') f.lease.inboundTurn.response.agentCoreBaseline = {};
    await expect(f.recover()).rejects.toThrow(); expect(f.rpc).not.toHaveBeenCalled();
  });

  it('keeps private owner construction isolated from later caller mutations', async () => {
    const f = fixture(); f.owner.token = 'changed'; await f.recover();
    expect(f.rpc.mock.calls.every(call => call[1].p_owner_token === 'private')).toBe(true);
  });

  it.each(['baseline', 'delivery'] as const)('never publishes with missing/unconfirmed %s evidence', async kind => {
    const f = fixture();
    if (kind === 'baseline') f.evidence.baseline = null;
    if (kind === 'delivery') { f.evidence.manifest!.entries[0]!.state = 'unknown'; f.evidence.manifest!.entries[0]!.providerMessageId = null; }
    await expect(f.recover()).rejects.toThrow('INTERRUPTED_COMPLETION_RECONCILIATION_REQUIRED');
    expect(f.rpc).toHaveBeenCalledOnce(); expect(f.lease.finalizeCurrent).not.toHaveBeenCalled();
  });

  it('treats explicit absence as no closure, preserving the ordinary history reload requirement', async () => {
    const f = fixture(); f.rpc.mockResolvedValueOnce({ data: { absent: true }, error: null });
    expect(await f.recover()).toBeNull(); expect(f.rpc).toHaveBeenCalledOnce();
  });

  it('does not observe or retry a deterministic publication conflict', async () => {
    const f = fixture(); f.rpc.mockResolvedValueOnce({ data: f.evidence, error: null }).mockResolvedValueOnce({ data: null, error: null });
    await expect(f.recover()).rejects.toThrow('INTERRUPTED_COMPLETION_CONFLICT'); expect(f.rpc).toHaveBeenCalledTimes(2);
  });

  it.each(['throw', 'error'] as const)('observes a lost commit reply (%s) once without repeating publication', async mode => {
    const f = fixture();
    f.rpc.mockImplementationOnce(async () => ({ data: f.evidence, error: null }));
    if (mode === 'throw') f.rpc.mockRejectedValueOnce(new Error('reply lost'));
    else f.rpc.mockResolvedValueOnce({ data: null, error: { message: 'reply lost' } });
    const result = await f.recover(); expect(result?.publication).toBe('observed');
    expect(f.rpc.mock.calls.map(call => call[0])).toEqual(['read_hermes_interrupted_active_completion', 'resolve_hermes_interrupted_active_completion', 'observe_hermes_interrupted_active_completion']);
  });

  it('leaves publication uncertain when exact observation is unavailable', async () => {
    const f = fixture(); f.rpc.mockResolvedValueOnce({ data: f.evidence, error: null }).mockRejectedValueOnce(new Error('reply lost')).mockResolvedValueOnce({ data: null, error: null });
    await expect(f.recover()).rejects.toThrow('INTERRUPTED_COMPLETION_STORAGE_UNCERTAIN'); expect(f.rpc).toHaveBeenCalledTimes(3);
    await expect(f.recover()).rejects.toThrow('INTERRUPTED_COMPLETION_REPLAY_FORBIDDEN');
  });

  it.each(['identity', 'status', 'history', 'extraResponse', 'handledIds'] as const)('rejects changed returned %s without granting continuity', async kind => {
    const f = fixture();
    if (kind === 'identity') f.closed.message_id = 'foreign';
    if (kind === 'status') f.closed.status = 'unknown';
    if (kind === 'history') (f.closed.response.agentCoreActiveCompletion.conversation as JsonObject).history = [];
    if (kind === 'extraResponse') Object.assign(f.closed.response, { changed: true });
    if (kind === 'handledIds') (f.closed.response.agentCoreActiveCompletion.conversation as JsonObject).handledRequestIds = ['invented'];
    await expect(f.recover()).rejects.toThrow('INTERRUPTED_COMPLETION_PUBLICATION_MISMATCH'); expect(f.rpc).toHaveBeenCalledTimes(2);
  });

  it('does not retry or observe after cancellation during an uncooperative publication', async () => {
    const f = fixture(), controller = new AbortController(); f.context.signal = controller.signal;
    f.rpc.mockResolvedValueOnce({ data: f.evidence, error: null }).mockImplementationOnce(() => new Promise(() => {}));
    const pending = f.recover(); await vi.waitFor(() => expect(f.rpc).toHaveBeenCalledTimes(2));
    controller.abort(new Error('cancelled')); await expect(pending).rejects.toThrow('cancelled'); expect(f.rpc).toHaveBeenCalledTimes(2);
  });

  it('does not accept publication or observe under a lost current lease', async () => {
    const f = fixture(); f.rpc.mockResolvedValueOnce({ data: f.evidence, error: null }).mockImplementationOnce(async () => {
      f.lease.assertActive.mockRejectedValueOnce(new Error('lease lost')); return { data: f.closed, error: null };
    });
    await expect(f.recover()).rejects.toThrow('lease lost'); expect(f.rpc).toHaveBeenCalledTimes(2);
  });
});
