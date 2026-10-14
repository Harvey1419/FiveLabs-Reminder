import { z } from 'zod';

/** Inline bytes only: provider adapters never fetch caller-selected URLs. */
const dataBase64 = z.string().refine(value => {
  if (value.length < 4 || value.length > 27962028 || value.length % 4 !== 0) return false;
  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0;
  if (value.length / 4 * 3 - padding > 20 * 1024 * 1024) return false;
  // A flat character scan avoids regex backtracking/stack overflow on large attachments.
  return !/[^A-Za-z0-9+/]/.test(value.slice(0, value.length - padding));
}, { message: 'Expected bounded inline base64 bytes' });
export const mediaAttachmentSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('image'), mimeType: z.enum(['image/jpeg', 'image/png', 'image/webp', 'image/gif']), dataBase64 }),
  z.strictObject({ kind: z.literal('pdf'), mimeType: z.literal('application/pdf'), dataBase64,
    filename: z.string().regex(/^[\w .-]{1,100}\.pdf$/).default('document.pdf') }),
]);
export type MediaAttachment = z.infer<typeof mediaAttachmentSchema>;
