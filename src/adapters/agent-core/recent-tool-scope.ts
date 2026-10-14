import type { AIMessage } from '@templelabs/contracts';

/** Cache recent successful schemas, never classify text or authorize effects. */
export function recentToolScope(history: readonly AIMessage[], available: readonly string[], defaults: readonly string[]): readonly string[] {
  const calls = new Map(history.flatMap(message => message.role === 'assistant' ? message.toolCalls.map(call => [call.id, call.name] as const) : []));
  const names: string[] = [];
  for (let index = history.length - 1; index >= 0 && names.length < 2; index--) {
    const message = history[index];
    if (message?.role !== 'tool' || message.isError || !message.content || typeof message.content !== 'object'
      || Array.isArray(message.content) || message.content.status !== 'success') continue;
    const name = calls.get(message.toolCallId);
    if (name && available.includes(name) && !names.includes(name)) names.push(name);
  }
  return [...new Set([...names, ...defaults.filter(name => available.includes(name))])].slice(0, 2);
}
