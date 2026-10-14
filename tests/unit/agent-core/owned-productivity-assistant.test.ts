import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { MockAIProvider } from '@templelabs/ai';
import { ProductivityTurnRunner } from '@templelabs/agent-core';
import { ToolRegistry } from '@templelabs/tools';
import { interruptedActiveCompletionEvidenceSchema, jsonObjectSchema, type JsonObject } from '@templelabs/contracts';
import { inspectInterruptedActiveCompletion } from '../../../src/adapters/agent-core/interrupted-active-completion.js';
import { createOwnedProductivityAssistant } from '../../../src/adapters/agent-core/owned-productivity-assistant.js';
import { createOwnedProductivityStateRecovery } from '../../../src/adapters/agent-core/owned-productivity-state-recovery.js';
import { withTurnLease } from '../../../src/agent/core/turn-lease.js';
import { response } from './productivity-fixtures.js';

function fixture() {
  const evidence = interruptedActiveCompletionEvidenceSchema.parse(JSON.parse(readFileSync(
    new URL('../../fixtures/agent-core/interrupted-completion-evidence.json', import.meta.url),'utf8')));
  const { anchor, prior } = evidence.snapshot, userId = evidence.snapshot.run.user_id;
  const completion = inspectInterruptedActiveCompletion(evidence,userId,anchor.thread_id).completion!;
  const closed = { ...prior, status: 'completed', response: { ...prior.response, agentCoreActiveCompletion: jsonObjectSchema.parse(completion) } };
  const context = { userId, runId: anchor.id, requestId: anchor.message_id, language: 'es' as const, timezone: 'America/Bogota',
    referenceTimeIso: new Date().toISOString(), capabilities: new Set(['agent_core.reconcile','agent_core.handoff']), signal: new AbortController().signal };
  const events: string[] = [], controller = new AbortController();
  const lease = { inboundTurn: { id: anchor.id, messageId: anchor.message_id, threadId: anchor.thread_id, response: {} as JsonObject },
    signal: controller.signal, assertActive: vi.fn(async () => {}), checkpoint: vi.fn(async () => { events.push('checkpoint'); }) };
  let entryPrior: unknown = prior;
  const rpc = vi.fn(async (name: string, _args: JsonObject): Promise<{ data: unknown; error: unknown }> => {
    events.push(name);
    if (name === 'read_hermes_productivity_turn_entry') return { data: { anchor: { id: anchor.id, message_id: anchor.message_id,
      thread_id: anchor.thread_id, sequence_id: anchor.sequence_id }, prior: structuredClone(entryPrior) }, error: null };
    if (name === 'read_hermes_interrupted_active_completion') return { data: structuredClone(evidence), error: null };
    if (name === 'resolve_hermes_interrupted_active_completion' || name === 'observe_hermes_interrupted_active_completion') {
      entryPrior = closed; return { data: structuredClone(closed), error: null };
    }
    throw new Error('Unexpected RPC');
  });
  const provider = new MockAIProvider([{ response: response() }], () => 100);
  const runner = new ProductivityTurnRunner(provider,new ToolRegistry([]),{ now: () => 100 });
  const send = vi.fn(async () => { events.push('send'); return { messageId: 'accepted' }; });
  const owner = { id: anchor.id, token: 'private' };
  const assistant = createOwnedProductivityAssistant(runner,{ send },{ rpc },owner);
  const recovery = createOwnedProductivityStateRecovery({ rpc },owner);
  return { evidence, anchor, closed, context, lease, controller, rpc, provider, send, events, owner,
    prior: (value: unknown) => { entryPrior = value; },
    run: () => withTurnLease(lease,() => assistant.handle('Seguimos',context,anchor.thread_id)),
    load: () => withTurnLease(lease,() => recovery.load(context,anchor.thread_id)),
    override: () => withTurnLease(lease,() => assistant.handle('Seguimos',context,anchor.thread_id,completion.baseline.conversation)) };
}

