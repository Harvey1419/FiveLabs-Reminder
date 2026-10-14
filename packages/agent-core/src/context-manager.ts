import { aiTranscriptSchema, type AIMessage } from '@templelabs/contracts';

/** Keep whole user turns, including every paired assistant/tool batch. Durable history is untouched. */
export function compactContext(history: readonly AIMessage[], maxMessages: number, keepTurns = 3,
  fitsBudget: (messages: readonly AIMessage[]) => boolean = () => true): AIMessage[] {
  if (!Number.isSafeInteger(maxMessages) || maxMessages < 1
    || !Number.isSafeInteger(keepTurns) || keepTurns < 1) throw new Error('Invalid context limits');
  aiTranscriptSchema.parse(history);
  if (history.length <= maxMessages && fitsBudget(history)) return structuredClone([...history]);
  const starts = history.flatMap((message, index) => message.role === 'user' ? [index] : []);
  const start = starts[Math.max(0, starts.length - keepTurns)] ?? 0;
  const recent = history.slice(start);
  if (recent.length > maxMessages) throw new Error('Conversation requires compaction: recent turns exceed the context limit');
  return structuredClone(recent);
}

/** Conservative serialized-byte reservation, not a measured provider token count.
 * A provider-specific tokenizer may replace it; include schema and framing overhead there.
 */
export function estimateContextTokens(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).length + 256;
}

/** Stable arguments identity within a run; no backend idempotency claim. */
export function canonicalArguments(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalArguments).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalArguments(item)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}
