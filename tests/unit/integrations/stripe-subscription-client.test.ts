import { describe, expect, it, vi } from 'vitest';
import { createStripeSubscriptionClient } from '../../../src/integrations/stripe/subscription-client.js';
function fixture(responses: (Response | Error)[] = []) {
  const env: Record<string, string | undefined> = { STRIPE_SECRET_KEY: 'sk_test_synthetic' }; const deps = { getEnvironment: () => env, fetch: vi.fn<typeof fetch>(async () => { const response = responses.shift(); if (response instanceof Error) throw response; if (!response) throw Error('unexpected request'); return response; }), assertTurnLease: vi.fn(async () => {}), currentTurnSignal: (): AbortSignal | undefined => undefined };
  return { env, deps, ...createStripeSubscriptionClient(deps) };
}
describe('Stripe-only confirmed cancellation', () => {
  it('uses the current server key and returns the exact confirmed subscription object', async () => {
    const f = fixture([new Response(JSON.stringify({ id: 'sub_test', status: 'canceled', extra: 'retain' }))]); f.env.STRIPE_SECRET_KEY = 'changed'; expect(await f.cancelStripeSubscription('sub_test')).toEqual({ id: 'sub_test', status: 'canceled', extra: 'retain' }); expect(f.deps.fetch).toHaveBeenCalledExactlyOnceWith('https://api.stripe.com/v1/subscriptions/sub_test', expect.objectContaining({ method: 'DELETE', headers: { Authorization: `Basic ${Buffer.from('changed:').toString('base64')}` } }));
  });
  it('performs no request for missing keys or legacy/malformed subscription identities', async () => {
    const f = fixture(); for (const id of [null, '', 'legacy-provider', 'ls_123', 'stripe_cs_123', 'sub_../unsafe']) await expect(f.cancelStripeSubscription(id)).rejects.toThrow('Unsupported Stripe subscription identity'); delete f.env.STRIPE_SECRET_KEY; await expect(f.cancelStripeSubscription('sub_test')).rejects.toThrow('STRIPE_SECRET_KEY'); expect(f.deps.fetch).not.toHaveBeenCalled();
  });
  it.each([{ id: 'other', status: 'canceled' }, { id: 'sub_test', status: 'active' }, null])('does not confirm mismatched or incomplete responses', async value => {
    const f = fixture([new Response(JSON.stringify(value))]); await expect(f.cancelStripeSubscription('sub_test')).rejects.toThrow('could not be confirmed'); expect(f.deps.fetch).toHaveBeenCalledTimes(1);
  });
  it('propagates transport/parse/HTTP rejection without replay and respects the lease', async () => {
    const error = Error('uncertain transport'); const f = fixture([error, new Response('bad JSON'), new Response('{}', { status: 403 })]); await expect(f.cancelStripeSubscription('sub_test')).rejects.toBe(error); await expect(f.cancelStripeSubscription('sub_test')).rejects.toThrow(SyntaxError); await expect(f.cancelStripeSubscription('sub_test')).rejects.toThrow('HTTP 403'); expect(f.deps.fetch).toHaveBeenCalledTimes(3); f.deps.assertTurnLease.mockRejectedValue(error); await expect(f.cancelStripeSubscription('sub_test')).rejects.toBe(error); expect(f.deps.fetch).toHaveBeenCalledTimes(3);
  });
});
