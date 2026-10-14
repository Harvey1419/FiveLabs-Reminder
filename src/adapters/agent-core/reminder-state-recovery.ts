import { reminderCheckpointSchema, reminderResolutionSchema, type ReminderConversation, type TurnContext } from '@templelabs/contracts';
import { checkpointFingerprint } from './checkpoint-fingerprint.js';
import { readPriorInboundTurn, inboundStoredTurnSchema as rowSchema, type InboundCheckpointClient } from './inbound-checkpoint-reader.js';
export { inboundStoredTurnSchema as reminderStoredTurnSchema } from './inbound-checkpoint-reader.js';
export type { InboundStoredTurn as ReminderStoredTurn } from './inbound-checkpoint-reader.js';
export type ReminderCheckpointClient = InboundCheckpointClient;

export interface ReminderStateRecoveryPort {
  load(context: TurnContext, threadId: string): Promise<ReminderConversation | undefined>;
}
export interface ReminderReconciliationReport {
  readonly runId: string;
  readonly reason: 'unknown_turn' | 'invalid_checkpoint' | 'legacy_handoff_required';
  readonly pendingEffectIds: readonly string[];
  readonly pendingDeliveryIds: readonly string[];
  readonly hasCompletedConversation: boolean;
}

function blocked(report: ReminderReconciliationReport): never {
  throw Object.assign(new Error('Prior turn requires reconciliation before continuing.'), {
    code: 'PRIOR_TURN_RECONCILIATION_REQUIRED', report,
  });
}
/** Inspection never executes a tool, retries a delivery or treats matching content as a write receipt. */
export function inspectReminderTurn(raw: unknown, userId: string): ReminderReconciliationReport {
  const row = rowSchema.parse(raw);
  const parsed = reminderCheckpointSchema.safeParse(row.response?.agentCore);
  const valid = parsed.success && parsed.data.userId === userId
    && parsed.data.runId === row.id && parsed.data.requestId === row.message_id;
  if (!valid) return { runId: row.id,
    reason: Object.hasOwn(row.response ?? {}, 'agentCore') ? 'invalid_checkpoint' : 'legacy_handoff_required',
    pendingEffectIds: [], pendingDeliveryIds: [], hasCompletedConversation: false };
  const checkpoint = parsed.data;
  return { runId: row.id, reason: 'unknown_turn',
    pendingEffectIds: checkpoint.effects.filter(effect =>
      (effect.call?.name !== 'reminder_read' && !effect.item) || effect.item?.status === 'indeterminate')
      .map(effect => effect.call?.id ?? effect.item!.callId),
    pendingDeliveryIds: checkpoint.deliveries.filter(entry => entry.status === 'attempted' || entry.status === 'unknown')
      .map(entry => entry.message.id),
    hasCompletedConversation: checkpoint.completed !== null };
}

/** Reads service-only queue history while the current worker owns this thread. */
export function createReminderStateRecovery(client: ReminderCheckpointClient): ReminderStateRecoveryPort {
  return {
    async load(context, threadId) {
      const previous = await readPriorInboundTurn(client, context, threadId, row => blocked(inspectReminderTurn(row, context.userId)));
      if (!previous) return undefined;
      if (['agentCoreProductivity','agentCoreActiveRun','agentCoreActiveResolution','agentCoreActiveCompletion','agentCoreDeliveryManifest', 'agentCoreBaseline'].some(key => Object.hasOwn(previous.response ?? {},key))) blocked(inspectReminderTurn(previous, context.userId));
      if (Object.hasOwn(previous.response ?? {}, 'agentCoreResolution')) {
        const resolution = reminderResolutionSchema.parse(previous.response!.agentCoreResolution);
        const { agentCoreResolution: _resolution, ...source } = previous.response!;
        if (previous.status !== 'completed' || resolution.userId !== context.userId || resolution.runId !== previous.id
          || resolution.requestId !== previous.message_id || resolution.threadId !== threadId
          || resolution.sourceFingerprint !== checkpointFingerprint(source)) blocked(inspectReminderTurn(previous, context.userId));
        if (resolution.kind === 'reconciliation') {
          const original = reminderCheckpointSchema.parse(source.agentCore);
          if (original.userId !== context.userId || original.runId !== previous.id || original.requestId !== previous.message_id
            || original.effects.some(effect => (!effect.item || effect.item.status === 'indeterminate')
              && effect.call?.name !== 'reminder_read' && (!effect.call || !resolution.effectEvidence.some(proof =>
                proof.operationId === effect.call!.id && proof.item.toolName === effect.call!.name
                && proof.argumentsFingerprint === checkpointFingerprint(effect.call!.arguments))))
            || original.deliveries.some(delivery => ['attempted', 'unknown'].includes(delivery.status)
              && !resolution.deliveryEvidence.some(proof => proof.deliveryId === delivery.message.id))) {
            blocked(inspectReminderTurn(previous, context.userId));
          }
        } else if (Object.hasOwn(source, 'agentCore')) blocked(inspectReminderTurn(previous, context.userId));
        return structuredClone(resolution.conversation);
      }
      const parsed = reminderCheckpointSchema.safeParse(previous.response?.agentCore);
      if (!parsed.success || parsed.data.userId !== context.userId || parsed.data.runId !== previous.id
        || parsed.data.requestId !== previous.message_id || previous.status !== 'completed' || parsed.data.phase !== 'completed') {
        blocked(inspectReminderTurn(previous, context.userId));
      }
      return structuredClone(parsed.data.completed!.conversation);
    },
  };
}
