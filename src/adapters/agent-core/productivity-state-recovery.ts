import {
  productivityCheckpointSchema, type ProductivityConversation, type TurnContext,
} from '@templelabs/contracts';
import { readPriorInboundTurn, inboundStoredTurnSchema, type InboundCheckpointClient } from './inbound-checkpoint-reader.js';
import { recoverActiveTurnCompletion } from './active-turn-completion.js';
import { recoverActiveRunHandoff } from './active-run-resolution.js';

export interface ProductivityStateRecoveryPort {
  load(context: TurnContext, threadId: string): Promise<ProductivityConversation | undefined>;
}
export interface ProductivityReconciliationReport {
  readonly runId: string;
  readonly reason: 'unknown_turn' | 'invalid_checkpoint' | 'engine_handoff_required';
  readonly pendingEffectIds: readonly string[];
  readonly pendingDeliveryIds: readonly string[];
  readonly hasCompletedConversation: boolean;
}
export function inspectProductivityTurn(raw: unknown, userId: string): ProductivityReconciliationReport {
  const row = inboundStoredTurnSchema.parse(raw);
  const parsed = productivityCheckpointSchema.safeParse(row.response?.agentCoreProductivity);
  if (!parsed.success || parsed.data.userId !== userId || parsed.data.runId !== row.id || parsed.data.requestId !== row.message_id) {
    return { runId: row.id, reason: Object.hasOwn(row.response ?? {}, 'agentCoreProductivity') ? 'invalid_checkpoint' : 'engine_handoff_required',
      pendingEffectIds: [], pendingDeliveryIds: [], hasCompletedConversation: false };
  }
  const state = parsed.data;
  return { runId: row.id, reason: 'unknown_turn',
    pendingEffectIds: state.effects.filter(effect => (!effect.item && !effect.call?.name.endsWith('_read')
      && effect.call?.name !== 'calendar_connect') || effect.item?.status === 'indeterminate'
      || (effect.item?.status === 'partial' && effect.item.result
        && ((effect.item.domain === 'calendar' && effect.item.result.companion === 'unconfirmed')
          || ('issues' in effect.item.result && effect.item.result.issues.some(issue => issue.code === 'COMPANION_OUTCOME_UNVERIFIED')))))
      .map(effect => effect.call?.id ?? effect.item!.callId),
    pendingDeliveryIds: state.deliveries.filter(entry => entry.status === 'attempted' || entry.status === 'unknown').map(entry => entry.message.id),
    hasCompletedConversation: state.completed !== null };
}
function blocked(report: ProductivityReconciliationReport): never {
  throw Object.assign(new Error('Prior turn requires reconciliation or engine handoff'), { code: 'PRIOR_TURN_RECONCILIATION_REQUIRED', report });
}
/** Only completed mixed checkpoints are admitted. Unknown/foreign versions require a separate evidence-based handoff. */
export function createProductivityStateRecovery(client: InboundCheckpointClient): ProductivityStateRecoveryPort {
  return { async load(context, threadId) {
    const row = await readPriorInboundTurn(client, context, threadId, prior => blocked(inspectProductivityTurn(prior, context.userId)));
    if (!row) return undefined;
    return recoverProductivityStoredTurn(row, context.userId);
  } };
}

/** Semantic import only: an authenticated reader must establish ordering and ownership first. */
export function recoverProductivityStoredTurn(raw: unknown, userId: string): ProductivityConversation {
  const row = inboundStoredTurnSchema.parse(raw);
  if (row.status !== 'completed') blocked(inspectProductivityTurn(row, userId));
  if (Object.hasOwn(row.response ?? {}, 'agentCoreActiveCompletion')) {
    try { return recoverActiveTurnCompletion(row,userId); }
    catch { blocked(inspectProductivityTurn(row,userId)); }
  }
  if (Object.hasOwn(row.response ?? {}, 'agentCoreActiveResolution')) {
    try { return recoverActiveRunHandoff(row, userId); }
    catch { blocked(inspectProductivityTurn(row, userId)); }
  }
  const parsed = productivityCheckpointSchema.safeParse(row.response?.agentCoreProductivity);
  if (['agentCore', 'agentCoreResolution', 'agentCoreActiveRun', 'agentCoreDeliveryManifest', 'agentCoreBaseline'].some(key => Object.hasOwn(row.response ?? {}, key))
    || !parsed.success || parsed.data.userId !== userId || parsed.data.runId !== row.id
    || parsed.data.requestId !== row.message_id || row.status !== 'completed' || parsed.data.phase !== 'completed') {
    blocked(inspectProductivityTurn(row, userId));
  }
  return structuredClone(parsed.data.completed!.conversation);
}
