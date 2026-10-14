import {
  jsonObjectSchema, reminderCheckpointSchema, reminderConversationSchema, type ReminderConversation, type ReminderUiItem, type ToolCall, type TurnContext,
} from '@templelabs/contracts';
import { ReminderTurnRunner, type ReminderExecutionJournal, type ReminderTurnResult } from '@templelabs/agent-core';
import { requireInboundTurnLease } from '../../agent/core/turn-lease.js';
import { claimAgentCoreLease } from './inbound-admission.js';
import { WhatsAppCardPresenter, type WhatsAppPresentation } from '../../presentation/whatsapp-card-presenter.js';
import type { ReminderStateRecoveryPort } from './reminder-state-recovery.js';

export type ReminderDelivery = { readonly id: string; readonly text: string } & (
  { readonly kind: 'text' } | { readonly kind: 'cta'; readonly cta: WhatsAppPresentation['ctas'][number] }
);
/** A receipt means provider acceptance, not handset delivery. The host owns recipient binding. */
export interface ReminderDeliveryPort {
  send(message: ReminderDelivery, context: TurnContext): Promise<{ readonly messageId: string }>;
}

function boundaryError(code: string) {
  return Object.assign(new Error(code), { code });
}

/** Isolated composition over the existing queue; no replay of interrupted writes or sends. */
export class DurableReminderAssistant {
  constructor(private readonly runner: ReminderTurnRunner, private readonly delivery: ReminderDeliveryPort,
    private readonly presenter = new WhatsAppCardPresenter(), private readonly recovery?: ReminderStateRecoveryPort) {}

  async handle(text: string, context: TurnContext, threadId: string, previous?: ReminderConversation) {
    const lease = requireInboundTurnLease();
    const turn = lease.inboundTurn;
    if (context.runId !== turn.id || context.requestId !== turn.messageId || threadId !== turn.threadId) {
      throw boundaryError('INBOUND_IDENTITY_MISMATCH');
    }
    claimAgentCoreLease(lease);
    if (this.recovery && previous) throw boundaryError('RECOVERY_CHECKPOINT_OVERRIDE_FORBIDDEN');
    const recovered = this.recovery ? await this.recovery.load(context, threadId) : previous;
    const start = { text, conversation: reminderConversationSchema.parse(recovered ?? {
      userId: context.userId, history: [], references: [], handledRequestIds: [],
    }) };
    const effects: { call: ToolCall | null; item: ReminderUiItem | null; observation: string | null }[] = [];
    const deliveries: { message: ReminderDelivery; status: 'ready' | 'attempted' | 'accepted' | 'unknown'; messageId: string | null }[] = [];
    let phase: 'running' | 'ready' | 'delivering' | 'completed' | 'reconciliation_required' = 'running';
    let completed: (Pick<ReminderTurnResult, 'conversation' | 'uiPayload'> & { readonly reply: WhatsAppPresentation }) | null = null;
    const checkpoint = async () => {
      context.signal.throwIfAborted();
      lease.signal.throwIfAborted();
      await lease.assertActive();
      await lease.checkpoint(jsonObjectSchema.parse({ agentCore: reminderCheckpointSchema.parse({
        version: 2, userId: context.userId, runId: context.runId, requestId: context.requestId,
        phase, start, effects, completed, deliveries,
      }) }));
    };
    const journal: ReminderExecutionJournal = {
      beforeDispatch: async call => {
        effects.push({ call, item: null, observation: null });
        await checkpoint();
      },
      afterOutcome: async (item, observation) => {
        const pending = effects.find(effect => effect.call?.id === item.callId);
        if (pending) { pending.item = item; pending.observation = observation; }
        else effects.push({ call: null, item, observation });
        await checkpoint();
      },
    };
    await checkpoint();
    // Lease loss also cancels provider and tool work even if the host signal is different.
    const scopedContext = { ...context, signal: AbortSignal.any([context.signal, lease.signal]) };
    const result = await this.runner.run(text, scopedContext, recovered, journal);
    const reply = this.presenter.render(result.uiPayload);
    completed = { conversation: result.conversation, uiPayload: result.uiPayload, reply };
    const messages: ReminderDelivery[] = [
      { id: `${encodeURIComponent(context.requestId)}:reply:0`, kind: 'text', text: reply.text },
      ...reply.ctas.map((cta, index): ReminderDelivery => ({ id: `${encodeURIComponent(context.requestId)}:reply:${index + 1}`,
        kind: 'cta', text: cta.header ?? reply.text, cta })),
    ];
    deliveries.push(...messages.map(message => ({ message, status: 'ready' as const, messageId: null })));
    phase = 'ready';
    await checkpoint();
    for (const entry of deliveries) {
      phase = 'delivering';
      entry.status = 'attempted';
      await checkpoint();
      scopedContext.signal.throwIfAborted();
      await lease.assertActive();
      let receipt;
      try {
        receipt = await this.delivery.send(structuredClone(entry.message), scopedContext);
        if (!receipt || typeof receipt.messageId !== 'string' || !receipt.messageId.trim()) {
          throw boundaryError('DELIVERY_OUTCOME_UNKNOWN');
        }
      } catch {
        entry.status = 'unknown';
        // A checkpoint failure leaves 'attempted' durable, which is equally non-replayable.
        await checkpoint();
        throw boundaryError('DELIVERY_OUTCOME_UNKNOWN');
      }
      entry.status = 'accepted';
      entry.messageId = receipt.messageId;
      await checkpoint();
    }
    const uncertainWrite = result.uiPayload.items.some(item => item.status === 'indeterminate');
    phase = uncertainWrite ? 'reconciliation_required' : 'completed';
    await checkpoint();
    // Deliver the honest warning, then let the queue quarantine the uncertain effect.
    if (uncertainWrite) throw boundaryError('EFFECT_RECONCILIATION_REQUIRED');
    return { ...result, reply, messageIds: deliveries.map(entry => entry.messageId!) };
  }
}
