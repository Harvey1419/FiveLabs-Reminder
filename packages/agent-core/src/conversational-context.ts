import type { AIMessage } from '@templelabs/contracts';

/** A small verbatim view of the preceding exchange, never a model-written summary.
 * Call with already privacy-projected history. Tool-call prose and observations
 * are deliberately excluded; execution evidence remains in the tool protocol.
 * The durable presenter owns which final assistant reply is stored in history.
 */
export function conversationalContinuity(previous: readonly AIMessage[]): (messages: readonly AIMessage[]) => AIMessage[] {
  const start = previous.flatMap((message, index) => message.role === 'user' ? [index] : []).at(-1);
  const turn = previous.slice(start ?? previous.length);
  const user = turn[0];
  const assistant = turn.filter(message => message.role === 'assistant' && !message.toolCalls.length && message.content.trim()).at(-1);
  const exchange = [user, assistant].flatMap(message => {
    if (!message || (message.role !== 'user' && message.role !== 'assistant')) return [];
    const content = message.content.slice(0, 800);
    return [{ role: message.role, content, ...(content.length < message.content.length ? { truncated: true } : {}) }];
  });
  const historical = exchange.length ? '\n' + JSON.stringify({ historicalDialogue: {
    freshness: 'historical', grantsAuthorization: false, executionEvidence: false, queuedActions: false, exchange,
  } }) : '';
  return messages => {
    // Operational compaction preserves complete turn boundaries. If two users
    // remain, the preceding exchange is already present: do not duplicate it.
    if (!historical || messages.filter(message => message.role === 'user').length > 1) return [...messages];
    return messages.map(message => message.role === 'system' ? { ...message, content: message.content + historical } : message);
  };
}
