import { AsyncLocalStorage } from 'node:async_hooks';
import type { JsonObject } from '@templelabs/contracts';

export interface InboundTurnLease {
  readonly inboundTurn: { readonly id: string; readonly messageId: string; readonly threadId: string; readonly response: JsonObject };
  readonly signal: AbortSignal;
  assertActive(): Promise<void>;
  checkpoint(response: JsonObject): Promise<void>;
  resolvePrior?(runId: string, expectedResponse: JsonObject, resolution: JsonObject): Promise<void>;
  /** Backend-only publication boundary: suspend/drain renewals before retiring this lease. */
  finalizeCurrent?(publish: () => Promise<boolean>): Promise<void>;
}
type AmbientTurn = Partial<InboundTurnLease> & Pick<InboundTurnLease, 'signal' | 'assertActive'>;
// Mixed source/emitted loaders may load this module twice. Share one immutable, versioned context per process.
const contextKey = Symbol.for('templelabs.hermes.inbound-turn-lease.v1');
const runtime = globalThis as typeof globalThis & { [contextKey]?: AsyncLocalStorage<AmbientTurn> };
let turnContext = runtime[contextKey];
if (turnContext === undefined) {
  turnContext = new AsyncLocalStorage<AmbientTurn>();
  Object.defineProperty(runtime,contextKey,{value:turnContext,writable:false,configurable:false,enumerable:false});
} else if (!(turnContext instanceof AsyncLocalStorage)) {
  throw new Error('INBOUND_CONTEXT_RUNTIME_MISMATCH');
}
const ambient = turnContext;

export function withTurnLease<T>(context: AmbientTurn, work: () => T): T { return ambient.run(context, work); }
export function withoutTurnLease<T>(work: () => T): T { return ambient.exit(work); }
/** CLI/background jobs have no ambient inbound owner. */
export async function assertTurnLease(): Promise<void> { await ambient.getStore()?.assertActive(); }
export async function checkpointTurnResponse(response: JsonObject): Promise<void> {
  const lease = ambient.getStore();
  if (!lease) return;
  if (!lease.checkpoint) throw Object.assign(new Error('A durable inbound turn lease is required.'), { code: 'INBOUND_LEASE_REQUIRED' });
  await lease.checkpoint(response);
}
export function currentTurnSignal(): AbortSignal | undefined { return ambient.getStore()?.signal; }
export function requireInboundTurnLease(): InboundTurnLease {
  const lease = ambient.getStore();
  if (!lease?.inboundTurn || !lease.signal || !lease.assertActive || !lease.checkpoint) {
    throw Object.assign(new Error('A durable inbound turn lease is required.'), { code: 'INBOUND_LEASE_REQUIRED' });
  }
  return lease as InboundTurnLease;
}