describe('owned productivity startup recovery', () => {
  it('closes once, reloads history and only then admits checkpoint/model/delivery', async () => {
    const f = fixture(); await f.run();
    expect(f.events.slice(0,4)).toEqual(['read_hermes_productivity_turn_entry','read_hermes_interrupted_active_completion',
      'resolve_hermes_interrupted_active_completion','read_hermes_productivity_turn_entry']);
    expect(f.events[4]).toBe('checkpoint'); expect(f.provider.requests).toHaveLength(1); expect(f.send).toHaveBeenCalledOnce();
    const request = JSON.stringify(f.provider.requests[0]);
    expect(request).toContain('Historia conservada'); expect(request).toContain('Sí, elimina esa tarea'); expect(request).toContain('Seguimos');
  });
  it('admits authenticated genesis with one read and no historical publication', async () => {
    const f = fixture(); f.prior(null); await f.run();
    expect(f.rpc).toHaveBeenCalledOnce(); expect(f.provider.requests).toHaveLength(1);
  });
  it('imports an already closed certificate without another publication', async () => {
    const f = fixture(); f.prior(f.closed); await f.run(); expect(f.rpc).toHaveBeenCalledOnce();
    expect(JSON.stringify(f.provider.requests)).toContain('Sí, elimina esa tarea');
  });
  it.each(['legacy','mixed','missingDelivery','otherUnknown','nullRead','storageError','owner','permission','handoff','started','cancelled','order','foreignUser','changedSource'])(
    'blocks %s before the current checkpoint, model or sender', async kind => {
      const f = fixture();
      if (kind === 'legacy') f.prior({ ...f.evidence.snapshot.prior,response: {} });
      if (kind === 'mixed') f.evidence.snapshot.prior.response!.agentCoreProductivity = {};
      if (kind === 'missingDelivery') f.evidence.manifest = null;
      if (kind === 'otherUnknown') {
        f.rpc.mockImplementationOnce(async () => ({ data: { anchor: f.anchor,prior: f.evidence.snapshot.prior },error: null }));
        f.rpc.mockImplementationOnce(async () => ({ data: f.evidence,error: null }));
        f.rpc.mockImplementationOnce(async () => ({ data: f.closed,error: null }));
        f.rpc.mockImplementationOnce(async () => ({ data: { anchor: f.anchor,prior: { ...f.evidence.snapshot.prior,id: 'second' } },error: null }));
      }
      if (kind === 'nullRead') f.rpc.mockResolvedValueOnce({ data: null,error: null });
      if (kind === 'storageError') f.rpc.mockResolvedValueOnce({ data: null,error: { message: 'unavailable' } });
      if (kind === 'owner') f.context.runId = 'foreign';
      if (kind === 'permission') f.context.capabilities.delete('agent_core.reconcile');
      if (kind === 'handoff') f.context.capabilities.delete('agent_core.handoff');
      if (kind === 'started') f.lease.inboundTurn.response.agentCoreResolution = {};
      if (kind === 'cancelled') f.controller.abort();
      if (kind === 'order') f.prior({ ...f.evidence.snapshot.prior,sequence_id: f.anchor.sequence_id });
      if (kind === 'foreignUser') { f.prior(f.closed); f.context.userId = 'foreign'; }
      if (kind === 'changedSource') {
        const original = structuredClone(f.evidence.snapshot.prior);
        f.prior(original); f.evidence.snapshot.prior.response!.extra = 'changed';
      }
      await expect(f.run()).rejects.toThrow();
      expect(f.provider.requests).toHaveLength(0); expect(f.send).not.toHaveBeenCalled(); expect(f.lease.checkpoint).not.toHaveBeenCalled();
      if (kind === 'changedSource') expect(f.rpc).toHaveBeenCalledTimes(2);
    });
  it('observes a committed closure with a lost reply before reloading and planning', async () => {
    const f = fixture();
    f.rpc.mockImplementationOnce(async () => ({ data: { anchor: f.anchor,prior: f.evidence.snapshot.prior },error: null }));
    f.rpc.mockImplementationOnce(async () => ({ data: f.evidence,error: null }));
    f.rpc.mockImplementationOnce(async () => { f.prior(f.closed); throw new Error('Lost reply'); });
    await f.run();
    expect(f.rpc.mock.calls.filter(([name]) => name === 'resolve_hermes_interrupted_active_completion')).toHaveLength(1);
    expect(f.rpc.mock.calls.filter(([name]) => name === 'observe_hermes_interrupted_active_completion')).toHaveLength(1);
    expect(f.provider.requests).toHaveLength(1);
  });
  it('imports a later closed conversation after closing the oldest unknown', async () => {
    const f = fixture();
    const later = structuredClone(f.evidence.baseline!.candidate.prior!);
    later.sequence_id = f.evidence.snapshot.prior.sequence_id + 1;
    f.anchor.sequence_id = later.sequence_id + 1;
    f.rpc.mockImplementationOnce(async () => ({ data: { anchor: f.anchor,prior: f.evidence.snapshot.prior },error: null }));
    f.rpc.mockImplementationOnce(async () => ({ data: f.evidence,error: null }));
    f.rpc.mockImplementationOnce(async () => ({ data: f.closed,error: null }));
    f.rpc.mockImplementationOnce(async () => ({ data: { anchor: f.anchor,prior: later },error: null }));
    const result = await f.load();
    expect(result?.history).toHaveLength(2); expect(result?.handledRequestIds).toEqual(['older']);
  });
  it('bounds an unresponsive startup read without invoking the model or retrying', async () => {
    vi.useFakeTimers();
    try {
      const f = fixture(); f.rpc.mockImplementationOnce(() => new Promise(() => {}));
      vi.spyOn(AbortSignal,'timeout').mockImplementation(ms => {
        const controller = new AbortController(); setTimeout(() => controller.abort(new Error('Deadline')),ms); return controller.signal;
      });
      const rejected = expect(f.run()).rejects.toThrow('PRODUCTIVITY_ENTRY_STORAGE_UNAVAILABLE');
      await vi.advanceTimersByTimeAsync(15001); await rejected;
      expect(f.rpc).toHaveBeenCalledOnce(); expect(f.provider.requests).toHaveLength(0); expect(f.lease.checkpoint).not.toHaveBeenCalled();
    } finally { vi.restoreAllMocks(); vi.useRealTimers(); }
  });
  it('rejects concurrent/repeated admission without duplicated closure', async () => {
    const f = fixture(), results = await Promise.allSettled([f.load(),f.load()]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    await expect(f.load()).rejects.toThrow('PRODUCTIVITY_ENTRY_REPLAY_FORBIDDEN');
    expect(f.rpc.mock.calls.filter(([name]) => name === 'resolve_hermes_interrupted_active_completion')).toHaveLength(1);
  });
  it('forbids a caller checkpoint override before storage/model', async () => {
    const f = fixture(); await expect(f.override()).rejects.toThrow('RECOVERY_CHECKPOINT_OVERRIDE_FORBIDDEN');
    expect(f.rpc).not.toHaveBeenCalled(); expect(f.provider.requests).toHaveLength(0);
  });
  it('retains the private owner token snapshot', async () => {
    const f = fixture(); f.owner.token = 'changed'; await f.load();
    expect(f.rpc.mock.calls.every(([,args]) => args.p_owner_token === 'private')).toBe(true);
  });
});
