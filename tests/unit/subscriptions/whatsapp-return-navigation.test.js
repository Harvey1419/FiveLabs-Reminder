import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  getWhatsAppReturnUrl,
  renderGoogleSuccessPage,
  renderSubscriptionSuccessPage,
  DEFAULT_HERMES_PHONE,
} from '../../../src/http/views/landing.js';
import { buildLemonSqueezyCheckoutUrl } from '../../../src/integrations/lemon-squeezy/client.js';

describe('WhatsApp Return Navigation (Clean direct link without prefilled message)', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    delete process.env.HERMES_WHATSAPP_URL;
    delete process.env.HERMES_PHONE_NUMBER;
    delete process.env.APP_BASE_URL;
    delete process.env.LEMON_SQUEEZY_REDIRECT_URL;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  describe('getWhatsAppReturnUrl', () => {
    it('returns canonical wa.me link with DEFAULT_HERMES_PHONE by default', () => {
      const url = getWhatsAppReturnUrl();
      expect(url).toBe(`https://wa.me/${DEFAULT_HERMES_PHONE}`);
      expect(url).not.toContain('text=');
    });

    it('cleans non-digit characters from HERMES_PHONE_NUMBER', () => {
      process.env.HERMES_PHONE_NUMBER = '+1 (208) 441-6502';
      const url = getWhatsAppReturnUrl();
      expect(url).toBe('https://wa.me/12084416502');
    });

    it('prioritizes explicit HERMES_WHATSAPP_URL when provided', () => {
      process.env.HERMES_WHATSAPP_URL = 'https://wa.me/custom_bot';
      process.env.HERMES_PHONE_NUMBER = '+1 208 441 6502';
      const url = getWhatsAppReturnUrl();
      expect(url).toBe('https://wa.me/custom_bot');
    });
  });

  describe('Google Calendar Sync Return Button', () => {
    it('renders clean WhatsApp return link in obsidian theme without prefilled text', () => {
      const html = renderGoogleSuccessPage({ email: 'user@example.com', theme: 'obsidian' });
      expect(html).toContain(`href="${getWhatsAppReturnUrl()}"`);
      expect(html).toContain('Volver a WhatsApp');
      expect(html).not.toContain('wa.link/iekvou');
      expect(html).not.toContain('text=');
    });

    it('renders clean WhatsApp return link in legacy theme without prefilled text', () => {
      const html = renderGoogleSuccessPage({ email: 'user@example.com', theme: 'legacy' });
      expect(html).toContain(`href="${getWhatsAppReturnUrl()}"`);
      expect(html).toContain('Volver a WhatsApp');
      expect(html).not.toContain('wa.link/iekvou');
      expect(html).not.toContain('text=');
    });
  });

  describe('Subscription Success Return Button', () => {
    it('renders clean WhatsApp return link in obsidian theme without prefilled text', () => {
      const html = renderSubscriptionSuccessPage({ theme: 'obsidian' });
      expect(html).toContain(`href="${getWhatsAppReturnUrl()}"`);
      expect(html).toContain('Volver a WhatsApp');
      expect(html).not.toContain('wa.link/iekvou');
      expect(html).not.toContain('text=');
    });

    it('renders clean WhatsApp return link in legacy theme without prefilled text', () => {
      const html = renderSubscriptionSuccessPage({ theme: 'legacy' });
      expect(html).toContain(`href="${getWhatsAppReturnUrl()}"`);
      expect(html).toContain('Volver a WhatsApp');
      expect(html).not.toContain('wa.link/iekvou');
      expect(html).not.toContain('text=');
    });
  });

  describe('Lemon Squeezy Checkout Redirect URL', () => {
    it('attaches default subscription callback redirect URL to checkout link', () => {
      const checkoutUrl = buildLemonSqueezyCheckoutUrl({
        userId: 'test-user-id',
        phoneNumber: '573001234567',
      });
      const parsed = new URL(checkoutUrl);
      expect(parsed.searchParams.get('checkout[product_options][redirect_url]')).toBe(
        'https://hermes.templelabs.co/subscription/callback'
      );
    });

    it('uses APP_BASE_URL when available for redirect_url', () => {
      process.env.APP_BASE_URL = 'https://custom-app.com';
      const checkoutUrl = buildLemonSqueezyCheckoutUrl({
        userId: 'test-user-id',
      });
      const parsed = new URL(checkoutUrl);
      expect(parsed.searchParams.get('checkout[product_options][redirect_url]')).toBe(
        'https://custom-app.com/subscription/callback'
      );
    });

    it('supports custom redirectUrl parameter', () => {
      const checkoutUrl = buildLemonSqueezyCheckoutUrl({
        userId: 'test-user-id',
        redirectUrl: 'https://override.com/done',
      });
      const parsed = new URL(checkoutUrl);
      expect(parsed.searchParams.get('checkout[product_options][redirect_url]')).toBe(
        'https://override.com/done'
      );
    });
  });
});
