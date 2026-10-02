import { inboundTurnStorage } from '../infrastructure/database/inbound-turns.js';
import { withTurnLease } from '../agent/core/turn-lease.js';

function lostLease() {
  return Object.assign(new Error('Inbound turn ownership could not be confirmed.'), { code: 'TURN_LEASE_LOST' });
}

export function createInboundTurnWorker({ processTurn, storage = inboundTurnStorage, heartbeatMs = 15000, concurrency = 2, logger = console }) {
  let stopped = false;
  const active = new Set();
  let polling = false;
  let pollFinished = Promise.resolve();

  async function execute(turn) {
    let lost = false;
    const controller = new AbortController();
    let renewing = null;
    const assertActive = async () => {
      if (lost) throw lostLease();
      // Coalesce heartbeat and effect-boundary renewals to one bounded request.
      if (!renewing) renewing = Promise.resolve().then(() => storage.renew(turn)).then(ok => {
        if (!ok) throw lostLease();
      }).catch(error => { lost = true; controller.abort(error); throw error; }).finally(() => { renewing = null; });
      await renewing;
    };
    const interval = setInterval(() => { assertActive().catch(() => {}); }, heartbeatMs);
    interval.unref?.();
    try {
      await withTurnLease({
        assertActive,
        signal: controller.signal,
        checkpoint: async response => {
          await assertActive();
          if (!await storage.checkpoint(turn, response)) { lost = true; controller.abort(); throw lostLease(); }
        },
      }, () => processTurn(turn.request));
      await assertActive();
      if (!await storage.finish(turn, 'completed')) throw lostLease();
    } catch (error) {
      logger.error(`[inbound] turn=${turn.id} outcome=unknown code=${error.code || 'PROCESSING_INTERRUPTED'}`);
      // Never replay a handler that may have applied domain effects or sent a reply.
      if (!lost) await storage.finish(turn, 'unknown', error.code || 'PROCESSING_INTERRUPTED').catch(() => {});
    } finally {
      clearInterval(interval);
      await renewing?.catch(() => {});
    }
  }

  async function tick() {
    if (stopped || polling) return;
    polling = true;
    let finishPoll;
    pollFinished = new Promise(resolve => { finishPoll = resolve; });
    try {
      while (!stopped && active.size < concurrency) {
        const turn = await storage.claim();
        if (!turn) break;
        const task = execute(turn);
        active.add(task);
        task.finally(() => active.delete(task)).catch(() => {});
      }
    } catch (error) {
      logger.error(`[inbound] queue unavailable code=${error.code || 'STORAGE_ERROR'}`);
    } finally { polling = false; finishPoll(); }
  }

  return {
    tick,
    async stop() { stopped = true; await pollFinished; await Promise.allSettled([...active]); },
    get activeCount() { return active.size; },
  };
}

export function startInboundTurnWorker(processTurn) {
  const worker = createInboundTurnWorker({ processTurn });
  const interval = setInterval(() => { void worker.tick(); }, 500);
  interval.unref?.();
  void worker.tick();
  return { async stop() { clearInterval(interval); await worker.stop(); } };
}
