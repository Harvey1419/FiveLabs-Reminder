import { z } from 'zod';
import { aiTranscriptSchema } from './provider.js';
import { activeRunRecoverySnapshotSchema } from './active-run-checkpoint.js';
import { productivityConversationSchema, productivityItemSchema } from './productivity-turn.js';

const id = z.string().min(1).max(256);
const fingerprint = z.string().regex(/^[a-f0-9]{64}$/);
export const activeRunEffectEvidenceSchema = z.strictObject({
  userId: id, activeRunId: id, callId: id, actionFingerprint: fingerprint, evidenceId: id,
  outcome: z.enum(['applied', 'no_effect']), coversCompanions: z.literal(true), item: productivityItemSchema.nullable(),
}).superRefine((proof, ctx) => {
  if (proof.outcome === 'no_effect' ? proof.item !== null : !proof.item || proof.item.callId !== proof.callId
    || proof.item.status !== 'success' || !proof.item.result?.complete) {
    ctx.addIssue({ code: 'custom', message: 'Independent evidence must establish a complete effect or no effect' });
  }
});
/** Covers the entire prior inbound turn, including whether a sender was ever called. */
export const activeRunDeliveryEvidenceSchema = z.strictObject({
  userId: id, inboundRunId: id, sourceFingerprint: fingerprint, evidenceId: id,
  outcome: z.enum(['accepted', 'not_sent']), messageIds: z.array(id).max(12),
}).refine(proof => (proof.outcome === 'accepted') === (proof.messageIds.length > 0)
  && new Set(proof.messageIds).size === proof.messageIds.length, 'Delivery outcome must match unique provider receipts');
export const activeRunBaselineEvidenceSchema = z.strictObject({
  userId: id, threadId: id, sourceFingerprint: fingerprint, conversation: productivityConversationSchema,
});
export const activeRunResolutionSchema = z.strictObject({
  version: z.literal(1), kind: z.literal('active_run_handoff'), grantsExecution: z.literal(false),
  userId: id, runId: id, requestId: id, threadId: id, activeRunId: id, claimId: z.uuid(),
  sourceFingerprint: fingerprint, snapshotFingerprint: fingerprint, decidedAtIso: z.iso.datetime({ offset: true }),
  runStatus: z.enum(['completed', 'cancelled', 'failed']), source: activeRunRecoverySnapshotSchema,
  baseline: productivityConversationSchema, conversation: productivityConversationSchema,
  effects: z.array(activeRunEffectEvidenceSchema).max(12), delivery: activeRunDeliveryEvidenceSchema,
}).superRefine((value, ctx) => {
  const issue = (message: string) => ctx.addIssue({ code: 'custom', message });
  if (value.baseline.userId !== value.userId || value.conversation.userId !== value.userId
    || !value.conversation.handledRequestIds.includes(value.requestId)) issue('Conversation owner/handled request mismatch');
  for (const conversation of [value.baseline, value.conversation]) {
    if (conversation.history.some(message => message.role === 'system')
      || conversation.history.length && !aiTranscriptSchema.safeParse(conversation.history).success) issue('Closed historical transcript required');
    if (new Set(conversation.handledRequestIds).size !== conversation.handledRequestIds.length
      || [conversation.tasks, conversation.reminders, conversation.events].some(records => new Set(records.map(record => record.id)).size !== records.length)) issue('Conversation identities must be unique');
  }
  if (value.effects.some(proof => proof.userId !== value.userId || proof.activeRunId !== value.activeRunId)
    || new Set(value.effects.map(proof => proof.callId)).size !== value.effects.length
    || value.delivery.userId !== value.userId || value.delivery.inboundRunId !== value.runId
    || value.delivery.sourceFingerprint !== value.sourceFingerprint) issue('Evidence owner/source mismatch');
});
export type ActiveRunEffectEvidence = z.infer<typeof activeRunEffectEvidenceSchema>;
export type ActiveRunResolution = z.infer<typeof activeRunResolutionSchema>;
