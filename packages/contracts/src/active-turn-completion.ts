import { z } from 'zod';
import { jsonObjectSchema } from './provider.js';
import { productivityConversationSchema } from './productivity-turn.js';
import { ownedBaselineInputSchema } from './owned-baseline.js';
import { deliveryManifestSchema } from './delivery-manifest.js';
import { atomicTaskReceiptSchema } from './atomic-task-receipt.js';
export const completionBaselineSchema = z.strictObject({
  id: z.uuid(), userId: z.uuid(), inboundRunId: z.uuid(), activeRunId: z.uuid(), requestId: z.string().min(1),
  threadId: z.string().min(1), sequenceId: z.number().int().positive().refine(Number.isSafeInteger),
  candidateFingerprint: z.string().regex(/^[a-f0-9]{64}$/), input: ownedBaselineInputSchema, conversation: productivityConversationSchema,
});
export const activeTurnCompletionSchema = z.strictObject({
  version: z.literal(1), kind: z.literal('active_turn_completion'),
  sourceFingerprint: z.string().regex(/^[a-f0-9]{64}$/), sourceResponse: jsonObjectSchema,
  baseline: completionBaselineSchema, manifest: deliveryManifestSchema,
  receipts: z.array(atomicTaskReceiptSchema).max(12), conversation: productivityConversationSchema,
});
export type ActiveTurnCompletion = z.infer<typeof activeTurnCompletionSchema>;
