import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ReminderRow, ReminderQuery } from '../../../src/agent/tools/reminder-tool-ports.js';
import { reminderDateActions, reminderDateMessage } from '../../fixtures/agent/behavioral-reminder-date-fixtures.js';
import { getStructuredTurnSchema } from '../../../src/agent/contracts/foreground-turn-schema.js';
import { matchesSchema } from '../../../src/agent/contracts/schema-value-contract.js';
import { validateForegroundContent } from '../../../src/agent/contracts/foreground-turn-validator.js';
import { buildDomainCall } from '../../../src/agent/orchestration/domain-call.js';
import { createReminderReadTools } from '../../../src/agent/tools/reminder-read-tools.js';
import { normalizeReminderQuery } from '../../../src/agent/contracts/reminder-query.js';
import { buildReminderOwnerContext, scopeReminderQueryToOwner } from '../../../src/agent/tools/reminder-owner.js';
import { formatHumanFriendlyDateTime, resolveCalendarTemporalScope } from '../../../src/shared/time.js';
import { parseReminderScope } from '../../../src/shared/agenda-scopes.js';
import { formatCanonicalReminderList } from '../../../src/shared/reminder-presentation.js';
import { createExecutionFact } from '../../../src/agent/core/execution-facts.js';
type FixtureRow = ReminderRow & Record<string, unknown>;
const user = { id: 'date-read-owner', phone_number: '573990001122', timezone: 'America/Bogota' };
const referenceTime = new Date('2026-09-02T17:00:00.000Z');
const row = (id: string, fields: Partial<ReminderRow> = {}): FixtureRow => ({ id, user_id: user.id, phone_number: user.phone_number,
  content: `Reminder ${id}`, status: 'pending', send_at: '2026-09-02T15:00:00.000Z', created_at: referenceTime.toISOString(), acknowledged_at: null, ...fields });
afterEach(() => vi.useRealTimers());
function call(key: keyof typeof reminderDateActions) {
  const message = reminderDateMessage(key);
  expect(matchesSchema(JSON.parse(message.content), getStructuredTurnSchema() as Parameters<typeof matchesSchema>[1])).toBe(true);
  const validation = validateForegroundContent(message.content);
  if (!validation.valid) throw new Error(validation.error);
  const result = buildDomainCall(validation.intent.actions[0], { user, timezone: user.timezone, referenceTime });
  if (!result.valid || !('toolName' in result)) throw new Error('Expected reminder read');
  return result;
}
function fixture(input: FixtureRow[]) {
  const predicates: { method: string; column: string; value: unknown }[] = [];
  const service = createReminderReadTools({ normalizeReminderQuery: normalizeReminderQuery as unknown as Parameters<typeof createReminderReadTools>[0]['normalizeReminderQuery'], buildReminderOwnerContext, scopeReminderQueryToOwner,
    formatHumanFriendlyDateTime, resolveCalendarTemporalScope, parseReminderScope, logger: console,
    supabase: { from: () => {
      let rows = [...input];
      const query: ReminderQuery = {
        select: () => query, update: () => query,
        eq: (column, value) => { rows = rows.filter(item => item[column] === value); return query; },
        neq: (column, value) => { rows = rows.filter(item => item[column] !== value); return query; },
        in: (column, values) => { rows = rows.filter(item => values.includes(item[column])); return query; },
        or: expression => { predicates.push({ method: 'or', column: 'owner', value: expression });
          const alternatives = expression.split(',').map(term => term.split('.eq.'));
          rows = rows.filter(item => alternatives.some(([column, value]) => item[column!] === value)); return query; },
        is: (column, value) => { rows = rows.filter(item => item[column] === value); return query; },
        not: (column, _operator, value) => { rows = rows.filter(item => item[column] !== value); return query; },
        gte: (column, value) => { if (typeof value !== 'string') throw new Error('Expected ISO date bound'); predicates.push({ method: 'gte', column, value }); rows = rows.filter(item => typeof item[column] === 'string' && String(item[column]) >= value); return query; },
        lt: (column, value) => { if (typeof value !== 'string') throw new Error('Expected ISO date bound'); predicates.push({ method: 'lt', column, value }); rows = rows.filter(item => typeof item[column] === 'string' && String(item[column]) < value); return query; },
        ilike: () => query, textSearch: () => query,
        order: (column, options) => { rows.sort((a, b) => String(a[column]).localeCompare(String(b[column])) * (options.ascending ? 1 : -1)); return query; },
        limit: count => { rows = rows.slice(0, count); return query; },
        maybeSingle: async () => ({ data: rows[0] ?? null, error: null }),
        then: (resolve, reject) => Promise.resolve({ data: rows, error: null }).then(resolve, reject),
      };
      return query;
    } },
  });
  async function read(key: keyof typeof reminderDateActions, now = referenceTime, timezone = user.timezone) {
    const selected = call(key);
    const result = await service.executeReminderReadTool({ params: selected.params, user: { ...user, timezone }, referenceTime: now, language: 'es' });
    expect(result.success).toBe(true);
    if (!result.data) throw new Error('Expected successful read data');
    return { data: result.data, card: createExecutionFact({ toolName: selected.toolName, params: selected.params, result, language: 'es', timezone }).card };
  }
  return { read, predicates };
}

