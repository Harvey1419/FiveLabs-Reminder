import { z } from 'zod';
import { jsonObjectSchema, aiTranscriptSchema } from './provider.js';
import { productivityConversationSchema } from './productivity-turn.js';
const priorSchema = z.strictObject({ id: z.uuid(), message_id: z.string().min(1), thread_id: z.string().min(1),
  sequence_id: z.number().int().positive().refine(Number.isSafeInteger), status: z.literal('completed'), response: jsonObjectSchema });
export const ownedBaselineCandidateSchema = z.strictObject({
  version: z.literal(1), userId: z.uuid(), inboundRunId: z.uuid(), activeRunId: z.uuid(), requestId: z.string().min(1),
  threadId: z.string().min(1), sequenceId: z.number().int().positive().refine(Number.isSafeInteger), prior: priorSchema.nullable(),
}).superRefine((value, ctx) => {
  if (value.prior && (value.prior.thread_id !== value.threadId || value.prior.sequence_id >= value.sequenceId
    || value.prior.id === value.inboundRunId)) ctx.addIssue({ code: 'custom', message: 'Prior checkpoint order/identity mismatch' });
});
export const ownedBaselineInputSchema = z.strictObject({ userText: z.string().min(1).max(8000), language: z.enum(['es','en']), timezone: z.string().min(1).max(128) });
export type OwnedBaselineInput = z.infer<typeof ownedBaselineInputSchema>;
export const ownedBaselineReceiptSchema = z.strictObject({
  version: z.literal(1), id: z.uuid(), candidate: ownedBaselineCandidateSchema, conversation: productivityConversationSchema, input: ownedBaselineInputSchema.optional(),
}).superRefine((value, ctx) => {
  const state = value.conversation;
  if (state.userId !== value.candidate.userId || state.handledRequestIds.includes(value.candidate.requestId)
    || state.history.some(message => message.role === 'system') || state.history.length && !aiTranscriptSchema.safeParse(state.history).success
    || new Set(state.handledRequestIds).size !== state.handledRequestIds.length
    || [state.tasks, state.reminders, state.events].some(records => new Set(records.map(record => record.id)).size !== records.length)) {
    ctx.addIssue({ code: 'custom', message: 'Owned closed baseline with unique identities required' });
  }
});
export type OwnedBaselineCandidate = z.infer<typeof ownedBaselineCandidateSchema>;
