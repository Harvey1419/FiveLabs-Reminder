import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/integrations/mercado-pago/client.js', () => ({
  getOrCreateCanonicalPlan: vi.fn(),
}));

const { getOrCreateCanonicalPlan } = await import('../../../src/integrations/mercado-pago/client.js');
const {
  REMINDER_PRO_FALLBACK,
  resolveReminderProUpgradeContext,
} = await import('../../../src/agent/tools/reminder-pro.js');

describe('Reminder Pro upgrade context', () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
});
