import type { InboundTurnLease } from '../../agent/core/turn-lease.js';
const claimedLeases = new WeakSet<object>();
/** Synchronous admission is shared across engines; no second execution on the same lease. */
export function claimAgentCoreLease(lease: InboundTurnLease, engine?: 'active_run'): void {
  if ((engine !== 'active_run' && Object.hasOwn(lease.inboundTurn.response, 'agentCoreBaseline')) || claimedLeases.has(lease) || ['agentCore', 'agentCoreProductivity', 'agentCoreActiveRun', 'agentCoreActiveResolution','agentCoreActiveCompletion', 'agentCoreDeliveryManifest'].some(key => Object.hasOwn(lease.inboundTurn.response, key))) {
    throw Object.assign(new Error('Inbound turn requires reconciliation'), { code: 'INBOUND_RECONCILIATION_REQUIRED' });
  }
  claimedLeases.add(lease);
}
