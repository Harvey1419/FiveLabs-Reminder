import { describe, expect, it, vi } from 'vitest';
import { createInboundTurnWorker, type ClaimedInboundTurn } from '../../../src/jobs/inbound-turn-worker.js';
import type { JsonObject } from '@templelabs/contracts';
import { assertTurnLease, checkpointTurnResponse, currentTurnSignal, requireInboundTurnLease, withTurnLease } from '../../../src/agent/core/turn-lease.js';

type FixtureRow = { id: string; thread_id: string; status: string; message_id?: string; lease_token?: string; response?: JsonObject };
function store(rows: FixtureRow[]) {
  return {
    claim: vi.fn(async () => {
      const row = rows.find(row => row.status === 'queued' && !rows.some(other => other.thread_id === row.thread_id && other.status === 'running'));
      if (!row) return null;
      row.status = 'running';
      return { id: row.id, message_id: row.message_id ?? row.id, thread_id: row.thread_id, lease_token: row.lease_token ?? 'fixture-token', response: row.response ?? null, request: { id: row.id } };
    }),
    renew: vi.fn(async (_turn: ClaimedInboundTurn) => true),
    checkpoint: vi.fn(async (_turn: ClaimedInboundTurn, _response: JsonObject) => true),
    finish: vi.fn(async (turn: ClaimedInboundTurn, status: 'completed' | 'unknown', _error?: string) => { rows.find(row => row.id === turn.id)!.status = status; return true; }),
    resolvePrior: vi.fn(async (_turn: ClaimedInboundTurn, _runId: string, _expected: JsonObject, _resolution: JsonObject) => true),
    observeFinalization: vi.fn(async (_turn: ClaimedInboundTurn) => false),
  };
}
const logger = { error: vi.fn() };

