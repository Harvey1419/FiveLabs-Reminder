import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('../../../src/infrastructure/database/index.js', async () => ({
  cancelUserSubscription: vi.fn(() => { throw new Error('DB forbidden'); }),
  getUserSubscription: vi.fn(() => { throw new Error('DB forbidden'); }),
  hasProAccess: (await import('../../../src/infrastructure/database/subscriptions.js')).hasProAccess,
  createPendingSubscription: vi.fn(() => { throw new Error('DB forbidden'); }),
}));
vi.mock('../../../src/agent/tools/reminder-pro.js', async (original) => ({
  ...await original(),
  resolveReminderProUpgradeContext: vi.fn(() => { throw new Error('checkout forbidden'); }),
}));
import * as db from '../../../src/infrastructure/database/index.js';
import { resolveReminderProUpgradeContext } from '../../../src/agent/tools/reminder-pro.js';
import { executeSubscriptionTool } from '../../../src/agent/tools/subscriptions.js';
import { createExecutionFact } from '../../../src/agent/core/execution-facts.js';
import * as stripe from '../../../src/integrations/stripe/client.js';
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });
describe('checkout entitlement', () => {
  const future = () => new Date(Date.now() + 86400000).toISOString();
  const past = () => new Date(Date.now() - 3 * 86400000).toISOString();
  it.each([
    ['active', { plan: 'pro', status: 'active' }, false],
    ['authorized', { plan: 'pro', status: 'authorized' }, false],
    ['admin', null, true],
    ['paid cancelled', { plan: 'pro', status: 'cancelled', next_payment_date: future() }, false],
    ['paid paused', { plan: 'pro', status: 'paused', next_payment_date: future() }, false],
  ])('returns localized already-Pro without resolving checkout for %s', async (_name, subscription, is_admin) => {
    vi.clearAllMocks();
    db.getUserSubscription.mockResolvedValueOnce(subscription);
    for (const language of ['es', 'en']) {
      const user = { id: 'u', phone_number: '573001112233', is_admin };
      if (language === 'en') user.subscription = subscription;
      const result = await executeSubscriptionTool({ action: 'get_link', user, language });
      expect(result).toMatchObject({ success: true, action: 'subscription_already_pro' });
      expect(result.data.hasProAccess).toBe(true);
      expect(result.data.benefits).toHaveLength(2);
      expect(result).not.toHaveProperty('formattedCard');
      expect(result).not.toHaveProperty('ctaUrl');
      expect(result.data).not.toHaveProperty('checkoutUrl');
      expect(result.data).not.toHaveProperty('checkout_url');
    }
    expect(resolveReminderProUpgradeContext).not.toHaveBeenCalled();
    expect(db.createPendingSubscription).not.toHaveBeenCalled();
    expect(db.getUserSubscription).toHaveBeenCalledWith('u');
    vi.clearAllMocks();
  });
  it.each(['cancelled', 'paused', 'active'])('allows checkout after %s entitlement expires', async status => {
    vi.clearAllMocks();
    const subscription = { plan: 'pro', status, next_payment_date: past() };
    resolveReminderProUpgradeContext.mockResolvedValueOnce({ checkoutUrl: 'https://checkout.stripe.com/expired', amount: 9, currency: 'USD', provider: 'Stripe' });
    const result = await executeSubscriptionTool({ action: 'get_link', user: { id: 'u', subscription } });
    expect(result.action).toBe('subscription_link_generated');
    expect(result.ctaUrl).toBe('https://checkout.stripe.com/expired');
    expect(resolveReminderProUpgradeContext).toHaveBeenCalledTimes(1);
    expect(db.getUserSubscription).not.toHaveBeenCalled();
    vi.clearAllMocks();
  });
});

