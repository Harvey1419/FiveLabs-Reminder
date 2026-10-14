/** Pure domain text normalization, independent of WhatsApp transport. */
export function stripReminderPrefix(text: unknown) {
  if (!text || typeof text !== 'string') return '';
  let s = text.trim();
  const pattern = /^(\s*⏰\s*)?(\*?Recordatorio:\*?|\*?Recordatorio\*?:?)\s*/i;
  while (pattern.test(s)) {
    const match = pattern.exec(s);
    if (!match || match[0].length === 0) break;
    s = s.slice(match[0].length).trim();
  }
  return s;
}
