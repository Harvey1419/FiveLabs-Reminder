import { createRequire } from 'node:module';
import { untrustedResultMock, expectValid, expectInvalid } from '../../support/unit/contract-boundary.js';
import type { Mock } from 'vitest';

type QueryRow = { [field: string]: string | null };
type QueryResult = { data: QueryRow[]; error: null };
type QueryMethod = 'select' | 'or' | 'eq' | 'in' | 'is' | 'gte' | 'lt' | 'neq' | 'not' | 'order' | 'limit' | 'ilike';
type QueryMock = { [K in QueryMethod]: Mock<(...args: unknown[]) => QueryMock> } & PromiseLike<QueryResult>;
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { formatCanonicalReminderList } from '../../../src/shared/reminder-presentation.js';

vi.mock('../../../src/infrastructure/database/index.js', () => ({
  supabase: { from: vi.fn() },
  saveReminder: vi.fn(),
  getRemindersByPhone: vi.fn(),
  cancelPendingRemindersByContent: vi.fn(),
  acknowledgeReminder: vi.fn(),
  acknowledgeReminders: vi.fn(),
  markReminderAsCancelled: vi.fn(),
  updateReminder: vi.fn(),
  createTask: vi.fn(),
  getUserSubscription: vi.fn().mockResolvedValue(null),
  hasProAccess: vi.fn().mockReturnValue(true),
  shouldEnforceBillingForUser: vi.fn().mockReturnValue(false),
}));

const { supabase, markReminderAsCancelled } = await import('../../../src/infrastructure/database/index.js');
const { executeReminderReadTool } = await import('../../../src/agent/tools/reminder-read.js');
const { executeBulkReminderCancellation } = await import('../../../src/agent/tools/reminder-bulk-cancel.js');

function queryResult(data: QueryRow[] = []): QueryMock {
  // The loop below installs every fluent method before the mock is returned.
  const query = {} as QueryMock;
  for (const method of ['select', 'or', 'eq', 'in', 'is', 'gte', 'lt', 'neq', 'not', 'order', 'limit', 'ilike'] as const) {
    query[method] = vi.fn(() => query);
  }
  query.then = (resolve, reject) => {
    let rows = data;
    for (const [column, pattern] of query.ilike.mock.calls) {
      const body = (pattern as string).slice(1, -1);
      let literal = '';
      for (let i = 0; i < body.length; i++) {
        if (body[i] === '\\') i++;
        literal += body[i];
      }
      rows = rows.filter(row => String(row[column as string] || '').toLowerCase().includes(literal.toLowerCase()));
    }
    for (const [column, value] of query.eq.mock.calls) rows = rows.filter(row => row[column as string] === value);
    for (const [column, value] of query.gte.mock.calls) rows = rows.filter(row => (row[column as string] as string) >= (value as string));
    for (const [column, value] of query.lt.mock.calls) rows = rows.filter(row => (row[column as string] as string) < (value as string));
    for (const [limit] of query.limit.mock.calls) rows = rows.slice(0, limit as number);
    return Promise.resolve({ data: rows, error: null }).then(resolve, reject);
  };
  return query;
}

