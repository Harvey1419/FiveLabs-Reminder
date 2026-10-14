import { z } from 'zod';
import { aiTranscriptSchema, toolCallSchema } from './provider.js';
import { productivityConversationSchema, productivityItemSchema, productivityUiPayloadSchema, type ProductivityUiPayload } from './productivity-turn.js';
import { reminderReplySchema } from './reminder-checkpoint.js';
import { taskFlowSchema } from './tasks.js';

export const productivityReplySchema = reminderReplySchema.extend({ flows: z.array(taskFlowSchema).max(10) });
export const productivityDeliverySchema = z.discriminatedUnion('kind', [
  z.strictObject({ id: z.string().min(1), kind: z.literal('text'), text: z.string().max(100000) }),
  z.strictObject({ id: z.string().min(1), kind: z.literal('cta'), text: z.string().max(100000), cta: reminderReplySchema.shape.ctas.element }),
  z.strictObject({ id: z.string().min(1), kind: z.literal('flow'), text: z.string().max(100000), flow: taskFlowSchema }),
]);
export function productivityNeedsReconciliation(payload: ProductivityUiPayload): boolean {
  return payload.items.some(item => item.status === 'indeterminate' || (item.status === 'partial' && item.result
    && ((item.domain === 'calendar' && item.result.companion === 'unconfirmed')
      || ('issues' in item.result && item.result.issues.some(issue => issue.code === 'COMPANION_OUTCOME_UNVERIFIED')))));
}
/** Separate namespace/version: reminder-only recovery and resolution cannot certify mixed effects. */
export const productivityCheckpointSchema = z.strictObject({
  version: z.literal(1), userId: z.string().min(1), runId: z.string().min(1), requestId: z.string().min(1),
  phase: z.enum(['running', 'ready', 'delivering', 'completed', 'reconciliation_required']),
  start: z.strictObject({ conversation: productivityConversationSchema, text: z.string().min(1).max(8000) }),
  effects: z.array(z.strictObject({ call: toolCallSchema.nullable(), item: productivityItemSchema.nullable(), observation: z.string().nullable() })).max(10),
  completed: z.strictObject({ conversation: productivityConversationSchema, uiPayload: productivityUiPayloadSchema,
    reply: productivityReplySchema, requiresReconciliation: z.boolean() }).nullable(),
  deliveries: z.array(z.strictObject({ message: productivityDeliverySchema,
    status: z.enum(['ready', 'attempted', 'accepted', 'unknown']), messageId: z.string().trim().min(1).nullable() })).max(21),
}).superRefine((state, ctx) => {
  const issue = (message: string) => ctx.addIssue({ code: 'custom', message });
  const validHistory = (conversation: z.infer<typeof productivityConversationSchema>) =>
    !conversation.history.some(message => message.role === 'system')
    && (!conversation.history.length || aiTranscriptSchema.safeParse(conversation.history).success);
  if (state.start.conversation.userId !== state.userId || state.start.conversation.handledRequestIds.includes(state.requestId)
    || !validHistory(state.start.conversation)) issue('Invalid initial conversation');
  const identities = state.effects.map(effect => effect.call?.id ?? effect.item?.callId);
  if (identities.some(id => !id) || new Set(identities).size !== identities.length) issue('Effect identities must be present and unique');
  for (const effect of state.effects) {
    if (effect.call && effect.item && (effect.call.id !== effect.item.callId || effect.call.name !== effect.item.toolName)) issue('Effect receipt identity mismatch');
    if (Boolean(effect.item) !== (effect.observation !== null)) issue('Outcome and observation must be stored together');
  }
  if (new Set(state.deliveries.map(entry => entry.message.id)).size !== state.deliveries.length) issue('Delivery identities must be unique');
  if (state.deliveries.some(entry => (entry.status === 'accepted') !== (entry.messageId !== null))) issue('Acceptance requires provider identity');
  if (state.phase !== 'running' && !state.completed) issue('Final phases require completed state');
  if (state.completed) {
    const final = state.completed;
    if (final.conversation.userId !== state.userId || !final.conversation.handledRequestIds.includes(state.requestId)
      || !validHistory(final.conversation)) issue('Invalid final conversation');
    if (JSON.stringify(final.uiPayload.items) !== JSON.stringify(state.effects.map(effect => effect.item))) issue('Final UI must match ordered recorded outcomes');
    if (final.requiresReconciliation !== productivityNeedsReconciliation(final.uiPayload)) issue('Reconciliation flag must match domain evidence');
    const expected = [
      { id: `${encodeURIComponent(state.requestId)}:reply:0`, kind: 'text', text: final.reply.text },
      ...final.reply.ctas.map((cta, index) => ({ id: `${encodeURIComponent(state.requestId)}:reply:${index + 1}`, kind: 'cta', text: cta.header ?? final.reply.text, cta })),
      ...final.reply.flows.map((flow, index) => ({ id: `${encodeURIComponent(state.requestId)}:reply:${final.reply.ctas.length + index + 1}`, kind: 'flow', text: final.reply.text, flow })),
    ];
    if (JSON.stringify(expected) !== JSON.stringify(state.deliveries.map(entry => entry.message))) issue('Delivery plan must match final reply');
  } else if (state.deliveries.length) issue('Delivery requires a final reply');
  if (state.phase === 'completed' && (state.completed?.requiresReconciliation || !state.deliveries.length
    || state.deliveries.some(entry => entry.status !== 'accepted'))) issue('Completion requires confirmed effects and accepted deliveries');
  if (state.phase === 'reconciliation_required' && !state.completed?.requiresReconciliation) issue('Reconciliation requires ambiguous effects');
});
export type ProductivityCheckpoint = z.infer<typeof productivityCheckpointSchema>;
export type ProductivityDelivery = z.infer<typeof productivityDeliverySchema>;
