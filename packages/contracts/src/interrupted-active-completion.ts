import { z } from 'zod';
import { activeRunRecoverySnapshotSchema } from './active-run-checkpoint.js';
import { ownedBaselineReceiptSchema } from './owned-baseline.js';
import { deliveryManifestSchema } from './delivery-manifest.js';
import { atomicTaskReceiptSchema } from './atomic-task-receipt.js';

/** A consistent read of actual persisted evidence, never an execution or publication grant. */
export const interruptedActiveCompletionEvidenceSchema = z.strictObject({
  snapshot: activeRunRecoverySnapshotSchema,
  baseline: ownedBaselineReceiptSchema.nullable(),
  manifest: deliveryManifestSchema.nullable(),
  receipts: z.array(atomicTaskReceiptSchema).max(12),
});
export type InterruptedActiveCompletionEvidence = z.infer<typeof interruptedActiveCompletionEvidenceSchema>;
