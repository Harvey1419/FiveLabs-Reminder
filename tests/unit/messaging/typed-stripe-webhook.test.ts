import { describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import { createStripeWebhook } from '../../../src/http/webhooks/stripe-handler.js';
import { KapsoError, KapsoValidationError } from '../../../src/integrations/whatsapp/kapso-errors.js';
import type { BillingClient, BillingQuery, BillingRequest, BillingStorePorts } from '../../../src/http/webhooks/billing-webhook-ports.js';
const NOW = Date.parse('2026-10-13T15:00:00Z');
function fixture(results: { data: unknown; error?: unknown }[] = []) {
  const calls: { method: string; args: unknown[] }[] = [];
  const consume = async () => results.shift() || { data: null, error: null };
  const client = { from: (table: string) => {
    calls.push({ method: 'from', args: [table] }); const query: Record<string, unknown> = {};
    for (const method of ['select', 'eq', 'or', 'order', 'limit', 'update', 'insert']) query[method] = (...args: unknown[]) => { calls.push({ method, args }); return query; };
    query.maybeSingle = consume; query.then = (resolve: (value: unknown) => unknown, reject: (error: unknown) => unknown) => consume().then(resolve, reject); return query as unknown as BillingQuery<never>;
  } } as BillingClient;
  const deps = { getClient: vi.fn(() => client), normalizeUserPhone: vi.fn((value: unknown) => typeof value === 'string' ? value.replace(/\D/g, '') : null), verifySignature: vi.fn(() => true), getNow: () => new Date(NOW), getNowMs: () => NOW, sendWhatsAppText: vi.fn(async () => ({})), sendWhatsAppTemplate: vi.fn(async () => ({})), logger: { log: vi.fn(), warn: vi.fn(), error: vi.fn() } } satisfies BillingStorePorts;
  const res = { status: vi.fn((_code: number) => res), json: vi.fn((_body: unknown) => undefined) };
  return { calls, deps, res, ...createStripeWebhook(deps) };
}
const checkout: BillingRequest = { body: { type: 'checkout.session.completed', data: { object: { id: 'cs_test', subscription: 'sub_test', client_reference_id: 'owner', amount_total: 1499 } } } };
const user = { id: 'owner', phone_number: '573000000001', locale: 'en-US' };
describe('typed Stripe HTTP callback', () => {
  it('has no construction effects and validates before acknowledging or querying', async () => {
    const f = fixture(); expect(f.deps.getClient).not.toHaveBeenCalled(); f.deps.verifySignature.mockReturnValue(false); await f.handleStripeWebhook(checkout, f.res); expect(f.res.status).toHaveBeenCalledWith(401); expect(f.deps.getClient).not.toHaveBeenCalled(); expect(f.deps.sendWhatsAppText).not.toHaveBeenCalled();
  });
  it('keeps checkout lookup/update payload, bilingual welcome and ACK before storage', async () => {
    const f = fixture([{ data: user }, { data: { id: 'stored' } }, { data: null }]); await f.handleStripeWebhook(checkout, f.res); expect(f.res.status).toHaveBeenCalledWith(200); expect(f.res.json).toHaveBeenCalledWith({ received: true }); expect(f.res.json.mock.invocationCallOrder[0]).toBeLessThan(f.deps.getClient.mock.invocationCallOrder[0]!); expect(f.calls).toContainEqual({ method: 'eq', args: ['id', 'owner'] }); expect(f.calls).toContainEqual({ method: 'or', args: ['mp_preapproval_id.eq.sub_test,user_id.eq.owner'] }); expect(f.calls.find(call => call.method === 'update')?.args[0]).toEqual({ mp_preapproval_id: 'sub_test', plan: 'pro', status: 'authorized', amount: 14.99, next_payment_date: new Date(NOW + 2592000000).toISOString(), updated_at: new Date(NOW).toISOString() }); expect(f.deps.sendWhatsAppText).toHaveBeenCalledWith({ phoneNumber: user.phone_number, text: expect.stringContaining('Welcome to Reminder Pro') });
  });
  it('does not welcome after a returned SDK insert/update error', async () => {
    for (const existing of [null, { id: 'stored' }]) {
      const error = { code: 'WRITE_FAILED' }; const f = fixture([{ data: user }, { data: existing }, { data: null, error }]); await f.handleStripeWebhook(checkout, f.res); expect(f.deps.sendWhatsAppText).not.toHaveBeenCalled(); expect(f.deps.sendWhatsAppTemplate).not.toHaveBeenCalled(); expect(f.deps.logger.error).toHaveBeenCalledWith('[stripe-webhook] Error processing event:', error);
    }
  });
  it('does not replay uncertain or unclassified text failures via a template', async () => {
    for (const error of [new KapsoError('uncertain', { code: 'DELIVERY_OUTCOME_UNKNOWN' }), Error('unclassified')]) {
      const f = fixture([{ data: user }, { data: null }, { data: null }]); f.deps.sendWhatsAppText.mockRejectedValue(error); await f.handleStripeWebhook(checkout, f.res); expect(f.deps.sendWhatsAppText).toHaveBeenCalledTimes(1); expect(f.deps.sendWhatsAppTemplate).not.toHaveBeenCalled(); expect(f.deps.logger.error).toHaveBeenCalledWith('[stripe-webhook] Error processing event:', error);
    }
  });
  it('allows exactly one template fallback after an owned explicit format rejection', async () => {
    const f = fixture([{ data: user }, { data: null }, { data: null }]); f.deps.sendWhatsAppText.mockRejectedValue(new KapsoValidationError('window rejected', 400)); f.deps.sendWhatsAppTemplate.mockRejectedValue(Error('template rejected')); await f.handleStripeWebhook(checkout, f.res); expect(f.deps.sendWhatsAppTemplate).toHaveBeenCalledExactlyOnceWith({ phoneNumber: user.phone_number, templateName: 'reminder_task_one_reminder', parameters: ['🎉 Your Reminder Pro subscription is active! You now have unlimited access.'] });
  });
  it('preserves provider ID predicates and period date omissions on lifecycle/invoice events', async () => {
    const f = fixture([{ data: null }, { data: null }, { data: null }]); await f.handleStripeWebhook({ body: { type: 'customer.subscription.updated', data: { object: { id: 'sub_test', status: 'trialing', current_period_end: null } } } }, f.res); await f.handleStripeWebhook({ body: { type: 'invoice.paid', data: { object: { subscription: 'sub_test', lines: { data: [{ period: { end: 1800000000 } }] } } } } }, f.res); await f.handleStripeWebhook({ body: { type: 'customer.subscription.deleted', data: { object: { id: 'sub_test' } } } }, f.res); const updates = f.calls.filter(call => call.method === 'update'); expect(updates[0]!.args[0]).not.toHaveProperty('next_payment_date'); expect(updates[1]!.args[0]).toMatchObject({ next_payment_date: new Date(1800000000000).toISOString(), plan: 'pro' }); expect(updates[2]!.args[0]).toMatchObject({ status: 'cancelled', canceled_at: new Date(NOW).toISOString() }); expect(f.calls.filter(call => call.method === 'eq' && call.args[0] === 'mp_preapproval_id')).toHaveLength(3); expect(f.deps.sendWhatsAppText).not.toHaveBeenCalled();
  });
});

describe('Stripe callback actual Supabase transport', () => {
  it('serializes user/subscription filters and suppresses welcome on a real SDK error response', async () => {
    const { createClient } = createRequire(import.meta.url)('@supabase/supabase-js') as { createClient(url: string, key: string, options: { auth: { persistSession: boolean; autoRefreshToken: boolean }; global: { fetch: typeof fetch } }): unknown };
    const requests: { url: URL; method: string; body: unknown }[] = [];
    const responses = [{ data: [user], status: 200 }, { data: [], status: 200 }, { data: { code: '23514', message: 'synthetic write rejection' }, status: 400 }];
    const sdk = createClient('https://billing.example.test', 'synthetic-key', { auth: { persistSession: false, autoRefreshToken: false }, global: { fetch: async (input, options) => { requests.push({ url: new URL(String(input)), method: options?.method || 'GET', body: options?.body ? JSON.parse(String(options.body)) : null }); const response = responses.shift(); if (!response) throw Error('unexpected request'); return new Response(JSON.stringify(response.data), { status: response.status, headers: { 'content-type': 'application/json' } }); } } });
    const f = fixture(); const handler = createStripeWebhook({ ...f.deps, getClient: () => sdk as BillingClient }); await handler.handleStripeWebhook(checkout, f.res);
    expect(requests).toHaveLength(3); expect(requests[0]!.url.searchParams.get('id')).toBe('eq.owner'); expect(requests[1]!.url.searchParams.get('or')).toBe('(mp_preapproval_id.eq.sub_test,user_id.eq.owner)'); expect(requests[1]!.url.searchParams.get('limit')).toBe('1'); expect(requests[2]!.method).toBe('POST'); expect(requests[2]!.body).toMatchObject({ user_id: 'owner', mp_preapproval_id: 'sub_test', status: 'authorized', amount: 14.99 }); expect(f.deps.sendWhatsAppText).not.toHaveBeenCalled(); expect(f.deps.sendWhatsAppTemplate).not.toHaveBeenCalled(); expect(f.deps.logger.error).toHaveBeenCalledWith('[stripe-webhook] Error processing event:', expect.objectContaining({ code: '23514' }));
  });
});
