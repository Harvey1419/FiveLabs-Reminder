import type { AIMessage, JsonObject } from '@templelabs/contracts';

/** Model-only projection. Full records, journals, receipts and dialogue remain durable. */
export function compactModelRecord(raw: Readonly<Record<string, unknown>>): JsonObject {
  const result: JsonObject = {};
  for (const key of ['id', 'domain', 'content', 'title', 'name', 'summary', 'recurrence', 'status', 'kind', 'entityId', 'entityName', 'priority']) {
    const value = raw[key];
    if (typeof value === 'string') result[key] = value;
  }
  const time = raw.time ?? raw.sendAt ?? raw.dueDateIso ?? raw.startIso ?? raw.startDate;
  if (typeof time === 'string') result.time = time;
  const end = raw.endIso ?? raw.endDateExclusive;
  if (typeof end === 'string') result.endTime = end;
  return result;
}
export function projectProductivityHistory(history: readonly AIMessage[]): AIMessage[] {
  return history.map(message => {
    if (message.role !== 'tool' || !message.content || typeof message.content !== 'object' || Array.isArray(message.content)
      || typeof message.content.observation !== 'string') return structuredClone(message);
    let data: unknown;
    try { data = JSON.parse(message.content.observation); } catch { return structuredClone(message); }
    if (!data || typeof data !== 'object' || Array.isArray(data)) return structuredClone(message);
    const raw = data as JsonObject;
    const compact: JsonObject = {};
    for (const key of ['operation', 'complete', 'coverage', 'returnedCount', 'shownCount', 'companion', 'connection',
      'clarificationRequired', 'errorCode', 'questions', 'issues', 'rejectionCount', 'sources']) {
      const value = raw[key];
      if (value !== undefined && value !== null && value !== false && !(Array.isArray(value) && !value.length)) compact[key] = value;
      // A false completion is material evidence and must survive projection.
      if (key === 'complete' && value === false) compact.complete = false;
    }
    for (const key of ['records', 'events', 'projects', 'entities']) if (Array.isArray(raw[key])) compact[key] = raw[key].map(value =>
      value && typeof value === 'object' && !Array.isArray(value) ? compactModelRecord(value) : value);
    return { ...message, content: { ...message.content, status: message.content.status ?? 'failed', observation: compact } };
  });
}
