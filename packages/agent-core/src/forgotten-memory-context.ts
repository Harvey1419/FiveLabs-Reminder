import { aiMessageSchema, type AIMessage, type MemoryRecord } from '@templelabs/contracts';

/** Model projection only. Durable transcripts/receipts remain unchanged for reconciliation.
 * Fresh current-turn user input may explicitly restate a previously forgotten fact. */
export function projectForgottenMemoryHistory(history: readonly AIMessage[], previousLength: number, memories: readonly MemoryRecord[]): AIMessage[] {
  const forgotten = memories.filter(record => record.status === 'forgotten');
  if (!forgotten.length) return [...history];
  const ids = new Set(forgotten.map(record => record.id));
  const scrub = (value: unknown): unknown => {
    if (typeof value === 'string') return forgotten.reduce((text, record) => text.replaceAll(record.content, '[forgotten memory]'), value);
    if (Array.isArray(value)) return value.map(scrub);
    if (!value || typeof value !== 'object') return value;
    const result: Record<string, unknown> = Object.fromEntries(Object.entries(value).map(([key, entry]) => {
      if (key === 'observation' && typeof entry === 'string') {
        try { return [key, JSON.stringify(scrub(JSON.parse(entry)))]; } catch { /* Plain observations remain text. */ }
      }
      return [key, scrub(entry)];
    }));
    if (typeof result.id === 'string' && ids.has(result.id) && typeof result.content === 'string') {
      result.content = '[forgotten memory]'; result.status = 'forgotten';
    }
    return result;
  };
  return history.map((message, index) => index < previousLength ? aiMessageSchema.parse(scrub(message)) : message);
}
