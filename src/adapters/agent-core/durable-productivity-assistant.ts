import {
  jsonObjectSchema, productivityCheckpointSchema, productivityConversationSchema, type ProductivityConversation, type ProductivityItem, type ProductivityDelivery, type ToolCall, type TurnContext,
} from '@templelabs/contracts';
import { ProductivityTurnRunner, type ProductivityExecutionJournal, type ProductivityTurnResult } from '@templelabs/agent-core';
import { requireInboundTurnLease } from '../../agent/core/turn-lease.js';
import { claimAgentCoreLease } from './inbound-admission.js';
import { WhatsAppProductivityPresenter, type ProductivityPresentation } from '../../presentation/whatsapp-productivity-presenter.js';
import type { ProductivityStateRecoveryPort } from './productivity-state-recovery.js';

/** A receipt means provider acceptance, not handset delivery. The host owns recipient binding. */
export interface ProductivityDeliveryPort {
  send(message: ProductivityDelivery, context: TurnContext): Promise<{ readonly messageId: string }>;
}

function boundaryError(code: string) {
  return Object.assign(new Error(code), { code });
}

/** Prepared dialogue is context, not an execution receipt or proof of handset delivery. */
function withPreparedReply(conversation: ProductivityConversation, text: string): ProductivityConversation {
  const history = [...conversation.history];
  const last = history.at(-1);
  // Replace only final prose. Tool-call assistants and their observations remain intact.
  const reply = { role: 'assistant' as const, content: text, toolCalls: [] };
  if (last?.role === 'assistant' && !last.toolCalls?.length) history[history.length - 1] = reply;
  else history.push(reply);
  return productivityConversationSchema.parse({ ...conversation, history });
}

/** Isolated composition over the existing queue; no replay of interrupted writes or sends. */
export class DurableProductivityAssistant {
  constructor(private readonly runner: ProductivityTurnRunner, private readonly delivery: ProductivityDeliveryPort,
    private readonly presenter = new WhatsAppProductivityPresenter(), private readonly recovery?: ProductivityStateRecoveryPort) {}

  async handle(text: string, context: TurnContext, threadId: string, previous?: ProductivityConversation) {
    const lease = requireInboundTurnLease();
    const turn = lease.inboundTurn;
    if (context.runId !== turn.id || context.requestId !== turn.messageId || threadId !== turn.threadId) {
      throw boundaryError('INBOUND_IDENTITY_MISMATCH');
    }
    claimAgentCoreLease(lease);
    if (this.recovery && previous) throw boundaryError('RECOVERY_CHECKPOINT_OVERRIDE_FORBIDDEN');
    const recovered = this.recovery ? await this.recovery.load(context, threadId) : previous;
    const start = { text, conversation: productivityConversationSchema.parse(recovered ?? {
      userId: context.userId, history: [], reminders: [], tasks: [], events: [], handledRequestIds: [],
    }) };
    const effects: { call: ToolCall | null; item: ProductivityItem | null; observation: string | null }[] = [];
    const deliveries: { message: ProductivityDelivery; status: 'ready' | 'attempted' | 'accepted' | 'unknown'; messageId: string | null }[] = [];
    let phase: 'running' | 'ready' | 'delivering' | 'completed' | 'reconciliation_required' = 'running';
    let completed: (Pick<ProductivityTurnResult, 'conversation' | 'uiPayload' | 'requiresReconciliation'> & { readonly reply: ProductivityPresentation }) | null = null;
    const checkpoint = async () => {
      context.signal.throwIfAborted();
      lease.signal.throwIfAborted();
      await lease.assertActive();
      await lease.checkpoint(jsonObjectSchema.parse({ agentCoreProductivity: productivityCheckpointSchema.parse({
        version: 1, userId: context.userId, runId: context.runId, requestId: context.requestId,
        phase, start, effects, completed, deliveries,
      }) }));
    };
    const journal: ProductivityExecutionJournal = {
      beforeDispatch: async call => {
        effects.push({ call, item: null, observation: null });
        await checkpoint();
      },
      afterOutcome: async (call, item, observation) => {
        const pending = effects.find(effect => effect.call?.id === item.callId);
        if (pending) { pending.item = item; pending.observation = observation; }
        else effects.push({ call, item, observation });
        await checkpoint();
      },
    };
    await checkpoint();
    // Lease loss also cancels provider and tool work even if the host signal is different.
    const scopedContext = { ...context, signal: AbortSignal.any([context.signal, lease.signal]) };
    const result = await this.runner.run(text, scopedContext, recovered, journal);
    const reply = this.presenter.render(result.uiPayload);
    const conversation = withPreparedReply(result.conversation, reply.text);
    completed = { conversation, uiPayload: result.uiPayload, requiresReconciliation: result.requiresReconciliation, reply };
    const messages: ProductivityDelivery[] = [
      { id: `${encodeURIComponent(context.requestId)}:reply:0`, kind: 'text', text: reply.text },
      ...reply.ctas.map((cta, index): ProductivityDelivery => ({ id: `${encodeURIComponent(context.requestId)}:reply:${index + 1}`,
        kind: 'cta', text: cta.header ?? reply.text, cta })),
      ...reply.flows.map((flow, index): ProductivityDelivery => ({ id: `${encodeURIComponent(context.requestId)}:reply:${reply.ctas.length + index + 1}`,
        kind: 'flow', text: reply.text, flow })),
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
    const uncertainWrite = result.requiresReconciliation;
    phase = uncertainWrite ? 'reconciliation_required' : 'completed';
    await checkpoint();
    // Deliver the honest warning, then let the queue quarantine the uncertain effect.
    if (uncertainWrite) throw boundaryError('EFFECT_RECONCILIATION_REQUIRED');
    return { ...result, conversation, reply, messageIds: deliveries.map(entry => entry.messageId!) };
  }
}
