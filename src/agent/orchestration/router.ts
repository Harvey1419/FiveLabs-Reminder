import { routeMessage as baseline } from './router-core.js';
import { createCanaryRouter } from './canary-router.js';
import { readCanaryPolicy } from './canary-selector.js';
import { requireInboundTurnLease } from '../core/turn-lease.js';
import { readPriorInboundTurn, type InboundCheckpointClient } from '../../adapters/agent-core/inbound-checkpoint-reader.js';
import { supabase } from '../../infrastructure/database/index.js';

export const routeMessage = createCanaryRouter({
  baseline,
  policy: () => readCanaryPolicy(),
  lease: () => {
    try { return requireInboundTurnLease(); }
    catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'INBOUND_LEASE_REQUIRED') return null;
      throw error;
    }
  },
  readPrior: (context, threadId) => readPriorInboundTurn(supabase as unknown as InboundCheckpointClient, context, threadId, () => {
    throw Object.assign(new Error('Prior turn requires reconciliation'), { code: 'PRIOR_TURN_RECONCILIATION_REQUIRED' });
  }),
  handoff: async (prior, context, threadId, history) => {
    const { createBaselineHandoffSource, handoffBaselineProductivity } = await import('../../adapters/agent-core/baseline-productivity-handoff.js');
    const source = createBaselineHandoffSource(supabase as unknown as InboundCheckpointClient, async (id, ctx, raw) => {
      const { readOwnedBaselineEvent } = await import('../../adapters/agent-core/baseline-calendar-handoff.js');
      return readOwnedBaselineEvent(id, ctx, raw);
    });
    return handoffBaselineProductivity(prior, context, threadId, history, source);
  },
  v2: async (...args) => (await import('../../adapters/agent-core/canary-productivity-router.js')).routeCanaryProductivity(...args),
});
