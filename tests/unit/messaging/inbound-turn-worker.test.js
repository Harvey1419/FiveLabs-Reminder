import { describe, expect, it, vi } from 'vitest';
import { createInboundTurnWorker } from '../../../src/jobs/inbound-turn-worker.js';
import { assertTurnLease, checkpointTurnResponse, currentTurnSignal } from '../../../src/agent/core/turn-lease.js';

function store(rows) {
  return {
    claim: vi.fn(async () => {
      const row = rows.find(row => row.status === 'queued' && !rows.some(other => other.thread_id === row.thread_id && other.status === 'running'));
      if (!row) return null;
      row.status = 'running';
      return { ...row, request: { id: row.id } };
    }),
    renew: vi.fn(async () => true),
    checkpoint: vi.fn(async () => true),
    finish: vi.fn(async (turn, status) => { rows.find(row => row.id === turn.id).status = status; return true; }),
  };
}
const logger = { error: vi.fn() };

describe('durable inbound worker boundaries', () => {
  it('lets independent workers process different users while one user remains serialized', async () => {
    const storage = store([{ id: 'a1', thread_id: 'a', status: 'queued' }, { id: 'a2', thread_id: 'a', status: 'queued' }, { id: 'b1', thread_id: 'b', status: 'queued' }]);
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    const started = [];
    const processTurn = async req => { started.push(req.id); await assertTurnLease(); if (req.id === 'a1') await gate; };
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
    expect(rows[0].status).toBe('unknown');
  });
  it('blocks effects and aborts in-flight database requests when ownership is lost', async () => {
    const storage = store([{ id: 'a1', thread_id: 'a', status: 'queued' }]);
    storage.renew.mockResolvedValue(false);
    const effect = vi.fn();
    let signal;
    const worker = createInboundTurnWorker({ storage, logger, processTurn: async () => {
      signal = currentTurnSignal();
      await assertTurnLease();
      effect();
    } });
    await worker.tick();
    await worker.stop();
    expect(effect).not.toHaveBeenCalled();
    expect(signal.aborted).toBe(true);
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
    let release;
    const claimed = storage.claim;
    storage.claim = vi.fn(async () => { await new Promise(resolve => { release = resolve; }); return claimed(); });
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
    expect(rows[0].status).toBe('completed');
  });

});
