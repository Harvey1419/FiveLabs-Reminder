import { describe, expect, it } from 'vitest';
import { buildStripeCheckoutUrl, getShortStripeCheckoutUrl } from '../../../src/integrations/stripe/client.js';

describe('Billing Redirect Routing', () => {
  it('builds canonical Stripe target destination with embedded client_reference_id from ref param', () => {
    const destination = buildStripeCheckoutUrl({
      userId: '19164158325',
      language: 'es',
    });

    expect(destination).toContain('buy.stripe.com');
    expect(destination).toContain('client_reference_id=19164158325');
    expect(destination).toContain('locale=es');
  });

  it('builds canonical Stripe target destination with embedded UUID client_reference_id', () => {
    const destination = buildStripeCheckoutUrl({
      userId: '607fa68b-59d9-4f76-96b6-3daea0e054cf',
      language: 'en',
    });

    expect(destination).toContain('client_reference_id=607fa68b-59d9-4f76-96b6-3daea0e054cf');
    expect(destination).toContain('locale=en');
  });

  it('generates consistent short vanity URL matching the redirect endpoint', () => {
    const shortUrl = getShortStripeCheckoutUrl({ userId: '19164158325' });
    expect(shortUrl).toBe('https://hermes.templelabs.co/pay?ref=19164158325');
  });
});
