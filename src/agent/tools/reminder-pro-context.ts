export const REMINDER_PRO_FALLBACK = Object.freeze({
  price: 14.99, currency: 'USD', reason: 'Hermes TempleLabs Pro',
  fallbackCheckoutUrl: 'https://hermes.templelabs.co/pay', ctaHeader: '💎 Reminder Pro',
});
/** Stripe is the only supported provider, regardless of retired configuration or phone country. */
export function selectReminderProProvider(_phoneNumber?: unknown, _billingProvider?: string): 'Stripe' { return 'Stripe'; }
export interface ReminderProContextOptions { userId?: unknown; timezone?: unknown; country?: unknown; email?: unknown }
export interface ReminderProContext {
  checkoutUrl: string; shortCheckoutUrl: string; amount: number; currency: string;
  ctaHeader: string; ctaButtonText: string; fallbackCheckoutUrl: string; provider: 'Stripe'; planId: null;
}
export interface ReminderProDependencies {
  buildStripeCheckoutUrl(input: { userId: unknown; phoneNumber: unknown; email: unknown; language: string }): string;
  getShortStripeCheckoutUrl(input: { userId: unknown; phoneNumber: unknown }): string;
}
export function createReminderProContext({ buildStripeCheckoutUrl, getShortStripeCheckoutUrl }: ReminderProDependencies) {
  async function resolveReminderProUpgradeContext(phoneNumber: unknown, language = 'es', { userId = null, email = null }: ReminderProContextOptions = {}): Promise<ReminderProContext> {
    const stripeUrl = buildStripeCheckoutUrl({ userId, phoneNumber, email, language });
    const shortUrl = getShortStripeCheckoutUrl({ userId, phoneNumber });
    return { checkoutUrl: stripeUrl, shortCheckoutUrl: shortUrl, amount: 14.99, currency: 'USD', ctaHeader: REMINDER_PRO_FALLBACK.ctaHeader,
      ctaButtonText: language === 'en' ? 'Pay now' : 'Pagar ahora', fallbackCheckoutUrl: shortUrl || stripeUrl, provider: 'Stripe', planId: null };
  }
  return { resolveReminderProUpgradeContext };
}
