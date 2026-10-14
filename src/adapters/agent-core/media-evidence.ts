import { aiResponseSchema, mediaAttachmentSchema, type MediaAttachment } from '@templelabs/contracts';
import type { MediaAIProvider, MediaCompletionRequest } from '@templelabs/ai';
import { buildExtractionPrompt } from '../../integrations/media/document-processor.js';

export type AttachmentEvidence = { readonly usage: { readonly inputTokens: number; readonly outputTokens: number };
  readonly provenance: 'untrusted_attachment'; readonly grantsExecution: false;
} & ({ readonly status: 'success'; readonly text: string } | { readonly status: 'refused'; readonly text: null });
/** Evidence only. Trusted user text remains separate; downstream authority cannot originate in this text. */
export async function extractAttachmentEvidence(provider: MediaAIProvider,
  request: Omit<MediaCompletionRequest, 'prompt' | 'attachment' | 'validate'>,
  attachment: MediaAttachment, caption = '', now: () => number = Date.now): Promise<AttachmentEvidence> {
  const captured = { ...request, attachment: mediaAttachmentSchema.parse(attachment), prompt: buildExtractionPrompt(caption) };
  const assertFresh = () => {
    captured.signal.throwIfAborted();
    const clock = now();
    if (!Number.isFinite(captured.deadlineMs) || !Number.isFinite(clock) || clock >= captured.deadlineMs) throw new Error('MEDIA_DEADLINE');
  };
  const validate = (text: string) => {
    if (typeof text !== 'string' || !text.trim() || text.length > 100000) throw new Error('INVALID_ATTACHMENT_EVIDENCE');
    return text.trim();
  };
  assertFresh();
  if (!provider.mediaCapabilities[captured.attachment.kind]) throw new Error('UNSUPPORTED_MEDIA_CAPABILITY');
  provider = provider.forTurn?.() ?? provider;
  const result = await provider.completeMedia({ ...captured, validate });
  assertFresh(); const usage = aiResponseSchema.shape.usage.parse(result.usage);
  const metadata = { usage, provenance: 'untrusted_attachment' as const, grantsExecution: false as const };
  if (result.status === 'refused' && result.text === null) return { ...metadata, status: 'refused', text: null };
  if (result.status !== 'success') throw new Error('INVALID_MEDIA_RESULT');
  return { ...metadata, status: 'success', text: validate(result.text) };
}
