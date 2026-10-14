export const WHATSAPP_TEXT_LIMIT = 4000;

/** Bound UTF-16 length without splitting an emoji, combining character or surrogate pair. */
export function boundWhatsAppText(text: string, suffix = '\n\n…'): string {
  if (text.length <= WHATSAPP_TEXT_LIMIT) return text;
  const budget = WHATSAPP_TEXT_LIMIT - suffix.length;
  if (budget < 1) throw new Error('Invalid WhatsApp truncation suffix');
  let result = '';
  for (const { segment } of new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text)) {
    if (result.length + segment.length > budget) break;
    result += segment;
  }
  const boundary = result.lastIndexOf('\n');
  if (boundary > budget / 2) result = result.slice(0, boundary);
  return result.trimEnd() + suffix;
}
