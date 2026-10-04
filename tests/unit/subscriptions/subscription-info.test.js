import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('../../../src/infrastructure/database/index.js', () => ({
  cancelUserSubscription: vi.fn(() => { throw new Error('DB forbidden'); }),
  getUserSubscription: vi.fn(() => { throw new Error('DB forbidden'); }),
  createPendingSubscription: vi.fn(() => { throw new Error('DB forbidden'); }),
}));
vi.mock('../../../src/agent/tools/reminder-pro.js', async (original) => ({
  ...await original(),
  resolveReminderProUpgradeContext: vi.fn(() => { throw new Error('checkout forbidden'); }),
}));
import * as db from '../../../src/infrastructure/database/index.js';
import { resolveReminderProUpgradeContext } from '../../../src/agent/tools/reminder-pro.js';
import { executeSubscriptionTool } from '../../../src/agent/tools/subscriptions.js';
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });
describe('public subscription information', () => {
  it.each(['es', 'en'])('returns localized Stripe uncertainty without effects (%s)', async (language) => {
    vi.stubEnv('BILLING_PROVIDER', 'stripe');
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(() => { throw new Error('network forbidden'); });
    const result = await executeSubscriptionTool({ action: 'info', user: { id: 'u', phone_number: '+57300' }, language });
    expect(result).toMatchObject({ success: true, action: 'subscription_info', data: { provider: 'Stripe', paymentMethods: null, price: null, discounts: null } });
    expect(result.formattedCard).toBe(result.data.formattedCard);
    expect(result.formattedCard).toContain(language === 'en' ? 'explicit request' : 'solicitud explícita');
    expect(result.formattedCard).toContain(language === 'en' ? 'cannot confirm' : 'No puedo confirmar');
    expect(result.formattedCard).toContain(language === 'en' ? 'Do not automatically repeat payment' : 'No repitas el pago automáticamente');
    expect(result.formattedCard).toContain(language === 'en' ? 'subscription state' : 'estado de la suscripción');
    expect(result.formattedCard).toContain(language === 'en' ? 'checkout confirmation, any charge' : 'confirmación del checkout, cualquier cargo');
    expect(result.formattedCard).toContain(language === 'en' ? 'avoid duplicate payment' : 'evitar un pago duplicado');
    expect(result.formattedCard).toContain(language === 'en' ? 'I cannot confirm success, failure, a refund or automatic retry behavior' : 'no puedo confirmar éxito, fallo, reembolso ni reintentos automáticos');
    expect(result.formattedCard).toContain(language === 'en' ? 'This information request does not generate a checkout link' : 'Esta consulta no genera un enlace de pago');
    expect(result.formattedCard).not.toContain(language === 'en' ? 'No checkout link has been generated' : 'No se ha generado ningún enlace');
    expect(result.data).toMatchObject({ checkoutConfirmation: null, chargeOutcome: null, paymentOutcome: null, subscriptionStatus: null });
    expect(result.formattedCard).toContain(language === 'en' ? 'Do not retry manually until the outcome is resolved' : 'No reintentes manualmente hasta resolver el resultado');
    expect(result).not.toHaveProperty('ctaUrl');
    expect(result.data).not.toHaveProperty('checkoutUrl');
    expect(fetch).not.toHaveBeenCalled();
    for (const fn of Object.values(db)) expect(fn).not.toHaveBeenCalled();
    expect(resolveReminderProUpgradeContext).not.toHaveBeenCalled();
  });
  it('resolves explicit checkout once and preserves its CTA beside information', async () => {
    vi.clearAllMocks();
    vi.stubEnv('BILLING_PROVIDER', 'stripe');
    resolveReminderProUpgradeContext.mockResolvedValueOnce({ checkoutUrl: 'https://checkout.stripe.com/explicit', amount: 9, currency: 'USD', provider: 'Stripe' });
    const info = await executeSubscriptionTool({ action: 'info', user: { id: 'u' }, language: 'en' });
    const link = await executeSubscriptionTool({ action: 'get_link', user: { id: 'u' }, language: 'en' });
    expect(link.ctaUrl).toBe('https://checkout.stripe.com/explicit');
    expect(resolveReminderProUpgradeContext).toHaveBeenCalledTimes(1);
    expect(info.formattedCard).toContain('This information request does not generate a checkout link');
    expect(info.formattedCard).not.toContain('No checkout link has been generated');
    expect(db.createPendingSubscription).not.toHaveBeenCalled();
    vi.clearAllMocks();
  });
  it('fails closed for unknown configured providers', async () => {
    vi.stubEnv('BILLING_PROVIDER', 'unsupported');
    const result = await executeSubscriptionTool({ action: 'info', user: { phone_number: '+57300' }, language: 'en' });
    expect(result.data.provider).toBeNull();
    expect(result.formattedCard).not.toContain('Stripe');
    expect(result.formattedCard).not.toContain('Mercado Pago');
  });
  it.each([['', '+57300', 'Mercado Pago'], ['', '+1300', 'Lemon Squeezy'], ['lemonsqueezy', '+57300', 'Lemon Squeezy'], ['mercadopago', '+1300', 'Mercado Pago']])('preserves provider fallback (%s, %s)', async (provider, phone_number, expected) => {
    vi.stubEnv('BILLING_PROVIDER', provider);
    const result = await executeSubscriptionTool({ action: 'info', user: { phone_number } });
    expect(result.data.provider).toBe(expected);
  });
});
