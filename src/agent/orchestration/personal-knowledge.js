import { randomBytes } from 'node:crypto';

export const PERSONAL_READ_OPERATIONS = new Set(['agenda.read', 'task.list', 'reminder.list', 'calendar.list', 'calendar.search', 'calendar.next', 'memory.search', 'memory.list', 'project.list', 'entity.list', 'subscription.info', 'subscription.status', 'admin.metrics']);

/** Current-turn capabilities only. Missing provenance fails closed, never inferred. */
export function buildPersonalKnowledge(userId, memories = [], preferences = []) {
  const lookup = new Map();
  const refs = new Map();
  const seen = new Set();
  const nonce = randomBytes(6).toString('hex');
  let chars = 0;
  for (const record of [...memories.slice(0, 20), ...preferences.slice(0, 20)]) {
    if (!userId || record?.user_id !== userId || record.is_active !== true
      || record.superseded_by
      || record.valid_until != null && !(Date.parse(record.valid_until) > Date.now())
      || record.valid_from != null && !(Date.parse(record.valid_from) <= Date.now())
      || !['fact', 'preference', 'decision', 'episode'].includes(record.category)
      || typeof record.topic_key !== 'string' || record.topic_key.length > 100
      || !/^[a-z0-9]+(?:_[a-z0-9]+)*(?:\/[a-z0-9]+(?:_[a-z0-9]+)*)+$/.test(record.topic_key)
      || typeof record.content !== 'string' || !record.content.trim()
      || record.content.length > 180 || /[\u0000-\u001f<>]/.test(record.content)) continue;
    const identity = `${record.topic_key}\n${record.content}`;
    if (seen.has(identity) || lookup.size >= 16 || chars + record.content.length > 2400) continue;
    seen.add(identity);
    const ref = `pk_${nonce}_${lookup.size + 1}`;
    lookup.set(ref, Object.freeze({ userId, content: record.content }));
    refs.set(record, ref);
    chars += record.content.length;
  }
  return { lookup, refs };
}

export function renderPersonalKnowledge(refs, lookup, userId, language) {
  const selected = [...new Set(refs)].slice(0, 8);
  if (!selected.length) return '';
  const facts = selected.map(ref => lookup.get(ref));
  const quotes = facts.filter(fact => fact?.userId === userId).map(fact => `“${fact.content}”`);
  const missing = facts.some(fact => !fact || fact.userId !== userId);
  return [quotes.length ? (language === 'en' ? 'What I have recorded about you:' : 'Lo que tengo registrado de ti:') : '',
    ...quotes, missing ? (language === 'en' ? 'I could not support that part with the available memories.' : 'No pude respaldar esa parte con los recuerdos disponibles.') : ''].filter(Boolean).join('\n');
}
