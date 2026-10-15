import { aiTranscriptSchema, productivityToolNameSchema, type AIMessage, type JsonObject } from '@templelabs/contracts';

/** Collapse only completed, successful tool batches in the active turn. Durable history is untouched. */
export function activeToolContextCandidates(history: readonly AIMessage[], userId: string): { history: AIMessage[]; summary: string }[] {
  let start = -1; history.forEach((message, index) => { if (message.role === 'user') start = index; });
  if (start < 0) return [];
  const candidates: { history: AIMessage[]; summary: string }[] = [];
  const completed: JsonObject[] = [];
  let index = start + 1;
  while (index < history.length) {
    const assistant = history[index];
    if (assistant?.role !== 'assistant' || !assistant.toolCalls.length) break;
    const end = index + assistant.toolCalls.length + 1;
    const observations = history.slice(index + 1, end);
    if (observations.length !== assistant.toolCalls.length || observations.some((message, offset) => message.role !== 'tool'
      || message.toolCallId !== assistant.toolCalls[offset]?.id || message.isError || !message.content
      || typeof message.content !== 'object' || Array.isArray(message.content) || message.content.status !== 'success')) break;
    for (const call of assistant.toolCalls) {
      if (!productivityToolNameSchema.safeParse(call.name).success) continue; // Discovery has no domain effect.
      const observation = observations[assistant.toolCalls.indexOf(call)];
      const content = observation?.role === 'tool' ? observation.content : null;
      if (content && typeof content === 'object' && !Array.isArray(content) && content.code === 'WRITE_ALREADY_CONFIRMED') continue;
      const data = content && typeof content === 'object' && !Array.isArray(content) ? content.observation : null;
      const records = data && typeof data === 'object' && !Array.isArray(data) ? data.records ?? data.events : null;
      const resources = Array.isArray(records) ? records.flatMap(record => record && typeof record === 'object' && !Array.isArray(record)
        && typeof record.id === 'string' ? [{ id: record.id, ...(typeof record.content === 'string' ? { content: record.content.slice(0, 80) } : {}),
          ...(typeof record.title === 'string' ? { title: record.title.slice(0, 80) } : {}), ...(typeof record.time === 'string' ? { time: record.time } : {}),
          ...(typeof record.recurrence === 'string' ? { recurrence: record.recurrence } : {}) }] : []) : [];
      completed.push({ toolName: call.name, status: 'success', observedResourceCount: resources.length, resources });
    }
    const summary = JSON.stringify({ completedActiveTools: { userId, scope: 'current_turn', provenance: 'host_owned_tool_transcript', grantsAuthorization: false,
      omittedMessages: end - start - 1, operationCount: completed.length, operations: completed } });
    const projected = [...history.slice(0, start + 1), ...history.slice(end)];
    aiTranscriptSchema.parse(projected);
    candidates.push({ history: structuredClone(projected), summary });
    index = end;
  }
  return candidates;
}