describe('current reminder date-read integration fixtures', () => {
  it.each(Object.keys(reminderDateActions) as (keyof typeof reminderDateActions)[])('%s preserves its canonical filter', key => {
    expect(call(key)).toMatchObject({ toolName: 'manage_reminder', params: { action: 'list', filter: reminderDateActions[key].filter } });
  });
  it('created today retains completed user reminders and excludes cancelled, Calendar and foreign rows', async () => {
    const f = fixture([row('A', { created_at: '2026-09-01T10:00:00.000Z' }), row('B', { send_at: '2026-09-03T20:00:00.000Z' }),
      row('C', { status: 'sent', acknowledged_at: '2026-09-02T16:00:00.000Z' }), row('cancelled', { status: 'cancelled' }),
      row('calendar', { delivery_id: 'gcal:event' }), row('foreign', { user_id: 'other-owner', phone_number: 'other-phone' })]);
    const { data, card } = await f.read('createdToday');
    expect(data.reminders.map(item => item.id)).toEqual(['B', 'C']);
    expect(card).toContain('Recordatorios creados hoy');
    expect(card).toContain('Reminder B'); expect(card).toContain('Reminder C');
    expect(card).not.toContain('Reminder A');
    expect(f.predicates).toContainEqual({ method: 'gte', column: 'created_at', value: '2026-09-02T05:00:00.000Z' });
  });
  it('pending and completed use schedule and acknowledgement dates independently', async () => {
    const f = fixture([row('A', { created_at: '2026-09-01T10:00:00.000Z' }), row('B', { send_at: '2026-09-03T20:00:00.000Z' }), row('C', { status: 'sent', acknowledged_at: '2026-09-02T16:00:00.000Z' })]);
    expect((await f.read('pendingToday')).data.reminders.map(item => item.id)).toEqual(['A']);
    const { data, card } = await f.read('completedToday');
    expect(data.reminders.map(item => item.id)).toEqual(['C']); expect(card).toContain('Recordatorios completados hoy');
    expect(f.predicates).toContainEqual({ method: 'gte', column: 'acknowledged_at', value: '2026-09-02T05:00:00.000Z' });
  });
  it('remaining includes now and excludes past and the exclusive next midnight', async () => {
    const now = new Date('2026-09-03T02:45:00.000Z');
    const f = fixture([row('past', { send_at: '2026-09-03T02:44:59.999Z' }), row('now', { send_at: now.toISOString() }), row('later', { send_at: '2026-09-03T03:30:00.000Z' }), row('midnight', { send_at: '2026-09-03T05:00:00.000Z' })]);
    expect((await f.read('pendingToday', now)).data.reminders.map(item => item.id)).toEqual(['past', 'now', 'later']);
    const { data, card } = await f.read('remainingToday', now);
    expect(data.reminders.map(item => item.id)).toEqual(['now', 'later']); expect(card).toContain('Recordatorios de hoy');
    expect(f.predicates).toContainEqual({ method: 'gte', column: 'send_at', value: now.toISOString() });
    expect(f.predicates).toContainEqual({ method: 'lt', column: 'send_at', value: '2026-09-03T05:00:00.000Z' });
  });
  it.each(['es', 'en'] as const)('created history has factual populated and empty copy in %s', language => {
    const data = { filter: 'created_today', reminders: [row('C', { status: 'sent', acknowledged_at: referenceTime.toISOString() })] };
    const card = formatCanonicalReminderList(data, { language, timezone: user.timezone });
    expect(card).toContain(language === 'en' ? 'Reminders created today' : 'Recordatorios creados hoy');
    expect(card).toContain('Reminder C');
    expect(card).not.toContain(language === 'en' ? 'Pending reminders' : 'Recordatorios pendientes');
    const empty = formatCanonicalReminderList({ filter: 'created_today', reminders: [] }, { language });
    expect(empty).toContain(language === 'en' ? 'I found no reminders created today.' : 'No encontré recordatorios creados hoy.');
  });
  it('pending day visibility still retains recurring reminders after an earlier acknowledgement', async () => {
    const f = fixture([row('recurring', { recurrence_rule: 'daily', acknowledged_at: referenceTime.toISOString() }), row('one-time', { acknowledged_at: referenceTime.toISOString() })]);
    expect((await f.read('pendingToday')).data.reminders.map(item => item.id)).toEqual(['recurring']);
  });
  it('created-today bounds follow a 23-hour DST civil day', async () => {
    const f = fixture([row('inside', { created_at: '2027-03-14T08:00:00.000Z' }), row('end', { created_at: '2027-03-15T07:00:00.000Z' })]);
    expect((await f.read('createdToday', new Date('2027-03-14T17:00:00Z'), 'America/Los_Angeles')).data.reminders.map(item => item.id)).toEqual(['inside']);
    expect(f.predicates).toContainEqual({ method: 'gte', column: 'created_at', value: '2027-03-14T08:00:00.000Z' });
    expect(f.predicates).toContainEqual({ method: 'lt', column: 'created_at', value: '2027-03-15T07:00:00.000Z' });
  });
});
