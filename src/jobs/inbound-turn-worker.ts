import { inboundTurnStorage } from '../infrastructure/database/inbound-turns.js';
import { createInboundTurnWorker as createWorker, startInboundTurnWorker as startWorker } from './inbound-turn-worker-core.js';
import type { InboundTurnWorkerOptions, InboundTurnWorkerStorage } from './inbound-turn-worker-core.js';
export type { ClaimedInboundTurn, InboundTurnWorkerStorage, InboundTurnWorkerOptions, InboundTurnWorkerOwner } from './inbound-turn-worker-core.js';
type OptionalStorage<T> = T extends unknown ? Omit<T, 'storage'> & { storage?: InboundTurnWorkerStorage } : never;
export function createInboundTurnWorker(options: OptionalStorage<InboundTurnWorkerOptions>) {
  return createWorker({ ...options, storage: options.storage === undefined ? inboundTurnStorage : options.storage } as InboundTurnWorkerOptions);
}
export function startInboundTurnWorker(processTurn: Parameters<typeof startWorker>[0], storage: InboundTurnWorkerStorage = inboundTurnStorage, idlePollIntervalMs?: number) { return startWorker(processTurn, storage, idlePollIntervalMs); }