describe('plan information entitlement and pure CTA', () => {
  it.each(['es', 'en'])('reuses hydrated Free state and personalizes existing Stripe URL (%s)', async language => {
    vi.clearAllMocks();
    vi.stubEnv('BILLING_PROVIDER', 'stripe');
    vi.stubEnv('STRIPE_CHECKOUT_URL', 'https://buy.stripe.com/test');
    const user = { id: 'free-info', subscription: null, phone_number: '+57300' };
    for (let i = 0; i < 3; i++) {
      const result = await executeSubscriptionTool({ action: 'info', params: { scope: 'plan' }, user, language });
      const url = new URL(result.ctaUrl);
      expect(url.searchParams.get('client_reference_id')).toBe(user.id);
      expect(url.searchParams.get('locale')).toBe(language);
      expect(result.ctaButtonText).toBe(language === 'en' ? 'Subscribe to Pro' : 'Suscribirse a Pro');
      expect(result.data).toMatchObject({ hasProAccess: false, price: null, paymentMethods: null });
    }
    expect(db.getUserSubscription).not.toHaveBeenCalled();
    expect(db.createPendingSubscription).not.toHaveBeenCalled();
    expect(resolveReminderProUpgradeContext).not.toHaveBeenCalled();
  });
  it.each(['info', 'get_link'])('never builds URLs for current Pro (%s)', async action => {
    vi.clearAllMocks();
    vi.stubEnv('BILLING_PROVIDER', 'stripe');
    const builder = vi.spyOn(stripe, 'buildStripeCheckoutUrl');
    const result = await executeSubscriptionTool({ action, params: { scope: 'plan' }, user: { id: 'pro', subscription: { plan: 'pro', status: 'active' } } });
    expect(result.data.hasProAccess).toBe(true);
    expect(result.data.benefits).toHaveLength(2);
    expect(result).not.toHaveProperty('ctaUrl');
    expect(builder).not.toHaveBeenCalled();
    expect(resolveReminderProUpgradeContext).not.toHaveBeenCalled();
  });
  it('fails closed on entitlement lookup failure, ignoring arbitrary isPro', async () => {
    vi.clearAllMocks();
    db.getUserSubscription.mockRejectedValueOnce(new Error('lookup failed'));
    const result = await executeSubscriptionTool({ action: 'info', params: { scope: 'plan' }, user: { id: 'u', isPro: true } });
    expect(result).toMatchObject({ success: false, errorCode: 'SUBSCRIPTION_ENTITLEMENT_ERROR' });
    expect(result).not.toHaveProperty('ctaUrl');
    expect(result.rawSummary).not.toContain('Ya tienes');
  });
  it.each(['mercadopago', 'lemonsqueezy', 'unsupported'])('does not force Stripe or resolve other providers (%s)', async provider => {
    vi.clearAllMocks();
    vi.stubEnv('BILLING_PROVIDER', provider);
    const result = await executeSubscriptionTool({ action: 'info', params: { scope: 'plan' }, user: { id: 'u', subscription: null } });
    expect(result).not.toHaveProperty('ctaUrl');
    expect(resolveReminderProUpgradeContext).not.toHaveBeenCalled();
    expect(db.createPendingSubscription).not.toHaveBeenCalled();
  });
});

describe('public subscription information', () => {
  it.each(['es', 'en'])('returns brief grounded localized info without effects (%s)', async (language) => {
    vi.stubEnv('BILLING_PROVIDER', 'stripe');
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(() => { throw new Error('network forbidden'); });
    const result = await executeSubscriptionTool({ action: 'info', user: { id: 'u', phone_number: '+57300' }, language });
    expect(result).toMatchObject({ success: true, action: 'subscription_info', data: { provider: 'Stripe', paymentMethods: null, price: null, discounts: null } });
    expect(result).not.toHaveProperty('formattedCard');
    const fact = createExecutionFact({ toolName: 'manage_subscription', params: { action: 'info' }, result, language });
    expect(fact.card).toContain(language === 'en' ? 'Do not retry manually' : 'No reintentes manualmente');
    expect(fact.card).not.toMatch(/https?:|Subscribe|Suscribirse/);
    expect(result.data).toMatchObject({ checkoutConfirmation: null, chargeOutcome: null, paymentOutcome: null, subscriptionStatus: null });
    expect(result).not.toHaveProperty('ctaUrl');
    expect(result.data).not.toHaveProperty('checkoutUrl');
    expect(fetch).not.toHaveBeenCalled();
    for (const fn of [db.getUserSubscription, db.cancelUserSubscription, db.createPendingSubscription]) expect(fn).not.toHaveBeenCalled();
    expect(resolveReminderProUpgradeContext).not.toHaveBeenCalled();
  });
  it('resolves explicit checkout once and preserves its CTA beside information', async () => {
    vi.clearAllMocks();
    vi.stubEnv('BILLING_PROVIDER', 'stripe');
    resolveReminderProUpgradeContext.mockResolvedValueOnce({ checkoutUrl: 'https://checkout.stripe.com/explicit', amount: 9, currency: 'USD', provider: 'Stripe' });
    const info = await executeSubscriptionTool({ action: 'info', user: { id: 'u' }, language: 'en' });
    db.getUserSubscription.mockResolvedValueOnce(null);
    const link = await executeSubscriptionTool({ action: 'get_link', user: { id: 'u' }, language: 'en' });
    expect(link.ctaUrl).toBe('https://checkout.stripe.com/explicit');
    expect(resolveReminderProUpgradeContext).toHaveBeenCalledTimes(1);
    expect(info).not.toHaveProperty('ctaUrl');
    expect(info).not.toHaveProperty('formattedCard');
    expect(db.createPendingSubscription).not.toHaveBeenCalled();
    vi.clearAllMocks();
  });
  it('fails closed for unknown configured providers', async () => {
    vi.stubEnv('BILLING_PROVIDER', 'unsupported');
    const result = await executeSubscriptionTool({ action: 'info', user: { phone_number: '+57300' }, language: 'en' });
    expect(result.data.provider).toBeNull();
    expect(result).not.toHaveProperty('ctaUrl');
  });
  it.each([['', '+57300', 'Mercado Pago'], ['', '+1300', 'Lemon Squeezy'], ['lemonsqueezy', '+57300', 'Lemon Squeezy'], ['mercadopago', '+1300', 'Mercado Pago']])('preserves provider fallback (%s, %s)', async (provider, phone_number, expected) => {
    vi.stubEnv('BILLING_PROVIDER', provider);
    const result = await executeSubscriptionTool({ action: 'info', user: { phone_number } });
    expect(result.data.provider).toBe(expected);
  });
});
