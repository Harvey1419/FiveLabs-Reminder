import type { JsonObject } from '@templelabs/contracts';
import { isAdmissionRejection } from '../agent/core/admission-rejection.js';
import { withTurnLease } from '../agent/core/turn-lease.js';

export interface ClaimedInboundTurn {
  readonly id: string; readonly message_id: string; readonly thread_id: string;
  readonly lease_token: string; readonly request: JsonObject; readonly response?: JsonObject | null;
}
export interface InboundTurnWorkerStorage {
  claim(): Promise<ClaimedInboundTurn | null>;
  renew(turn: ClaimedInboundTurn): Promise<boolean>;
  checkpoint(turn: ClaimedInboundTurn, response: JsonObject): Promise<boolean>;
  finish(turn: ClaimedInboundTurn, status: 'completed' | 'unknown', error?: string): Promise<boolean>;
  resolvePrior?(turn: ClaimedInboundTurn, runId: string, expected: JsonObject, resolution: JsonObject): Promise<boolean>;
  /** True only for a closed completion published under this exact retired token. */
  observeFinalization?(turn: ClaimedInboundTurn): Promise<boolean>;
}
export interface InboundTurnWorkerOwner { readonly id: string; readonly token: string }
interface WorkerPolicy {
  readonly storage: InboundTurnWorkerStorage;
  readonly heartbeatMs?: number; readonly concurrency?: number;
  readonly logger?: Pick<Console, 'error'>;
}
export type InboundTurnWorkerOptions = WorkerPolicy & (
  { readonly processTurn: (request: JsonObject) => Promise<unknown>; readonly processOwnedTurn?: never }
  | { readonly processTurn?: never; readonly processOwnedTurn: (request: JsonObject, owner: InboundTurnWorkerOwner) => Promise<unknown> }
);
function fail(code: string): Error { return Object.assign(new Error(code), { code }); }
function errorCode(error: unknown, fallback: string): string {
  return error !== null && typeof error === 'object' && 'code' in error && typeof error.code === 'string' ? error.code : fallback;
}
async function bounded<T>(work: () => Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve,reject) => { timer = setTimeout(() => reject(fail('INBOUND_STORAGE_UNAVAILABLE')),15000); });
  try { return await Promise.race([Promise.resolve().then(work),timeout]); }
  finally { if (timer) clearTimeout(timer); }
}
/** Pure typed worker; the legacy compatibility module supplies the existing database adapter. */
export function createInboundTurnWorker({ processTurn, processOwnedTurn, storage, heartbeatMs = 15000, concurrency = 2, logger = console }: InboundTurnWorkerOptions) {
  if ((!processTurn && !processOwnedTurn) || (processTurn && processOwnedTurn) || !Number.isSafeInteger(concurrency) || concurrency < 1 || !Number.isFinite(heartbeatMs) || heartbeatMs <= 0) throw fail('INVALID_INBOUND_WORKER_OPTIONS');
  let stopped = false, polling = false;
  const active = new Set<Promise<void>>();
  let pollFinished = Promise.resolve();
  async function execute(turn: ClaimedInboundTurn): Promise<void> {
    type State = 'leased' | 'finalizing' | 'completed' | 'uncertain' | 'lost';
    let state: State = 'leased';
    const current = (): State => state;
    const controller = new AbortController();
    let renewing: Promise<void> | null = null;
    const pendingRenewal = () => renewing;
    const renew = async () => {
      if (!renewing) renewing = Promise.resolve().then(() => bounded(() => storage.renew(turn))).then(ok => {
        if (!ok) throw fail('TURN_LEASE_LOST');
      }).catch(error => { state = 'lost'; controller.abort(error); throw error; }).finally(() => { renewing = null; });
      await renewing;
    };
    const assertActive = async () => {
      if (current() !== 'leased') throw fail(current() === 'completed' ? 'TURN_ALREADY_FINALIZED' : 'TURN_LEASE_LOST');
      await renew();
      if (current() !== 'leased') throw fail('TURN_LEASE_LOST');
    };
    const interval = setInterval(() => { assertActive().catch(() => {}); }, heartbeatMs);
    interval.unref();
    const finalizeCurrent = async (publish: () => Promise<boolean>) => {
      if (current() !== 'leased') throw fail('TURN_LEASE_LOST');
      // Synchronous admission prevents a heartbeat or second finalizer from opening another renewal.
      state = 'finalizing'; clearInterval(interval);
      try {
        await renewing;
        if (current() === 'lost') throw fail('TURN_LEASE_LOST');
        await renew();
        if (!await bounded(publish)) throw fail('TURN_FINALIZATION_CONFLICT');
        state = 'completed';
      } catch (error) {
        if (current() !== 'lost') state = 'uncertain';
        throw error;
      }
    };
    const observedCompletion = async () => {
      if (!storage.observeFinalization) return false;
      try { if (await bounded(() => storage.observeFinalization!(turn))) { state = 'completed'; return true; } }
      catch { /* An unavailable observer cannot establish a completed turn. */ }
      return false;
    };
    try {
      await withTurnLease({
        inboundTurn: Object.freeze({ id: turn.id, messageId: turn.message_id, threadId: turn.thread_id, response: structuredClone(turn.response ?? {}) }),
        assertActive, signal: controller.signal, finalizeCurrent,
        resolvePrior: async (runId, expected, resolution) => {
          await assertActive();
          if (!storage.resolvePrior || !await bounded(() => storage.resolvePrior!(turn,runId,expected,resolution))) throw fail('TURN_RESOLUTION_CONFLICT');
        },
        checkpoint: async response => {
          await assertActive();
          if (!await bounded(() => storage.checkpoint(turn,response))) { state = 'lost'; controller.abort(); throw fail('TURN_LEASE_LOST'); }
        },
      }, () => processOwnedTurn ? processOwnedTurn(turn.request,Object.freeze({id:turn.id,token:turn.lease_token})) : processTurn!(turn.request));
      if (current() === 'completed') return;
      if (current() === 'uncertain') throw fail('TURN_FINALIZATION_UNCERTAIN');
      await assertActive();
      if (!await bounded(() => storage.finish(turn,'completed'))) { const error=fail('TURN_LEASE_LOST');state='lost';controller.abort(error);throw error; }
      state = 'completed';
    } catch (error) {
      if (current() === 'completed') {
        logger.error(`[inbound] turn=${turn.id} outcome=completed code=POST_FINALIZATION_HANDLER_ERROR`);
        return;
      }
      if (current() === 'uncertain' && await observedCompletion()) return;
      if (current() === 'leased' && isAdmissionRejection(error)) {
        await assertActive();
        const code = errorCode(error, 'ADMISSION_REJECTED');
        if (!await bounded(() => storage.finish(turn, 'completed', code))) { state = 'lost'; controller.abort(); return; }
        state = 'completed';
        logger.error(`[inbound] turn=${turn.id} outcome=admission_rejected code=${code}`);
        return;
      }
      const code = errorCode(error,'PROCESSING_INTERRUPTED');
      logger.error(`[inbound] turn=${turn.id} outcome=unknown code=${code}`);
      // An uncertain publication never permits renewal, legacy downgrade or handler replay.
      if (current() === 'leased') await bounded(() => storage.finish(turn,'unknown',code)).catch(() => {});
    } finally { clearInterval(interval); await pendingRenewal()?.catch(() => {}); }
  }
  async function tick(): Promise<void> {
    if (stopped || polling) return;
    polling = true;
    let finishPoll: () => void = () => {};
    pollFinished = new Promise<void>(resolve => { finishPoll = resolve; });
    try {
      while (!stopped && active.size < concurrency) {
        const turn = await bounded(() => storage.claim());
        if (!turn) break;
        const task = execute(turn); active.add(task);
        task.finally(() => active.delete(task)).catch(() => {});
      }
    } catch (error) { logger.error(`[inbound] queue unavailable code=${errorCode(error,'STORAGE_ERROR')}`); }
    finally { polling = false; finishPoll(); }
  }
  return { tick, async stop() { stopped = true; await pollFinished; await Promise.allSettled([...active]); }, get activeCount() { return active.size; } };
}
export function startInboundTurnWorker(processTurn: (request: JsonObject) => Promise<unknown>, storage: InboundTurnWorkerStorage) {
  const worker = createInboundTurnWorker({processTurn,storage});
  const interval = setInterval(() => { void worker.tick(); },500); interval.unref(); void worker.tick();
  return { async stop() { clearInterval(interval); await worker.stop(); } };
}