describe('reminder list delivery-state semantics', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('queries future pending rows and applies canonical visibility semantics', async () => {
    const query = queryResult([{
      id: 'future-1',
      content: 'Llamar a Laura',
      send_at: '2026-09-05T22:00:00.000Z',
      status: 'pending',
      acknowledged_at: null,
    }]);
    untrustedResultMock(supabase.from).mockReturnValue(query);

    const result = await executeReminderReadTool({
      params: {},
      user: { id: 'user-1', phone_number: '+573000000001', timezone: 'America/Bogota' },
      language: 'es',
      referenceTime: new Date('2026-09-05T20:34:12.000Z'),
    });

    expect(result).toMatchObject({ success: true, action: 'listed_reminders' });
    expect(query.eq).toHaveBeenCalledWith('status', 'pending');
    expect(query.gte).toHaveBeenCalledWith('send_at', '2026-09-05T20:34:12.000Z');
    expect(query.is).not.toHaveBeenCalledWith('acknowledged_at', null);
    expect(query.ilike).not.toHaveBeenCalled();
    expect(result.data).toMatchObject({ filter: 'upcoming' });
    expect(result.data!.reminders).toHaveLength(1);
    expect(result.data!.reminders[0]).toMatchObject({ id: 'future-1', content: 'Llamar a Laura' });
  });

  it.each([null, {}, 42, '', '   ', 'a'.repeat(201), '*', 'a\0b'])('rejects invalid query %j before database access', async value => {
    const result = await executeReminderReadTool({ params: { query: value }, user: { id: 'user-1' }, language: 'en' });
    expect(result).toMatchObject({ success: false, errorCode: 'INVALID_QUERY' });
    expect(supabase.from).not.toHaveBeenCalled();
    const { buildDomainCall } = await import('../../../src/agent/orchestration/domain-call.js');
    const call = buildDomainCall({ domain: 'reminder', action: 'list', query: value }, { language: 'en' });
    expectInvalid(call);
    expect(call.error).toBe(result.error);
  });

  it.each(['AlFa', '50%', 'a_b', 'a\\b'])('filters literal content %s before limit', async value => {
    const query = queryResult([]);
    untrustedResultMock(supabase.from).mockReturnValue(query);
    const result = await executeReminderReadTool({ params: { query: ` ${value} ` }, user: { id: 'user-1' } });
    expect(result.success).toBe(true);
    const pattern = '%' + value.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_') + '%';
    expect(query.ilike).toHaveBeenCalledWith('content', pattern);
    expect(query.ilike.mock.invocationCallOrder[0]!).toBeLessThan(query.limit.mock.invocationCallOrder[0]!);
    expect(query.eq).toHaveBeenCalledWith('status', 'pending');
    expect(query.gte).toHaveBeenCalledWith('send_at', expect.any(String));
    expect(result.data!.reminders).toEqual([]);
  });

  it.each(['AlFa', '50%', 'a_b', 'a\\b'])('returns matching content %s beyond the unfiltered limit', async value => {
    const base = { user_id: 'user-1', status: 'pending', send_at: '2031-01-01T12:00:00Z', acknowledged_at: null };
    const query = queryResult([
      ...Array.from({ length: 50 }, (_, i) => ({ ...base, id: `other-${i}`, content: 'Unrelated' })),
      { ...base, id: 'match', content: `Review ${value.toUpperCase()} please` },
      { ...base, id: 'foreign', user_id: 'user-2', content: value },
      { ...base, id: 'sent', status: 'sent', content: value },
      { ...base, id: 'past', send_at: '2020-01-01', content: value },
      { ...base, id: 'hidden', delivery_id: 'gcal:event', content: value },
    ]);
    untrustedResultMock(supabase.from).mockReturnValue(query);
    const result = await executeReminderReadTool({ params: { query: value }, user: { id: 'user-1' }, referenceTime: new Date('2030-01-01') });
    expect(result.data!.reminders.map(row => row.id)).toEqual(['match']);
    for (const language of ['es', 'en']) {
      expect(formatCanonicalReminderList(result.data, { language })).toBe(formatCanonicalReminderList({ ...result.data, query: undefined }, { language }));
    }
    expect(query.eq).toHaveBeenCalledWith('user_id', 'user-1');
    expect(query.or).not.toHaveBeenCalled();
  });

  it.each(['es', 'en'].flatMap(language => ['upcoming', 'tomorrow', 'day_after_tomorrow', 'today', 'pending_today', 'remaining_today', 'this_week', 'next_week', 'completed_today', 'created_today', 'this_weekend'].map(filter => ({ language, filter }))))('renders query-scoped empty cards for $language/$filter', async ({ language, filter }) => {
    const query = queryResult([{ id: 'owned', user_id: 'user-1', content: 'Llamar a Laura', status: 'pending', send_at: '2031-01-01T12:00:00Z', acknowledged_at: null }]);
    untrustedResultMock(supabase.from).mockReturnValue(query);
    const result = await executeReminderReadTool({ params: { query: 'Alfa', filter }, language, user: { id: 'user-1' }, referenceTime: new Date('2030-01-01') });
    expect(result.data!.reminders).toEqual([]);
    const header = formatCanonicalReminderList({ reminders: [], filter }, { language }).split('\n\n')[0];
    const message = language === 'en'
      ? 'No reminders match your search within the requested scope. 🔎'
      : 'No hay recordatorios que coincidan con tu búsqueda dentro del alcance solicitado. 🔎';
    const card = formatCanonicalReminderList(result.data, { language });
    expect(card).toBe(`${header}\n\n${message}`);
    expect(card).not.toContain('Alfa');
  });

  it.each([
    ['upcoming', 'You have no pending reminders. Enjoy your peace of mind! ☕', 'No tienes recordatorios pendientes. ¡Tranquilidad total y todo bajo control! ☕'],
    ['tomorrow', 'You have no reminders scheduled for tomorrow. Your day is completely clear! 🚀', 'No tienes recordatorios programados para mañana. ¡Día completamente despejado! 🚀'],
    ['day_after_tomorrow', 'You have no reminders scheduled for the day after tomorrow. Enjoy your clear schedule! ✨', 'No tienes recordatorios programados para pasado mañana. ¡Panorama despejado! ✨'],
    ['today', 'You have no pending reminders for today. You are all caught up! ☕', 'No tienes recordatorios pendientes para hoy. ¡Estás al día por completo! ☕'],
    ['this_week', 'You have no reminders scheduled for this week. Have a relaxed and focused week! 🌟', 'No tienes recordatorios programados para esta semana. ¡Semana libre de alarmas por ahora! 🌟'],
    ['next_week', 'You have no reminders scheduled for next week. Clear schedule ahead! 🎯', 'No tienes recordatorios programados para la próxima semana. ¡Agenda despejada! 🎯'],
    ['completed_today', 'You have no pending reminders. Enjoy your peace of mind! ☕', 'No tienes recordatorios pendientes. ¡Tranquilidad total y todo bajo control! ☕'],
  ])('preserves exact no-query empty wording for %s', (filter, en, es) => {
    for (const language of ['en', 'es']) {
      const card = formatCanonicalReminderList({ reminders: [], filter }, { language });
      expect(card.split('\n\n')[1]).toBe(language === 'en' ? en : es);
      expect(formatCanonicalReminderList({ reminders: [], filter, query: undefined }, { language })).toBe(card);
    }
  });

  it('returns zero content matches from a populated legitimate owner dataset', async () => {
    const rows = [
      { id: 'owned-1', user_id: 'user-1', content: 'Llamar a Laura', status: 'pending', send_at: '2031-01-01T12:00:00Z', acknowledged_at: null },
      { id: 'owned-2', user_id: 'user-1', content: 'Revisar presupuesto', status: 'pending', send_at: '2031-01-02T12:00:00Z', acknowledged_at: null },
    ];
    const query = queryResult(rows);
    untrustedResultMock(supabase.from).mockReturnValue(query);
    const result = await executeReminderReadTool({ params: { query: 'Alfa' }, user: { id: 'user-1' }, referenceTime: new Date('2030-01-01') });
    expect(result).toMatchObject({ success: true, data: { query: 'Alfa', reminders: [], items: [] } });
    expect(formatCanonicalReminderList(result.data, { language: 'es' })).toBe('🔔 *Recordatorios pendientes*\n\nNo hay recordatorios que coincidan con tu búsqueda dentro del alcance solicitado. 🔎');
    expect(formatCanonicalReminderList(result.data, { language: 'en' })).toBe('🔔 *Pending reminders*\n\nNo reminders match your search within the requested scope. 🔎');
    expect(query.eq).toHaveBeenCalledWith('user_id', 'user-1');
    expect(query.ilike).toHaveBeenCalledWith('content', '%Alfa%');
    expect(query.ilike.mock.invocationCallOrder[0]!).toBeLessThan(query.limit.mock.invocationCallOrder[0]!);
    const unfilteredQuery = queryResult(rows);
    untrustedResultMock(supabase.from).mockReturnValue(unfilteredQuery);
    const unfiltered = await executeReminderReadTool({ user: { id: 'user-1' }, referenceTime: new Date('2030-01-01') });
    expect(unfiltered.data!.reminders).toEqual(rows);
    expect(unfilteredQuery.ilike).not.toHaveBeenCalled();
  });

  it.each([undefined, 'a'.repeat(200), ` ${'a'.repeat(200)} `])('accepts absent or maximum trimmed query without broadening', async value => {
    const query = queryResult([]);
    untrustedResultMock(supabase.from).mockReturnValue(query);
    const result = await executeReminderReadTool({ params: { query: value }, user: { id: 'user-1' } });
    expect(result.success).toBe(true);
    if (value === undefined) expect(query.ilike).not.toHaveBeenCalled();
    else expect(query.ilike).toHaveBeenCalledWith('content', `%${'a'.repeat(200)}%`);
  });

  it('serializes literal patterns through the installed SDK with isolated fetch', async () => {
    // Use the installed SDK without importing its incompatible WebAuthn declarations.
    const { createClient } = createRequire(import.meta.url)('@supabase/supabase-js') as {
      createClient(url: string, key: string, options: { global: { fetch: typeof fetch }; auth: { persistSession: false; autoRefreshToken: false; detectSessionInUrl: false } }): {
        from(table: string): {
          select(columns: string): { eq(column: string, value: string): { ilike(column: string, pattern: string): { limit(count: number): PromiseLike<unknown> } } };
        };
      };
    };
    const { normalizeReminderQuery } = await import('../../../src/agent/contracts/reminder-query.js');
    const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response('[]', { status: 200, headers: { 'Content-Type': 'application/json' } }));
    const client = createClient('https://example.invalid', 'offline-test-key', { global: { fetch }, auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } });
    const normalized = normalizeReminderQuery('50%_\\,().');
    expectValid(normalized);
    const { pattern } = normalized;
    await client.from('reminders').select('*').eq('user_id', 'user-1').ilike('content', pattern).limit(50);
    expect(fetch).toHaveBeenCalledTimes(1);
    const url = new URL(fetch.mock.calls[0]![0] as string);
    expect(url.hostname).toBe('example.invalid');
    expect(url.searchParams.get('content')).toBe(`ilike.${pattern}`);
    expect(url.searchParams.get('user_id')).toBe('eq.user-1');
    expect(url.searchParams.has('or')).toBe(false);
  });

  it('does not treat already sent reminders as pending-today rows', async () => {
    const query = queryResult([]);
    untrustedResultMock(supabase.from).mockReturnValue(query);

    await executeReminderReadTool({
      params: { filter: 'pending_today' },
      user: { id: 'user-1', phone_number: '+573000000001', timezone: 'America/Bogota' },
      language: 'es',
      referenceTime: new Date('2026-09-05T20:34:12.000Z'),
    });

    expect(query.eq).toHaveBeenCalledWith('status', 'pending');
    expect(query.neq).not.toHaveBeenCalledWith('status', 'cancelled');
  });

  it('stages elapsed reminder cleanup once and preserves its backend cutoff', async () => {
    const rows = [
      { id: 'elapsed-1', content: 'Anterior uno', send_at: '2026-09-05T18:00:00.000Z', status: 'sent' },
      { id: 'elapsed-2', content: 'Anterior dos', send_at: '2026-09-05T19:00:00.000Z', status: 'missed' },
    ];
    const query = queryResult(rows);
    untrustedResultMock(supabase.from).mockReturnValue(query);

    const result = await executeBulkReminderCancellation({
      params: { scope: 'elapsed' },
      user: { id: 'user-1', phone_number: '+573000000001', timezone: 'America/Bogota' },
      language: 'es',
      referenceTime: new Date('2026-09-05T20:34:12.000Z'),
    });

    expect(query.neq).toHaveBeenCalledWith('status', 'cancelled');
    expect(query.lt).toHaveBeenCalledWith('send_at', '2026-09-05T20:34:12.000Z');
    expect(markReminderAsCancelled).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      success: false,
      errorCode: 'CONFIRMATION_REQUIRED',
      requiresClarification: true,
      pendingClarifications: [{
        proposedOperation: {
          kind: 'reminder_cancel',
          scope: 'elapsed',
          cutoffAt: '2026-09-05T20:34:12.000Z',
        },
      }],
    });
    expect(result.formattedCard).toContain('Encontré 2 recordatorios');
  });

  it('cancels the staged elapsed collection after confirmation without asking again', async () => {
    const rows = [
      { id: 'elapsed-1', content: 'Anterior uno', send_at: '2026-09-05T18:00:00.000Z', status: 'sent' },
      { id: 'elapsed-2', content: 'Anterior dos', send_at: '2026-09-05T19:00:00.000Z', status: 'failed' },
    ];
    const query = queryResult(rows);
    untrustedResultMock(supabase.from).mockReturnValue(query);
    vi.mocked(markReminderAsCancelled).mockResolvedValue(true);

    const result = await executeBulkReminderCancellation({
      params: { scope: 'elapsed', cutoffAt: '2026-09-05T20:34:12.000Z' },
      user: { id: 'user-1', phone_number: '+573000000001', timezone: 'America/Bogota' },
      language: 'es',
      referenceTime: new Date('2026-09-05T20:40:00.000Z'),
      clarificationResolution: true,
    });

    expect(query.lt).toHaveBeenCalledWith('send_at', '2026-09-05T20:34:12.000Z');
    expect(markReminderAsCancelled).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({
      success: true,
      action: 'cancelled_reminders',
      data: { cancelledCount: 2, remainingCount: 0, scope: 'elapsed' },
    });
    expect(result.formattedCard).toContain('Recordatorios anteriores eliminados');
    expect(result).not.toHaveProperty('pendingClarifications');
  });

  it('bounds tomorrow scope strictly to [tomorrowStart, tomorrowEnd)', async () => {
    const query = queryResult([]);
    untrustedResultMock(supabase.from).mockReturnValue(query);

    // 2026-09-05 in Bogota is UTC-5
    // tomorrow is 2026-09-06: 05:00:00Z to 2026-09-07: 05:00:00Z
    const result = await executeReminderReadTool({
      params: { filter: 'tomorrow', query: 'Alfa' },
      user: { id: 'user-1', phone_number: '+573000000001', timezone: 'America/Bogota' },
      language: 'es',
      referenceTime: new Date('2026-09-05T20:34:12.000Z'),
    });

    expect(result).toMatchObject({ success: true, action: 'listed_reminders' });
    expect(query.eq).toHaveBeenCalledWith('status', 'pending');
    expect(query.gte).toHaveBeenCalledWith('send_at', '2026-09-06T05:00:00.000Z');
    expect(query.lt).toHaveBeenCalledWith('send_at', '2026-09-07T05:00:00.000Z');
    expect(result.data).toMatchObject({ filter: 'tomorrow' });
    expect(query.ilike).toHaveBeenCalledWith('content', '%Alfa%');
  });

  it('bounds dynamic weekday scope (e.g. martes) to that specific local day without hardcoding', async () => {
    const query = queryResult([]);
    untrustedResultMock(supabase.from).mockReturnValue(query);

    // Reference: Saturday 2026-09-05 in Bogota. Next Tuesday is 2026-09-08
    const result = await executeReminderReadTool({
      params: { scope: 'martes' },
      user: { id: 'user-1', phone_number: '+573000000001', timezone: 'America/Bogota' },
      language: 'es',
      referenceTime: new Date('2026-09-05T20:34:12.000Z'),
    });

    expect(result).toMatchObject({ success: true, action: 'listed_reminders' });
    expect(query.eq).toHaveBeenCalledWith('status', 'pending');
    expect(query.gte).toHaveBeenCalledWith('send_at', '2026-09-08T05:00:00.000Z');
    expect(query.lt).toHaveBeenCalledWith('send_at', '2026-09-09T05:00:00.000Z');
  });

  it('bounds this_week and explicit_date scopes dynamically', async () => {
    const query = queryResult([]);
    untrustedResultMock(supabase.from).mockReturnValue(query);

    // Reference: Saturday 2026-09-05 in Bogota. This week is Mon 2026-08-31 to Mon 2026-09-07
    const resultWeek = await executeReminderReadTool({
      params: { filter: 'this_week' },
      user: { id: 'user-1', phone_number: '+573000000001', timezone: 'America/Bogota' },
      language: 'es',
      referenceTime: new Date('2026-09-05T20:34:12.000Z'),
    });

    expect(resultWeek.success).toBe(true);
    expect(query.gte).toHaveBeenCalledWith('send_at', '2026-08-31T05:00:00.000Z');
    expect(query.lt).toHaveBeenCalledWith('send_at', '2026-09-07T05:00:00.000Z');

    // Explicit date: 2026-10-09
    const queryDate = queryResult([]);
    untrustedResultMock(supabase.from).mockReturnValue(queryDate);
    const resultDate = await executeReminderReadTool({
      params: { scope: '2026-10-09' },
      user: { id: 'user-1', phone_number: '+573000000001', timezone: 'America/Bogota' },
      language: 'es',
      referenceTime: new Date('2026-09-05T20:34:12.000Z'),
    });

    expect(resultDate.success).toBe(true);
    expect(queryDate.gte).toHaveBeenCalledWith('send_at', '2026-10-09T05:00:00.000Z');
    expect(queryDate.lt).toHaveBeenCalledWith('send_at', '2026-10-10T05:00:00.000Z');
  });
});
