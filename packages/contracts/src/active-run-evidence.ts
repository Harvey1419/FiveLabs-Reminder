import { z } from 'zod';
import { activeRunEffectEvidenceSchema, activeRunDeliveryEvidenceSchema, activeRunBaselineEvidenceSchema } from './active-run-resolution.js';
const id = z.string().min(1).max(256);
const common = { version: z.literal(1), userId: id, activeRunId: id, inboundRunId: id, threadId: id,
  sourceFingerprint: z.string().regex(/^[a-f0-9]{64}$/), evidenceKey: z.string().min(1).max(400),
  verifiedAtIso: z.iso.datetime({ offset: true }) };
/** Only an authenticated audit/checkpoint producer may publish these already verified receipts. */
export const verifiedActiveRunEvidenceSchema = z.discriminatedUnion('kind', [
  z.strictObject({ ...common, kind: z.literal('effect'), authority: z.literal('domain_audit'), proof: activeRunEffectEvidenceSchema }),
  z.strictObject({ ...common, kind: z.literal('delivery'), authority: z.literal('delivery_audit'), proof: activeRunDeliveryEvidenceSchema }),
  z.strictObject({ ...common, kind: z.literal('baseline'), authority: z.literal('owned_checkpoint'), proof: activeRunBaselineEvidenceSchema }),
]);
export type VerifiedActiveRunEvidence = z.infer<typeof verifiedActiveRunEvidenceSchema>;