describe('durable inbound worker boundaries', () => {
  it('fences prior-turn resolution through the claimed token and rejects storage conflicts', async () => {
    const row = { id: 'current', message_id: 'message', thread_id: 'a', status: 'queued', lease_token: 'fixture-token' };
    const storage = store([row]);
    storage.resolvePrior = vi.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    const worker = createInboundTurnWorker({ storage, logger, processTurn: async () => {
      const lease = requireInboundTurnLease();
      await lease.resolvePrior!('previous', { confirmation: 'Original' }, { version: 1 });
      await expect(lease.resolvePrior!('previous', { confirmation: 'Original' }, { version: 1 }))
        .rejects.toMatchObject({ code: 'TURN_RESOLUTION_CONFLICT' });
    } });
    await worker.tick(); await worker.stop();
    expect(storage.resolvePrior).toHaveBeenCalledWith(expect.objectContaining({ id: 'current', lease_token: 'fixture-token' }),
      'previous', { confirmation: 'Original' }, { version: 1 });
    expect(row.status).toBe('completed');
  });
  it('exposes claimed identity and prior response only inside the worker lease', async () => {
    const row = { id: 'a1', message_id: 'message-a1', thread_id: 'a', status: 'queued', response: { confirmation: 'Existing' } };
    const storage = store([row]);
    let identity: ReturnType<typeof requireInboundTurnLease>['inboundTurn'] | undefined;
    const worker = createInboundTurnWorker({ storage, logger, processTurn: async () => {
      const lease = requireInboundTurnLease();
      identity = lease.inboundTurn;
      expect(identity).toEqual({ id: 'a1', messageId: 'message-a1', threadId: 'a', response: { confirmation: 'Existing' } });
      identity.response.confirmation = 'Local copy';
      expect(row.response.confirmation).toBe('Existing');
      await lease.checkpoint({ agentCore: { version: 2 } });
    } });
    await worker.tick();
    await worker.stop();
    expect(identity).toBeDefined();
    expect(storage.checkpoint).toHaveBeenCalledWith(expect.objectContaining({ id: 'a1' }), { agentCore: { version: 2 } });
    expect(() => requireInboundTurnLease()).toThrow('lease is required');
  });
  it('lets independent workers process different users while one user remains serialized', async () => {
    const storage = store([{ id: 'a1', thread_id: 'a', status: 'queued' }, { id: 'a2', thread_id: 'a', status: 'queued' }, { id: 'b1', thread_id: 'b', status: 'queued' }]);
    let release: () => void = () => {};
    const gate = new Promise<void>(resolve => { release = resolve; });
    const started: string[] = [];
    const processTurn = async (req: JsonObject) => { started.push(String(req.id)); await assertTurnLease(); if (req.id === 'a1') await gate; };
    const first = createInboundTurnWorker({ storage, processTurn, concurrency: 1, logger });
    const second = createInboundTurnWorker({ storage, processTurn, concurrency: 1, logger });
    await Promise.all([first.tick(), second.tick()]);
    expect(started).toEqual(['a1', 'b1']);
    release();
    await first.stop();
    await second.stop();
    const restarted = createInboundTurnWorker({ storage, processTurn, logger });
    await restarted.tick();
    await restarted.stop();
    expect(started).toEqual(['a1', 'b1', 'a2']);
  });
  it('records an interrupted handler as unknown and never calls it again', async () => {
    const rows = [{ id: 'a1', thread_id: 'a', status: 'queued' }];
    const storage = store(rows);
    const processTurn = vi.fn(async () => { throw new Error('Connection lost after write'); });
    const worker = createInboundTurnWorker({ storage, processTurn, logger });
    await worker.tick();
    await worker.stop();
    const restarted = createInboundTurnWorker({ storage, processTurn, logger });
    await restarted.tick();
    await restarted.stop();
    expect(processTurn).toHaveBeenCalledTimes(1);
    expect(rows[0]!.status).toBe('unknown');
  });
  it('blocks effects and aborts in-flight database requests when ownership is lost', async () => {
    const storage = store([{ id: 'a1', thread_id: 'a', status: 'queued' }]);
    storage.renew.mockResolvedValue(false);
    const effect = vi.fn();
    let signal: AbortSignal | undefined;
    const worker = createInboundTurnWorker({ storage, logger, processTurn: async () => {
      signal = currentTurnSignal();
      await assertTurnLease();
      effect();
    } });
    await worker.tick();
    await worker.stop();
    expect(effect).not.toHaveBeenCalled();
    expect(signal?.aborted).toBe(true);
    expect(storage.finish).not.toHaveBeenCalled();
  });
  it('persists the observed reply before permitting delivery', async () => {
    const storage = store([{ id: 'a1', thread_id: 'a', status: 'queued' }]);
    storage.checkpoint.mockResolvedValue(false);
    const send = vi.fn();
    const worker = createInboundTurnWorker({ storage, logger, processTurn: async () => {
      await checkpointTurnResponse({ confirmation: 'Observed result' });
      send();
    } });
    await worker.tick();
    await worker.stop();
    expect(send).not.toHaveBeenCalled();
    expect(storage.checkpoint).toHaveBeenCalledTimes(1);
  });
  it('drains a claim already in flight when shutdown begins', async () => {
    const rows = [{ id: 'a1', thread_id: 'a', status: 'queued' }];
    const storage = store(rows);
    let release: () => void = () => {};
    const claimed = storage.claim;
    storage.claim = vi.fn(async () => { await new Promise<void>(resolve => { release = resolve; }); return claimed(); });
    const processTurn = vi.fn(async () => {});
    const worker = createInboundTurnWorker({ storage, processTurn, logger });
    const polling = worker.tick();
    let stopped = false;
    const stopping = worker.stop().then(() => { stopped = true; });
    await Promise.resolve();
    expect(stopped).toBe(false);
    release();
    await Promise.all([polling, stopping]);
    expect(processTurn).toHaveBeenCalledTimes(1);
    expect(rows[0]!.status).toBe('completed');
  });

});

