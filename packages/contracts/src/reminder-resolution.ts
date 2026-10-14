import { z } from 'zod';
import { aiTranscriptSchema } from './provider.js';
import { reminderConversationSchema, reminderUiItemSchema } from './reminder-turn.js';

export const reminderEffectEvidenceSchema = z.strictObject({
  userId: z.string().min(1), operationId: z.string().min(1), argumentsFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  evidenceId: z.string().min(1).max(200), item: reminderUiItemSchema,
}).refine(proof => proof.operationId === proof.item.callId
  && ['success', 'partial', 'failed'].includes(proof.item.status), 'Evidence must establish a terminal operation outcome');
export const reminderDeliveryEvidenceSchema = z.strictObject({
  userId: z.string().min(1), deliveryId: z.string().min(1), evidenceId: z.string().min(1).max(200),
  outcome: z.enum(['accepted', 'not_sent']), messageId: z.string().min(1).nullable(),
}).refine(proof => (proof.outcome === 'accepted') === (proof.messageId !== null), 'Accepted delivery needs a provider identity');
export const reminderResolutionSchema = z.strictObject({
  version: z.literal(1), kind: z.enum(['reconciliation', 'legacy_handoff']),
  userId: z.string().min(1), runId: z.string().min(1), requestId: z.string().min(1), threadId: z.string().min(1),
  sourceFingerprint: z.string().regex(/^[a-f0-9]{64}$/), decidedAtIso: z.iso.datetime({ offset: true }),
  conversation: reminderConversationSchema,
  effectEvidence: z.array(reminderEffectEvidenceSchema).max(10),
  deliveryEvidence: z.array(reminderDeliveryEvidenceSchema).max(11),
}).superRefine((resolution, ctx) => {
  const issue = (message: string) => ctx.addIssue({ code: 'custom', message });
  const state = resolution.conversation;
  if (state.userId !== resolution.userId || !state.handledRequestIds.includes(resolution.requestId)) issue('Resolved conversation identity mismatch');
  if (state.history.some(message => message.role === 'system')
    || (state.history.length && !aiTranscriptSchema.safeParse(state.history).success)) issue('Resolved transcript is invalid');
  if ([...resolution.effectEvidence, ...resolution.deliveryEvidence].some(proof => proof.userId !== resolution.userId)) issue('Evidence owner mismatch');
  if (new Set(resolution.effectEvidence.map(proof => proof.operationId)).size !== resolution.effectEvidence.length
    || new Set(resolution.deliveryEvidence.map(proof => proof.deliveryId)).size !== resolution.deliveryEvidence.length) issue('Duplicate evidence identity');
});
export type ReminderEffectEvidence = z.infer<typeof reminderEffectEvidenceSchema>;
export type ReminderDeliveryEvidence = z.infer<typeof reminderDeliveryEvidenceSchema>;
export type ReminderResolution = z.infer<typeof reminderResolutionSchema>;
