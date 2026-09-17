import { getOrCreateCanonicalPlan } from '../../integrations/mercado-pago/client.js';
import { buildLemonSqueezyCheckoutUrl } from '../../integrations/lemon-squeezy/client.js';

export const REMINDER_PRO_FALLBACK = Object.freeze({
  price: 49900,
  currency: 'COP',
  reason: 'Hermes TempleLabs Pro',
  fallbackCheckoutUrl: 'https://www.mercadopago.com.co/subscriptions',
  ctaHeader: '💎 Reminder Pro',
});

/**
 * Canonical Reminder Pro checkout context.
 *
 * Tool modules decide whether Pro is required; this module only owns the
 * shared commercial metadata and checkout-link resolution so create/update
 * cannot drift into different plan configuration or fallback behavior.
 */
export async function resolveReminderProUpgradeContext(phoneNumber, language = 'es', { userId = null } = {}) {
  const isInternational = Boolean(
    phoneNumber
    && !String(phoneNumber).startsWith('+57')
    && !String(phoneNumber).startsWith('57')
    && !String(phoneNumber).startsWith('CO.')
  );

  const billingProvider = (process.env.BILLING_PROVIDER || '').toLowerCase();
  const forceLemon = billingProvider === 'lemonsqueezy';
  const forceMp = billingProvider === 'mercadopago';
  const useLemon = forceLemon || (!forceMp && isInternational);

  if (useLemon) {
    const lemonUrl = buildLemonSqueezyCheckoutUrl({ userId, phoneNumber });
    return {
      checkoutUrl: lemonUrl,
      amount: 9.99,
      currency: 'USD',
      ctaHeader: REMINDER_PRO_FALLBACK.ctaHeader,
      ctaButtonText: language === 'en' ? 'Pay now' : 'Pagar ahora',
      fallbackCheckoutUrl: lemonUrl,
      provider: 'Lemon Squeezy',
      planId: null,
    };
  }

  const context = {
    checkoutUrl: null,
    amount: REMINDER_PRO_FALLBACK.price,
    currency: REMINDER_PRO_FALLBACK.currency,
    ctaHeader: REMINDER_PRO_FALLBACK.ctaHeader,
    ctaButtonText: language === 'en' ? 'Pay now' : 'Pagar ahora',
    fallbackCheckoutUrl: REMINDER_PRO_FALLBACK.fallbackCheckoutUrl,
    provider: 'Mercado Pago',
    planId: null,
  };

  try {
    const plan = await getOrCreateCanonicalPlan({
      reason: REMINDER_PRO_FALLBACK.reason,
      amount: REMINDER_PRO_FALLBACK.price,
      currency: REMINDER_PRO_FALLBACK.currency,
      phoneNumber,
    });

    context.checkoutUrl = plan?.init_point || plan?.checkout_url || null;
    context.planId = plan?.id || null;
    if (plan?.amount) {
      const parsedAmount = Number(plan.amount);
      if (Number.isFinite(parsedAmount)) context.amount = parsedAmount;
    }
    if (plan?.currency) context.currency = String(plan.currency);
  } catch (err) {
    console.warn('[reminder-pro] Failed to resolve Reminder Pro checkout link:', err.message);
  }

  return context;
}
