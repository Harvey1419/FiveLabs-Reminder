const ATTACHMENT_RE = /<untrusted_attachment_content>[\s\S]*?<\/untrusted_attachment_content>/gi;
const QUOTED_RE = /<untrusted_quoted_message>[\s\S]*?<\/untrusted_quoted_message>/gi;
const LEGACY_QUOTED_PREFIX_RE = /^\[Respondiendo a:[\s\S]*?\]\s*/i;

/** Return only the user's current utterance, never quoted text or OCR. */
export function extractCurrentUserText(modelContextText: unknown, suppliedCurrentUserText?: unknown): string {
  if (typeof suppliedCurrentUserText === 'string') return suppliedCurrentUserText.trim();
  return String(modelContextText || '')
    .replace(LEGACY_QUOTED_PREFIX_RE, '')
    .replace(QUOTED_RE, '')
    .replace(ATTACHMENT_RE, '')
    .trim();
}
