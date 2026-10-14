import { z } from 'zod';
export const memoryCategorySchema = z.enum(['fact', 'preference', 'decision', 'episode', 'observation']);
export const memoryReadInputSchema = z.strictObject({ query: z.string().trim().min(1).max(200).optional() });
export const memorySaveInputSchema = z.strictObject({ content: z.string().trim().min(1).max(400), category: memoryCategorySchema,
  evidenceStart: z.number().int().min(0).max(8000).optional(), evidenceEnd: z.number().int().positive().max(8000).optional() })
  .refine(value => value.evidenceStart === undefined ? value.evidenceEnd === undefined : value.evidenceEnd !== undefined && value.evidenceEnd > value.evidenceStart, { message: 'Evidence must be a nonempty span in the authored user text' });
export const memoryForgetInputSchema = z.strictObject({ memoryId: z.uuid() });
export const memoryRecordSchema = z.strictObject({ id: z.uuid(), content: z.string().min(1).max(2000), category: memoryCategorySchema,
  topicKey: z.string().nullable(), status: z.enum(['active', 'forgotten']) });
export const memoryResultSchema = z.strictObject({ operation: z.enum(['read', 'save', 'forget']), records: z.array(memoryRecordSchema).max(50),
  complete: z.boolean(), coverage: z.enum(['operation', 'bounded_list']),
  presentation: z.strictObject({ canonicalCard: z.string().nullable(), questions: z.array(z.string().max(500)).max(3),
    cta: z.null() }) });
export const memoryToolNameSchema = z.enum(['memory_read', 'memory_save', 'memory_forget']);
export type MemoryRecord = z.infer<typeof memoryRecordSchema>;
export type MemoryResult = z.infer<typeof memoryResultSchema>;
export type MemoryRequest = { operation: 'read'; input: z.infer<typeof memoryReadInputSchema> }
  | { operation: 'save'; input: z.infer<typeof memorySaveInputSchema> }
  | { operation: 'forget'; input: z.infer<typeof memoryForgetInputSchema> };
