import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import type { SubscriptionPersistenceClient } from '../../../src/infrastructure/database/subscription-persistence.js';
// Load the real SDK through a narrow runtime boundary without importing its conflicting WebAuthn declarations.
const { createClient } = createRequire(import.meta.url)('@supabase/supabase-js') as {
  createClient(url: string, key: string, options: { auth: { persistSession: boolean; autoRefreshToken: boolean }; global: { fetch: typeof fetch } }): unknown;
};
import { createSubscriptionPersistence } from '../../../dist/runtime/infrastructure/database/subscription-persistence.js';
const NOW = Date.parse('2026-10-13T12:00:00Z');
const row = { id: 'subscription-id', user_id: 'owner', mp_preapproval_id: 'mp-id', plan: 'pro', status: 'authorized' };

describe('actual Supabase subscription query boundary', () => {
  it('executes the actual Supabase select and update builders through a synthetic fetch', async () => {
    const requests: { url: URL; method: string; body: unknown }[] = [];
    const sdk = createClient('https://subscription.example.test', 'synthetic-key', { auth: { persistSession: false, autoRefreshToken: false }, global: { fetch: async (input, init) => { const method = init?.method || 'GET'; requests.push({ url: new URL(String(input)), method, body: init?.body ? JSON.parse(String(init.body)) : null }); return new Response(JSON.stringify(method === 'GET' ? [row] : row), { status: 200, headers: { 'content-type': 'application/json' } }); } } });
    const store = createSubscriptionPersistence({ getClient: () => sdk as SubscriptionPersistenceClient, cancelSubscription: async () => ({}), now: () => new Date(NOW), logger: { log: () => {}, warn: () => {}, error: () => {} } });
    expect(await store.getUserSubscription('owner')).toEqual(row); expect(requests[0]?.url.searchParams.get('user_id')).toBe('eq.owner'); expect(requests[0]?.url.searchParams.get('limit')).toBe('1');
    await store.updateSubscriptionFromWebhook({ mpPreapprovalId: 'mp-id', status: 'authorized' }); expect(requests[1]?.method).toBe('PATCH'); expect(requests[1]?.url.searchParams.get('mp_preapproval_id')).toBe('eq.mp-id'); expect(requests[1]?.body).toMatchObject({ status: 'authorized', plan: 'pro' });
  });
});
