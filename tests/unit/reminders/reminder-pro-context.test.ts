import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveReminderProUpgradeContext, selectReminderProProvider } from '../../../src/agent/tools/reminder-pro.js';
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });
describe('Stripe-only host upgrade context', () => {
  it.each(['', 'stripe', 'STRIPE', 'mercadopago', 'lemonsqueezy', 'unsupported'])('ignores obsolete provider selection %s without remote requests', async config => {
    vi.stubEnv('BILLING_PROVIDER', config); vi.stubEnv('STRIPE_CHECKOUT_URL', 'https://buy.stripe.com/synthetic'); const fetch = vi.spyOn(globalThis, 'fetch');
    for (const phone of ['+573000000001', '+13000000001', '', 'CO.synthetic']) {
      expect(selectReminderProProvider(phone, config)).toBe('Stripe'); const result = await resolveReminderProUpgradeContext(phone, 'en', { userId: 'owner' }); expect(result.provider).toBe('Stripe'); expect(new URL(result.checkoutUrl).searchParams.get('client_reference_id')).toBe('owner'); expect(new URL(result.checkoutUrl).searchParams.get('locale')).toBe('en'); expect(result.shortCheckoutUrl).toContain('/pay?ref=owner');
    }
    expect(fetch).not.toHaveBeenCalled();
  });
});
