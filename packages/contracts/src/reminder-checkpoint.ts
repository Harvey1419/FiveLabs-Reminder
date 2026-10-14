import { z } from 'zod';
import { aiTranscriptSchema, toolCallSchema } from './provider.js';
import { reminderConversationSchema, reminderUiItemSchema, reminderUiPayloadSchema } from './reminder-turn.js';

export const reminderReplySchema = z.strictObject({
  text: z.string().max(100000),
  ctas: z.array(z.strictObject({ url: z.url(), header: z.string().nullable(), buttonText: z.string().nullable() })).max(10),
});
const deliveryMessage = z.discriminatedUnion('kind', [
  z.strictObject({ id: z.string().min(1), kind: z.literal('text'), text: z.string().max(100000) }),
  z.strictObject({ id: z.string().min(1), kind: z.literal('cta'), text: z.string().max(100000), cta: reminderReplySchema.shape.ctas.element }),
]);
export const reminderCheckpointSchema = z.strictObject({
  version: z.literal(2), userId: z.string().min(1), runId: z.string().min(1), requestId: z.string().min(1),
  phase: z.enum(['running', 'ready', 'delivering', 'completed', 'reconciliation_required']),
  start: z.strictObject({ conversation: reminderConversationSchema, text: z.string().min(1).max(8000) }).optional(),
  effects: z.array(z.strictObject({ call: toolCallSchema.nullable(), item: reminderUiItemSchema.nullable(),
    observation: z.string().nullable() })).max(10),
  completed: z.strictObject({ conversation: reminderConversationSchema, uiPayload: reminderUiPayloadSchema,
    reply: reminderReplySchema }).nullable(),
  deliveries: z.array(z.strictObject({ message: deliveryMessage,
    status: z.enum(['ready', 'attempted', 'accepted', 'unknown']), messageId: z.string().min(1).nullable() })).max(11),
}).superRefine((state, ctx) => {
  const issue = (message: string) => ctx.addIssue({ code: 'custom', message });
  const calls = new Set<string>();
  if (state.start && (state.start.conversation.userId !== state.userId
    || state.start.conversation.handledRequestIds.includes(state.requestId))) issue('Initial conversation identity mismatch');
  for (const effect of state.effects) {
    const id = effect.call?.id ?? effect.item?.callId;
    if (!id || calls.has(id)) issue('Effect identities must be present and unique');
    else calls.add(id);
    if (effect.call && effect.item && (effect.call.id !== effect.item.callId || effect.call.name !== effect.item.toolName)) issue('Effect receipt identity mismatch');
    if (Boolean(effect.item) !== (effect.observation !== null)) issue('Outcome and observation must be stored together');
  }
  if (new Set(state.deliveries.map(entry => entry.message.id)).size !== state.deliveries.length) issue('Delivery identities must be unique');
  for (const delivery of state.deliveries) {
    if ((delivery.status === 'accepted') !== (delivery.messageId !== null)) issue('Acceptance requires a provider identity');
  }
  if (state.completed) {
    const conversation = state.completed.conversation;
    if (conversation.userId !== state.userId || !conversation.handledRequestIds.includes(state.requestId)) issue('Conversation checkpoint ownership/request mismatch');
    if (conversation.history.some(message => message.role === 'system') || !aiTranscriptSchema.safeParse(conversation.history).success) issue('Invalid conversation transcript');
    const items = state.completed.uiPayload.items;
    if (new Set(items.map(item => item.callId)).size !== items.length
      || items.length !== state.effects.length || items.some(item => !state.effects.some(effect =>
      effect.item && JSON.stringify(effect.item) === JSON.stringify(item)))) issue('Final UI must match recorded outcomes');
  }
  if (state.phase !== 'running' && !state.completed) issue('Finalized phases require completed state');
  if (state.phase === 'completed' && (state.effects.some(effect => !effect.item || effect.item.status === 'indeterminate')
    || !state.deliveries.length || state.deliveries.some(entry => entry.status !== 'accepted'))) issue('Completed phase requires verified outcomes and accepted delivery receipts');
});
export type ReminderCheckpoint = z.infer<typeof reminderCheckpointSchema>;
