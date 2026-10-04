import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/integrations/mercado-pago/client.js', () => ({
  getOrCreateCanonicalPlan: vi.fn(),
}));

const { getOrCreateCanonicalPlan } = await import('../../../src/integrations/mercado-pago/client.js');
const {
  REMINDER_PRO_FALLBACK,
  selectReminderProProvider,
  resolveReminderProUpgradeContext,
} = await import('../../../src/agent/tools/reminder-pro.js');

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('Pure Reminder Pro provider selection', () => {
  it.each([
    ['stripe', '+573000000001', 'Stripe'],
    ['STRIPE', '19164158325', 'Stripe'],
    ['lemonsqueezy', '+573000000001', 'Lemon Squeezy'],
    ['mercadopago', '19164158325', 'Mercado Pago'],
    ['', '+573000000001', 'Mercado Pago'],
    ['test', 'CO.synthetic', 'Mercado Pago'],
    ['test', '19164158325', 'Lemon Squeezy'],
    ['', '', 'Mercado Pago'],
  ])('selects %s for %s without checkout side effects', (billingProvider, phoneNumber, expected) => {
    vi.clearAllMocks();
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Unexpected network call'));
    expect(selectReminderProProvider(phoneNumber, billingProvider)).toBe(expected);
    expect(getOrCreateCanonicalPlan).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('Reminder Pro upgrade context', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv('BILLING_PROVIDER', '');
  });

  it('uses the canonical plan metadata and provider checkout url', async () => {
    getOrCreateCanonicalPlan.mockResolvedValue({
      init_point: 'https://checkout.example/pro',
      amount: 59900,
      currency: 'COP',
    });

    const context = await resolveReminderProUpgradeContext('+573000000001', 'es');

    expect(getOrCreateCanonicalPlan).toHaveBeenCalledWith({
      reason: REMINDER_PRO_FALLBACK.reason,
      amount: REMINDER_PRO_FALLBACK.price,
      currency: REMINDER_PRO_FALLBACK.currency,
      phoneNumber: '+573000000001',
    });
    expect(context).toMatchObject({
      checkoutUrl: 'https://checkout.example/pro',
      amount: 59900,
      currency: 'COP',
      ctaButtonText: 'Pagar ahora',
    });
  });

  it('falls back safely when checkout resolution fails', async () => {
    getOrCreateCanonicalPlan.mockRejectedValue(new Error('provider unavailable'));

    const context = await resolveReminderProUpgradeContext('+573000000001', 'en');

    expect(context).toMatchObject({
      checkoutUrl: null,
      amount: REMINDER_PRO_FALLBACK.price,
      currency: REMINDER_PRO_FALLBACK.currency,
      fallbackCheckoutUrl: REMINDER_PRO_FALLBACK.fallbackCheckoutUrl,
      ctaButtonText: 'Pay now',
    });
  });

  it('routes international phone numbers directly to Lemon Squeezy checkout', async () => {
    const context = await resolveReminderProUpgradeContext('19164158325', 'en');

    expect(context).toMatchObject({
      amount: 9.99,
      currency: 'USD',
      ctaButtonText: 'Pay now',
    });
    expect(context.checkoutUrl).toContain('lemonsqueezy.com');
    expect(context.checkoutUrl).toContain('checkout%5Bcustom%5D%5Bphone%5D=19164158325');
  });

  it('prefills Colombian country in Lemon Squeezy checkout when timezone is Bogota', async () => {
    const context = await resolveReminderProUpgradeContext('19164158325', 'es', { timezone: 'America/Bogota' });
    expect(context.checkoutUrl).toContain('checkout%5Bbilling_address%5D%5Bcountry%5D=CO');
  });

  it('routes to Stripe checkout when BILLING_PROVIDER=stripe for both domestic and international', async () => {
    vi.stubEnv('BILLING_PROVIDER', 'stripe');
    vi.stubEnv('STRIPE_CHECKOUT_URL', 'https://buy.stripe.com/8x2dR9dZsez51usg3A73G03');

    const colContext = await resolveReminderProUpgradeContext('+573001234567', 'es', { userId: 'user-col-1' });
    expect(colContext).toMatchObject({
      amount: 14.99,
      currency: 'USD',
      provider: 'Stripe',
      ctaButtonText: 'Pagar ahora',
    });
    expect(colContext.checkoutUrl).toContain('buy.stripe.com/8x2dR9dZsez51usg3A73G03');
    expect(colContext.checkoutUrl).toContain('client_reference_id=user-col-1');
    expect(colContext.checkoutUrl).toContain('locale=es');
    expect(colContext.shortCheckoutUrl).toBe('https://hermes.templelabs.co/pay?ref=user-col-1');

    const intlContext = await resolveReminderProUpgradeContext('19164158325', 'en', { userId: 'user-intl-1' });
    expect(intlContext).toMatchObject({
      amount: 14.99,
      currency: 'USD',
      provider: 'Stripe',
      ctaButtonText: 'Pay now',
    });
    expect(intlContext.checkoutUrl).toContain('locale=en');
  });
});
