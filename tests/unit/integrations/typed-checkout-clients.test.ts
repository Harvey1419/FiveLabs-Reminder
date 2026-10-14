import { createHmac } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { createStripeClient } from '../../../src/integrations/stripe/checkout-client.js';
const NOW = 1800000000000;
function fixture() {
  const env: Record<string, string | undefined> = {};
  const logger = { warn: vi.fn(), error: vi.fn() };
  const deps = { getEnvironment: () => env, now: () => NOW, logger };
  return { env, logger, stripe: createStripeClient(deps) };
}
const sign = (body: string | Buffer) => createHmac('sha256', 'synthetic-secret').update(body).digest('hex');
describe('typed checkout URL clients', () => {
  it('reads current configuration and preserves Stripe reference precedence, locale and email casing', () => {
    const f = fixture(); f.env.STRIPE_CHECKOUT_URL = 'https://checkout.example.test/pay?keep=1&client_reference_id=old';
    const url = new URL(f.stripe.buildStripeCheckoutUrl({ userId: ' ', phoneNumber: ' +57 ', email: ' USER@EXAMPLE.TEST ', language: 'EN-us' }));
    expect(url.searchParams.get('client_reference_id')).toBe('+57'); expect(url.searchParams.get('prefilled_email')).toBe('user@example.test'); expect(url.searchParams.get('locale')).toBe('en'); expect(url.searchParams.get('keep')).toBe('1');
    expect(new URL(f.stripe.buildStripeCheckoutUrl()).searchParams.has('client_reference_id')).toBe(false);
    f.env.STRIPE_CHECKOUT_URL = 'broken'; expect(f.stripe.buildStripeCheckoutUrl()).toBe('broken');
  });
  it('encodes short references and removes only one trailing slash', () => {
    const f = fixture(); f.env.APP_BASE_URL = 'https://app.example.test//';
    expect(f.stripe.getShortStripeCheckoutUrl({ userId: ' a/b ? ' })).toBe('https://app.example.test//pay?ref=a%2Fb%20%3F');
    expect(f.stripe.getShortStripeCheckoutUrl({ baseUrl: 'https://override.example.test/' })).toBe('https://override.example.test/pay');
    expect(() => f.stripe.getShortStripeCheckoutUrl({ baseUrl: 123 })).toThrow(TypeError);
  });
  it('keeps missing-secret sandbox behavior and reacts to secret configuration changes', () => {
    const f = fixture(); expect(f.stripe.verifyStripeSignature({})).toBe(true);
    f.env.STRIPE_WEBHOOK_SECRET = 'synthetic-secret'; expect(f.stripe.verifyStripeSignature({})).toBe(false);
  });
  it('accepts Stripe raw UTF-8 body and multiple v1 candidates at the exact replay boundary', () => {
    const f = fixture(); f.env.STRIPE_WEBHOOK_SECRET = 'synthetic-secret'; const timestamp = NOW / 1000 - 300; const rawBody = Buffer.from('{"title":"mañana"}');
    const req = { headers: { 'stripe-signature': `t=${timestamp},v1=bad,v1=${sign(`${timestamp}.${rawBody.toString('utf8')}`)}` }, rawBody, body: { wrong: true } };
    expect(f.stripe.verifyStripeSignature(req)).toBe(true); expect(f.stripe.verifyStripeSignature(req, 299)).toBe(false); expect(f.logger.warn).toHaveBeenCalledTimes(1);
    expect(f.stripe.verifyStripeSignature({ ...req, rawBody: 'altered' })).toBe(false);
  });
  it('rejects future stale timestamps and malformed Stripe signatures without throwing', () => {
    const f = fixture(); f.env.STRIPE_WEBHOOK_SECRET = 'synthetic-secret'; const timestamp = NOW / 1000 + 301;
    expect(f.stripe.verifyStripeSignature({ headers: { 'stripe-signature': `t=${timestamp},v1=${sign(`${timestamp}.{}`)}` }, body: {} })).toBe(false);
    for (const header of ['t=0,v1=x', 't=NaN,v1=x', 't=1,v1=', 'v1=x']) expect(f.stripe.verifyStripeSignature({ headers: { 'stripe-signature': header } })).toBe(false);
  });
});
