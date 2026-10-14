import { z } from 'zod';
import { jsonObjectSchema } from './provider.js';
import { productivityDeliverySchema } from './productivity-checkpoint.js';
export const deliveryManifestSchema = z.strictObject({
  version: z.literal(1), id: z.uuid(), userId: z.uuid(), inboundRunId: z.uuid(), activeRunId: z.uuid(),
  requestId: z.string().min(1), threadId: z.string().min(1), sourceResponse: jsonObjectSchema,
  entries: z.array(z.strictObject({ message: productivityDeliverySchema,
    state: z.enum(['ready', 'attempted', 'accepted', 'unknown']), providerMessageId: z.string().trim().min(1).max(256).nullable() })).max(12),
}).superRefine((manifest, ctx) => {
  const ids = manifest.entries.map(entry => entry.message.id);
  if (new Set(ids).size !== ids.length || ids.some((id,index) => id !== `${encodeURIComponent(manifest.requestId)}:reply:${index}`)
    || manifest.entries.some(entry => (entry.state === 'accepted') !== (entry.providerMessageId !== null))) {
    ctx.addIssue({ code: 'custom', message: 'Manifest messages must be ordered, unique and have exact acceptance receipts' });
  }
  const receipts = manifest.entries.flatMap(entry => entry.providerMessageId ? [entry.providerMessageId] : []);
  if (new Set(receipts).size !== receipts.length) ctx.addIssue({ code: 'custom', message: 'Provider message identities must be unique' });
});
export type DeliveryManifest = z.infer<typeof deliveryManifestSchema>;
