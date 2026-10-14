import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { createReminderDeliveryPersistence } from '../../../src/infrastructure/database/reminder-delivery-persistence.js';
import { createReminderOverview } from '../../../src/infrastructure/database/reminder-overview.js';
import type { ReminderClient, ReminderDependencies } from '../../../src/infrastructure/database/reminder-persistence-client.js';
// Execute real SDK query serialization without importing its conflicting WebAuthn declarations.
const { createClient } = createRequire(import.meta.url)('@supabase/supabase-js') as {
  createClient(url: string, key: string, options: { auth: { persistSession: boolean; autoRefreshToken: boolean }; global: { fetch: typeof fetch } }): unknown;
};
const NOW = Date.parse('2026-10-13T15:00:00Z');
const row = { id: '11111111-1111-4111-8111-111111111111', content: 'Reminder', status: 'processing', send_at: new Date(NOW).toISOString() };
function boundary(responses: { value: unknown; status?: number }[]) {
  const requests: { url: URL; method: string; body: unknown }[] = [];
  const sdk = createClient('https://db.example.test', 'synthetic-key', { auth: { persistSession: false, autoRefreshToken: false }, global: { fetch: async (input, init) => {
    requests.push({ url: new URL(String(input)), method: init?.method || 'GET', body: init?.body ? JSON.parse(String(init.body)) : null }); const next = responses.shift(); if (!next) throw Error('unexpected SDK request'); return new Response(JSON.stringify(next.value), { status: next.status || 200, headers: { 'content-type': 'application/json' } });
  } } });
  const deps: ReminderDependencies = { getClient: () => sdk as ReminderClient, getNow: () => new Date(NOW), getNowMs: () => NOW, assertTurnLease: async () => {}, isStrictUUID: () => true, formatLocalDateTime: date => date.toISOString(), logger: { log: () => {}, warn: () => {}, error: () => {} } };
  return { requests, ...createReminderDeliveryPersistence(deps), ...createReminderOverview(deps) };
}
describe('actual Supabase reminder query boundary', () => {
  it('serializes RPC failure then bounded selection and conditional expired-lease claim', async () => {
    const f = boundary([{ value: { code: 'PGRST202', message: 'function unavailable' }, status: 404 }, { value: [row] }, { value: [row] }]); expect(await f.claimNextDueReminder('worker', 120)).toEqual(row); expect(f.requests).toHaveLength(3);
    expect(f.requests[0]?.url.pathname).toBe('/rest/v1/rpc/claim_next_pending_reminder'); expect(f.requests[0]?.body).toEqual({ p_worker_id: 'worker', p_lock_duration_sec: 120 });
    expect(f.requests[1]?.url.searchParams.get('limit')).toBe('10'); expect(f.requests[1]?.url.searchParams.get('send_at')).toBe(`lte.${new Date(NOW).toISOString()}`); expect(f.requests[1]?.url.searchParams.get('or')).toContain('status.eq.processing');
    expect(f.requests[2]?.method).toBe('PATCH'); expect(f.requests[2]?.url.searchParams.get('id')).toBe(`eq.${row.id}`); expect(f.requests[2]?.url.searchParams.get('status')).toBe('eq.processing'); expect(f.requests[2]?.url.searchParams.get('lock_until')).toBe(`lte.${new Date(NOW).toISOString()}`); expect(f.requests[2]?.body).toMatchObject({ claimed_by: 'worker', status: 'processing', lock_until: new Date(NOW + 120000).toISOString() });
  });
  it('issues only the phone-scoped reminder read for phone-only agenda requests', async () => {
    const f = boundary([{ value: [{ ...row, status: 'pending' }] }]); const result = await f.getDailyOverview({ phoneNumber: '+57300' }); expect(result.tasksDueToday).toEqual([]); expect(f.requests).toHaveLength(1); expect(f.requests[0]?.url.pathname).toBe('/rest/v1/reminders'); expect(f.requests[0]?.url.searchParams.get('phone_number')).toBe('eq.+57300');
  });
});
