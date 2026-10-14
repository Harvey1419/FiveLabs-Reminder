import { describe, expect, it, vi } from 'vitest';
import { createReminderProContext, selectReminderProProvider } from '../../../src/agent/tools/reminder-pro-context.js';
describe('Stripe-only upgrade context', () => {
  it.each([null, '', '+573000000001', '+13000000001', 'CO.synthetic'])('selects Stripe for %s regardless of obsolete configuration', phone => {
    for (const config of ['', 'stripe', 'STRIPE', 'mercadopago', 'lemonsqueezy', 'unsupported']) expect(selectReminderProProvider(phone, config)).toBe('Stripe');
  });
  it('constructs without effects and builds only local Stripe URLs with current identity and language', async () => {
    const deps = { buildStripeCheckoutUrl: vi.fn(() => 'https://buy.stripe.com/synthetic'), getShortStripeCheckoutUrl: vi.fn(() => 'https://app.example.test/pay?ref=owner') };
    const f = createReminderProContext(deps); expect(deps.buildStripeCheckoutUrl).not.toHaveBeenCalled();
    expect(await f.resolveReminderProUpgradeContext('+57300', 'en', { userId: 'owner', email: 'owner@example.test', country: 'CO' })).toMatchObject({ provider: 'Stripe', amount: 14.99, currency: 'USD', planId: null, ctaButtonText: 'Pay now', fallbackCheckoutUrl: 'https://app.example.test/pay?ref=owner' }); expect(deps.buildStripeCheckoutUrl).toHaveBeenCalledExactlyOnceWith({ userId: 'owner', phoneNumber: '+57300', email: 'owner@example.test', language: 'en' });
  });
  it('falls back to the full Stripe link and propagates URL construction errors without switching providers', async () => {
    const deps = { buildStripeCheckoutUrl: vi.fn(() => 'https://buy.stripe.com/synthetic'), getShortStripeCheckoutUrl: vi.fn(() => '') }; const f = createReminderProContext(deps); expect((await f.resolveReminderProUpgradeContext(null)).fallbackCheckoutUrl).toBe('https://buy.stripe.com/synthetic'); const error = Error('builder failed'); deps.buildStripeCheckoutUrl.mockImplementation(() => { throw error; }); await expect(f.resolveReminderProUpgradeContext('+57')).rejects.toBe(error);
  });
});
