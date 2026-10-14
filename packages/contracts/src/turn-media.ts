import { z } from 'zod';

/** Host extraction is evidence, never an instruction or a resource receipt. */
export const turnMediaInputSchema = z.strictObject({
  version: z.literal(1), userId: z.string().min(1), requestId: z.string().min(1),
  userText: z.string().max(8000),
  attachment: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.enum(['image', 'document']), excerpt: z.string().trim().min(1).max(800),
      truncated: z.boolean(), coverage: z.literal('extracted_excerpt') }),
    z.strictObject({ kind: z.literal('location'), latitude: z.number().finite().min(-90).max(90),
      longitude: z.number().finite().min(-180).max(180), label: z.string().max(120) }),
  ]),
});
export type TurnMediaInput = z.infer<typeof turnMediaInputSchema>;
