import { describe, expect, it, vi } from 'vitest';
import type { JsonObject } from '@templelabs/contracts';
import { createInboundTurnPersistence, type InboundPersistenceQuery } from '../../../src/infrastructure/database/inbound-turn-persistence.js';
import { requireInboundTurnLease } from '../../../src/agent/core/turn-lease.js';
import { createInboundTurnWorker, type ClaimedInboundTurn } from '../../../src/jobs/inbound-turn-worker.js';

const turn: ClaimedInboundTurn = { id: 'turn',message_id: 'message',thread_id: 'thread',lease_token: 'private',request: { text: 'Hola' } };
function fixture() {
  const abort = vi.fn(async (_signal: AbortSignal): Promise<{ data: unknown; error: unknown }> => ({ data: true,error: null }));
  const query: InboundPersistenceQuery = { abortSignal: abort,upsert: vi.fn(() => query),select: vi.fn(() => query),limit: vi.fn(() => query),
    then: (resolve,reject) => abort(new AbortController().signal).then(resolve,reject) };
  const rpc = vi.fn((_name: string,_args?: JsonObject) => query), from = vi.fn((_table: 'hermes_inbound_turns') => query);
  const getClient = vi.fn(() => ({ rpc,from }));
  const store = createInboundTurnPersistence(getClient);
  return { store,query,abort,rpc,from,getClient };
}
describe('typed inbound persistence', () => {
  it('defers the client until an operation, preserving the shared index export cycle', () => {
    const f = fixture(); expect(f.getClient).not.toHaveBeenCalled();
  });
  it('enqueues once using an immutable message identity and ignores an existing duplicate', async () => {
    const f = fixture(); f.abort.mockResolvedValueOnce({ data: [{ id: 'new' }],error: null }).mockResolvedValueOnce({ data: [],error: null });
    const input = { messageId: 'message',threadId: 'thread',request: { text: 'Hola' } };
    expect(await f.store.enqueueInboundTurn(input)).toEqual({ inserted: true });
    expect(await f.store.enqueueInboundTurn(input)).toEqual({ inserted: false });
    expect(f.query.upsert).toHaveBeenCalledWith({ message_id: 'message',thread_id: 'thread',request: input.request },{ onConflict: 'message_id',ignoreDuplicates: true });
    expect(f.query.select).toHaveBeenCalledWith('id');
  });
  it.each([null,{},[{ id: 'one' },{ id: 'two' }],[{}]])('rejects invalid enqueue response %j without retry', async data => {
    const f = fixture(); f.abort.mockResolvedValueOnce({ data,error: null });
    await expect(f.store.enqueueInboundTurn({ messageId: 'm',threadId: 't',request: {} })).rejects.toMatchObject({ code: 'INBOUND_STORAGE_UNAVAILABLE' });
    expect(f.abort).toHaveBeenCalledOnce();
  });
  it('rejects a missing message identity before touching storage', async () => {
    const f = fixture(); await expect(f.store.enqueueInboundTurn({ messageId: '',threadId: 'thread',request: {} })).rejects.toThrow();
    expect(f.getClient).not.toHaveBeenCalled();
  });
  it('loads at most one owned turn and distinguishes an empty queue', async () => {
    const f = fixture(); f.abort.mockResolvedValueOnce({ data: [{ ...turn,sequence_id: 7 }],error: null }).mockResolvedValueOnce({ data: [],error: null });
    expect(await f.store.inboundTurnStorage.claim('thread')).toMatchObject({ ...turn,sequence_id: 7 });
    expect(await f.store.inboundTurnStorage.claim()).toBeNull();
    expect(f.rpc.mock.calls).toEqual([['claim_hermes_inbound_turn',{ p_thread_id: 'thread' }],['claim_hermes_inbound_turn',{ p_thread_id: null }]]);
    expect(f.abort.mock.calls.every(([signal]) => signal instanceof AbortSignal)).toBe(true);
  });
  it.each([null,{},[{ ...turn,lease_token: '' }],[{ ...turn,request: null }],[turn,turn]])('rejects malformed/oversized claims %j', async data => {
    const f = fixture(); f.abort.mockResolvedValueOnce({ data,error: null });
    await expect(f.store.inboundTurnStorage.claim()).rejects.toMatchObject({ code: 'INBOUND_STORAGE_UNAVAILABLE' }); expect(f.abort).toHaveBeenCalledOnce();
  });
  it('binds all queue mutations and lost-finalization observation to the exact owner nonce', async () => {
    const f = fixture(), storage = f.store.inboundTurnStorage;
    await storage.renew(turn); await storage.checkpoint(turn,{ verified: true });
    await storage.resolvePrior!(turn,'prior',{ source: true },{ completed: true });
    await storage.observeFinalization!(turn); await storage.finish(turn,'unknown','UNCERTAIN');
    expect(f.rpc.mock.calls).toEqual([
      ['renew_hermes_inbound_turn',{ p_id: 'turn',p_token: 'private' }],
      ['checkpoint_hermes_inbound_turn',{ p_id: 'turn',p_token: 'private',p_response: { verified: true } }],
      ['resolve_hermes_prior_turn',{ p_owner_id: 'turn',p_owner_token: 'private',p_target_id: 'prior',p_expected_response: { source: true },p_resolution: { completed: true } }],
      ['was_completed_hermes_active_turn',{ p_id: 'turn',p_token: 'private' }],
      ['finish_hermes_inbound_turn',{ p_id: 'turn',p_token: 'private',p_status: 'unknown',p_error: 'UNCERTAIN' }],
    ]);
  });
  it.each([null,1,'true',{},[]])('does not turn malformed acknowledgement %j into authority', async data => {
    const f = fixture(); f.abort.mockResolvedValueOnce({ data,error: null });
    await expect(f.store.inboundTurnStorage.renew(turn)).rejects.toMatchObject({ code: 'INBOUND_STORAGE_UNAVAILABLE' }); expect(f.rpc).toHaveBeenCalledOnce();
  });
  it('preserves a denied boolean acknowledgement and performs no fallback/retry', async () => {
    const f = fixture(); f.abort.mockResolvedValueOnce({ data: false,error: null });
    expect(await f.store.inboundTurnStorage.finish(turn,'completed')).toBe(false); expect(f.abort).toHaveBeenCalledOnce();
  });
  it('preserves the persistence error cause instead of substituting a successful acknowledgement', async () => {
    const f = fixture(), cause = { message: 'SQL unavailable' }; f.abort.mockResolvedValueOnce({ data: true,error: cause });
    await expect(f.store.inboundTurnStorage.checkpoint(turn,{})).rejects.toMatchObject({ code: 'INBOUND_STORAGE_UNAVAILABLE',cause });
  });
  it('checks readiness through a zero-row read and version lookup without mutation', async () => {
    const f = fixture(); f.abort.mockResolvedValueOnce({ data: [],error: null }).mockResolvedValueOnce({ data: 1,error: null });
    await f.store.assertInboundQueueReady(); expect(f.query.limit).toHaveBeenCalledWith(0); expect(f.rpc).toHaveBeenCalledWith('hermes_inbound_queue_version');
    expect(f.query.upsert).not.toHaveBeenCalled();
  });
  it('rejects unsupported queue versions', async () => {
    const f = fixture(); f.abort.mockResolvedValueOnce({ data: [],error: null }).mockResolvedValueOnce({ data: 2,error: null });
    await expect(f.store.assertInboundQueueReady()).rejects.toThrow('Unsupported inbound queue schema');
  });
  it('the actual worker stops a guarded effect after an uncertain renewal', async () => {
    const f = fixture(); f.abort.mockResolvedValueOnce({ data: [turn],error: null }).mockResolvedValueOnce({ data: null,error: null });
    const effect = vi.fn(), processTurn = async () => { await requireInboundTurnLease().assertActive(); effect(); }, logger = { error: vi.fn() };
    const worker = createInboundTurnWorker({ processTurn,storage: f.store.inboundTurnStorage,logger,concurrency: 1 });
    await worker.tick(); await worker.stop(); expect(effect).not.toHaveBeenCalled();
    expect(f.rpc.mock.calls.map(([name]) => name)).toEqual(['claim_hermes_inbound_turn','renew_hermes_inbound_turn']);
  });
});