describe('typed finalization publication boundary',()=>{
  it('shares ambient leases across distinct source and compiled exports and retains background isolation',async()=>{
    const compiled=await import('../../../dist/runtime/agent/core/turn-lease.js');
    expect(compiled.requireInboundTurnLease).not.toBe(requireInboundTurnLease);
    const source = await import(new URL('../../../src/agent/core/turn-lease.ts',import.meta.url).href) as typeof import('../../../src/agent/core/turn-lease.js');
    const lease={inboundTurn:{id:'copy',messageId:'message',threadId:'thread',response:{}},signal:new AbortController().signal,assertActive:async()=>{},checkpoint:async()=>{}};
    await withTurnLease(lease,async()=>{expect(source.requireInboundTurnLease()).toBe(lease);expect(compiled.requireInboundTurnLease()).toBe(lease);});
    expect(()=>source.requireInboundTurnLease()).toThrow('lease is required');
  });
  it('passes private claimed credentials only to the owned handler and preserves legacy handler arity',async()=>{
    const rows=[{id:'owned',message_id:'message',thread_id:'thread',lease_token:'private-token',status:'queued'}],storage=store(rows);
    const processOwnedTurn=vi.fn(async(request:JsonObject,owner:{readonly id:string;readonly token:string})=>{
      expect(request).toEqual({id:'owned'});expect(owner).toEqual({id:'owned',token:'private-token'});expect(Object.isFrozen(owner)).toBe(true);
    });
    const worker=createInboundTurnWorker({storage,logger:{error:vi.fn()},processOwnedTurn});await worker.tick();await worker.stop();expect(processOwnedTurn).toHaveBeenCalledOnce();
  });
  it('does not renew or invoke legacy finish after acknowledged typed finalization',async()=>{
    const rows=[{id:'closed',message_id:'message',thread_id:'thread',lease_token:'private',status:'queued'}],storage=store(rows),log={error:vi.fn()};
    const publish=vi.fn(async()=>{rows[0]!.status='completed';return true;});
    const worker=createInboundTurnWorker({storage,logger:log,processTurn:async()=>{
      const lease=requireInboundTurnLease();await lease.finalizeCurrent!(publish);
      await expect(lease.assertActive()).rejects.toMatchObject({code:'TURN_ALREADY_FINALIZED'});
    }});
    await worker.tick();await worker.stop();expect(publish).toHaveBeenCalledOnce();expect(storage.renew).toHaveBeenCalledOnce();
    expect(storage.finish).not.toHaveBeenCalled();expect(storage.observeFinalization).not.toHaveBeenCalled();expect(log.error).not.toHaveBeenCalled();
  });
  it('drains an in-flight heartbeat and pauses all later renewals before publication',async()=>{
    vi.useFakeTimers();
    try {
      const rows=[{id:'drain',thread_id:'thread',status:'queued'}],storage=store(rows);
      let releaseRenew:(value:boolean)=>void=()=>{},releaseProcess:()=>void=()=>{};
      const gate=new Promise<void>(resolve=>{releaseProcess=resolve;});
      storage.renew.mockImplementationOnce(()=>new Promise<boolean>(resolve=>{releaseRenew=resolve;}));
      const publish=vi.fn(async()=>{rows[0]!.status='completed';return true;});
      const worker=createInboundTurnWorker({storage,logger:{error:vi.fn()},heartbeatMs:10,processTurn:async()=>{await gate;await requireInboundTurnLease().finalizeCurrent!(publish);}});
      await worker.tick();await vi.advanceTimersByTimeAsync(10);expect(storage.renew).toHaveBeenCalledOnce();
      releaseProcess();await vi.advanceTimersByTimeAsync(100);expect(publish).not.toHaveBeenCalled();expect(storage.renew).toHaveBeenCalledOnce();
      releaseRenew(true);await worker.stop();expect(publish).toHaveBeenCalledOnce();expect(storage.renew).toHaveBeenCalledTimes(2);expect(storage.finish).not.toHaveBeenCalled();
    } finally {vi.useRealTimers();}
  });
  it('admits one publication when two finalizers run simultaneously',async()=>{
    const rows=[{id:'once',thread_id:'thread',status:'queued'}],storage=store(rows);let results:PromiseSettledResult<void>[]=[];
    const publish=vi.fn(async()=>{rows[0]!.status='completed';return true;});
    const worker=createInboundTurnWorker({storage,logger:{error:vi.fn()},processTurn:async()=>{
      const finalize=requireInboundTurnLease().finalizeCurrent!;results=await Promise.allSettled([finalize(publish),finalize(publish)]);
    }});await worker.tick();await worker.stop();expect(results.filter(result=>result.status==='fulfilled')).toHaveLength(1);expect(publish).toHaveBeenCalledOnce();expect(storage.finish).not.toHaveBeenCalled();
  });
  it('observes a committed lost publication response under the exact old token without replay',async()=>{
    const rows=[{id:'receipt',message_id:'message',thread_id:'thread',lease_token:'private',status:'queued'}],storage=store(rows),log={error:vi.fn()};
    storage.observeFinalization.mockResolvedValue(true);
    const processTurn=vi.fn(async()=>{await requireInboundTurnLease().finalizeCurrent!(async()=>{rows[0]!.status='completed';throw new Error('lost after commit');});});
    const worker=createInboundTurnWorker({storage,logger:log,processTurn});await worker.tick();await worker.stop();
    expect(storage.observeFinalization).toHaveBeenCalledWith(expect.objectContaining({id:'receipt',lease_token:'private'}));
    expect(storage.observeFinalization).toHaveBeenCalledOnce();expect(storage.finish).not.toHaveBeenCalled();expect(log.error).not.toHaveBeenCalled();
    const restart=createInboundTurnWorker({storage,logger:log,processTurn});await restart.tick();await restart.stop();expect(processTurn).toHaveBeenCalledOnce();
  });
  it.each(['unconfirmed','observerUnavailable'] as const)('never downgrades or renews an %s publication',async kind=>{
    const rows=[{id:'uncertain',thread_id:'thread',status:'queued'}],storage=store(rows),log={error:vi.fn()};
    if(kind==='observerUnavailable')storage.observeFinalization.mockRejectedValue(new Error('private unavailable'));
    const worker=createInboundTurnWorker({storage,logger:log,processTurn:async()=>{
      await requireInboundTurnLease().finalizeCurrent!(async()=>{throw new Error('publication outcome unavailable');});
    }});await worker.tick();await worker.stop();expect(storage.finish).not.toHaveBeenCalled();expect(storage.renew).toHaveBeenCalledOnce();
    expect(log.error).toHaveBeenCalledWith(expect.stringContaining('outcome=unknown'));expect(rows[0]!.status).toBe('running');
  });
  it('preserves an acknowledged completion when the handler subsequently throws',async()=>{
    const rows=[{id:'after',thread_id:'thread',status:'queued'}],storage=store(rows),log={error:vi.fn()};
    const worker=createInboundTurnWorker({storage,logger:log,processTurn:async()=>{
      await requireInboundTurnLease().finalizeCurrent!(async()=>{rows[0]!.status='completed';return true;});throw new Error('after closure');
    }});await worker.tick();await worker.stop();expect(storage.finish).not.toHaveBeenCalled();expect(rows[0]!.status).toBe('completed');
    expect(log.error).toHaveBeenCalledWith(expect.stringContaining('outcome=completed'));
  });
  it('blocks publication when the ownership renewal fails',async()=>{
    const rows=[{id:'lost',thread_id:'thread',status:'queued'}],storage=store(rows);storage.renew.mockResolvedValue(false);const publish=vi.fn(async()=>true);
    const worker=createInboundTurnWorker({storage,logger:{error:vi.fn()},processTurn:async()=>{await requireInboundTurnLease().finalizeCurrent!(publish);}});
    await worker.tick();await worker.stop();expect(publish).not.toHaveBeenCalled();expect(storage.finish).not.toHaveBeenCalled();
  });
  it('bounds an uncooperative publication and drains shutdown without replay',async()=>{
    vi.useFakeTimers();
    try {
      const rows=[{id:'timeout',thread_id:'thread',status:'queued'}],storage=store(rows),publish=vi.fn(()=>new Promise<boolean>(()=>{}));
      const worker=createInboundTurnWorker({storage,logger:{error:vi.fn()},processTurn:async()=>{await requireInboundTurnLease().finalizeCurrent!(publish);}});
      await worker.tick();await vi.advanceTimersByTimeAsync(15001);await worker.stop();expect(publish).toHaveBeenCalledOnce();expect(storage.finish).not.toHaveBeenCalled();
    } finally {vi.useRealTimers();}
  });
});
