import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import crypto from 'crypto';
import {
  buildStripeCheckoutUrl,
  verifyStripeSignature,
  STRIPE_DEFAULT_CHECKOUT_URL,
} from '../../../src/integrations/stripe/client.js';

describe('Stripe Integration Client', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  describe('buildStripeCheckoutUrl', () => {
    it('uses default payment link when no custom environment URL is set', () => {
      delete process.env.STRIPE_CHECKOUT_URL;
      const url = buildStripeCheckoutUrl();
      expect(url).toContain(STRIPE_DEFAULT_CHECKOUT_URL);
      expect(url).toContain('locale=es');
    });

    it('embeds client_reference_id when userId is provided', () => {
      const url = buildStripeCheckoutUrl({ userId: 'user-abc-123' });
      expect(url).toContain('client_reference_id=user-abc-123');
    });

    it('embeds prefilled_email when email is provided', () => {
      const url = buildStripeCheckoutUrl({ email: 'Juan@Example.com ' });
      expect(url).toContain('prefilled_email=juan%40example.com');
    });

    it('sets locale=en when language is en', () => {
      const url = buildStripeCheckoutUrl({ language: 'en' });
      expect(url).toContain('locale=en');
    });

    it('embeds client_reference_id with phoneNumber when userId is missing', () => {
      const url = buildStripeCheckoutUrl({ phoneNumber: '19164158325' });
      expect(url).toContain('client_reference_id=19164158325');
    });

    it('cleans up dangling client_reference_id when base URL contains empty param and no id or phone is provided', () => {
      process.env.STRIPE_CHECKOUT_URL = 'https://buy.stripe.com/test?client_reference_id=';
      const url = buildStripeCheckoutUrl();
      expect(url).not.toContain('client_reference_id');
      expect(url).toContain('locale=es');
    });
  });

  describe('verifyStripeSignature', () => {
    const testSecret = 'whsec_test_secret_key_12345';

    beforeEach(() => {
      process.env.STRIPE_WEBHOOK_SECRET = testSecret;
    });

    function generateValidSignature(payload, secret = testSecret, timestamp = Math.floor(Date.now() / 1000)) {
      const signedPayload = `${timestamp}.${payload}`;
      const sig = crypto.createHmac('sha256', secret).update(signedPayload, 'utf8').digest('hex');
      return {
        header: `t=${timestamp},v1=${sig}`,
        timestamp,
      };
    }

    it('permits request if STRIPE_WEBHOOK_SECRET is not configured', () => {
      delete process.env.STRIPE_WEBHOOK_SECRET;
      const req = { headers: {} };
      expect(verifyStripeSignature(req)).toBe(true);
    });

    it('rejects request if stripe-signature header is missing', () => {
      const req = { headers: {} };
      expect(verifyStripeSignature(req)).toBe(false);
    });

    it('validates genuine signature with rawBody string', () => {
      const rawBody = JSON.stringify({ type: 'checkout.session.completed', id: 'evt_123' });
      const { header } = generateValidSignature(rawBody);
      const req = {
        headers: { 'stripe-signature': header },
        rawBody,
        body: JSON.parse(rawBody),
      };

      expect(verifyStripeSignature(req)).toBe(true);
    });

    it('validates genuine signature with rawBody Buffer', () => {
      const rawBody = JSON.stringify({ type: 'checkout.session.completed', id: 'evt_123' });
      const { header } = generateValidSignature(rawBody);
      const req = {
        headers: { 'stripe-signature': header },
        rawBody: Buffer.from(rawBody, 'utf8'),
        body: JSON.parse(rawBody),
      };

      expect(verifyStripeSignature(req)).toBe(true);
    });

    it('rejects signature when payload is tampered', () => {
      const rawBody = JSON.stringify({ type: 'checkout.session.completed', id: 'evt_123' });
      const { header } = generateValidSignature(rawBody);
      const req = {
        headers: { 'stripe-signature': header },
        rawBody: JSON.stringify({ type: 'checkout.session.completed', id: 'evt_TAMPERED' }),
      };

      expect(verifyStripeSignature(req)).toBe(false);
    });

    it('rejects signature when timestamp is older than tolerance window', () => {
      const rawBody = JSON.stringify({ type: 'checkout.session.completed' });
      const oldTimestamp = Math.floor(Date.now() / 1000) - 600; // 10 minutes ago
      const { header } = generateValidSignature(rawBody, testSecret, oldTimestamp);
      const req = {
        headers: { 'stripe-signature': header },
        rawBody,
      };

      expect(verifyStripeSignature(req, 300)).toBe(false);
    });

    it('rejects signature signed with wrong secret', () => {
      const rawBody = JSON.stringify({ type: 'checkout.session.completed' });
      const { header } = generateValidSignature(rawBody, 'whsec_wrong_secret');
      const req = {
        headers: { 'stripe-signature': header },
        rawBody,
      };

      expect(verifyStripeSignature(req)).toBe(false);
    });
  });
});
