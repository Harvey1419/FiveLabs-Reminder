import { z } from 'zod';
export const embeddingSpaceSchema = z.strictObject({
  id: z.string().min(1).max(240), model: z.string().regex(/^[\w./:-]{1,160}$/), dimensions: z.number().int().min(1).max(8192),
});
export type EmbeddingSpace = z.infer<typeof embeddingSpaceSchema>;
export const transcriptionAccountingSchema = z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('unavailable') }),
  z.strictObject({ status: z.literal('reported'), costUsd: z.number().finite().nonnegative(),
    audioSeconds: z.number().finite().nonnegative().optional(), inputTokens: z.number().int().nonnegative().optional(),
    outputTokens: z.number().int().nonnegative().optional() }),
]);
export type TranscriptionAccounting = z.infer<typeof transcriptionAccountingSchema>;
export const audioInputSchema = z.strictObject({
  bytes: z.instanceof(Uint8Array).refine(bytes => bytes.byteLength > 0 && bytes.byteLength <= 20 * 1024 * 1024),
  format: z.enum(['ogg', 'wav', 'mp3', 'flac', 'm4a', 'webm', 'aac']),
  language: z.enum(['es', 'en', 'auto']), prompt: z.string().max(800).optional(),
});
export type AudioInput = z.infer<typeof audioInputSchema>;
