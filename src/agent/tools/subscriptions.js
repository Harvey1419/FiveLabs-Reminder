import {
  cancelUserSubscription,
  getUserSubscription,
  hasProAccess,
  createPendingSubscription,
} from '../../infrastructure/database/index.js';
import { resolveReminderProUpgradeContext, selectReminderProProvider } from './reminder-pro.js';
import { buildStripeCheckoutUrl } from '../../integrations/stripe/client.js';

function proFacts(hasAccess, language) {
  return {
    hasProAccess: hasAccess,
    benefits: language === 'en'
      ? ['Schedule reminders for future days', 'Set up recurring reminders']
      : ['Programa recordatorios para días futuros', 'Configura recordatorios recurrentes'],
  };
}

async function subscriptionFor(user, userId) {
  return Object.hasOwn(user || {}, 'subscription')
    ? user.subscription
    : (userId ? getUserSubscription(userId) : null);
}

/**
 * Domain tool for managing subscriptions and billing.
 */
export async function executeSubscriptionTool({ action, params = {}, user, language = 'es' }) {
  const userId = user?.id || params.userId;
  const phoneNumber = user?.phone_number || params.phoneNumber || params.phone;

  switch (action) {
    case 'info': {
      // Generic billing questions remain informational. Only declared plan scope
      // can display an existing Payment Link; it never resolves or creates checkout.
      const configured = (process.env.BILLING_PROVIDER || '').toLowerCase();
      const provider = !configured || ['stripe', 'lemonsqueezy', 'mercadopago'].includes(configured)
        ? selectReminderProProvider(phoneNumber, configured)
        : null;
      const data = { provider, paymentMethods: null, price: null, discounts: null,
        checkoutConfirmation: null, chargeOutcome: null, paymentOutcome: null, subscriptionStatus: null };
      const result = { success: true, action: 'subscription_info', data };
      if (params.scope !== 'plan') return result;
      try {
        if (!userId) throw new Error('Authenticated account required');
        const subscription = await subscriptionFor(user, userId);
        const hasAccess = hasProAccess(subscription, user);
        Object.assign(data, proFacts(hasAccess, language));
        if (!hasAccess && provider === 'Stripe') {
          result.ctaUrl = buildStripeCheckoutUrl({ userId, phoneNumber, language });
          result.ctaHeader = '💎 Reminder Pro';
          result.ctaButtonText = language === 'en' ? 'Subscribe to Pro' : 'Suscribirse a Pro';
        }
        return result;
      } catch (error) {
        return { success: false, action: 'error', errorCode: 'SUBSCRIPTION_ENTITLEMENT_ERROR',
          rawSummary: language === 'en' ? 'I could not verify your Pro access.' : 'No pude verificar tu acceso a Pro.' };
      }
    }

    case 'get_link': {
      try {
        const subscription = await subscriptionFor(user, userId);
        if (hasProAccess(subscription, user)) {
          return { success: true, action: 'subscription_already_pro', data: proFacts(true, language) };
        }

        const proContext = await resolveReminderProUpgradeContext(phoneNumber, language, {
          userId,
          timezone: user?.timezone,
          country: user?.country,
        });
        const checkoutUrl = proContext.checkoutUrl || proContext.fallbackCheckoutUrl;
        const planAmount = proContext.amount;
        const planCurrency = proContext.currency;
        const isStripe = Boolean(checkoutUrl?.includes('stripe.com'));
        const isLemon = Boolean(checkoutUrl?.includes('lemonsqueezy'));
        const providerName = proContext.provider || (isStripe ? 'Stripe' : (isLemon ? 'Lemon Squeezy' : 'Mercado Pago'));

        if (userId && !checkoutUrl?.includes('lemonsqueezy') && !checkoutUrl?.includes('stripe.com') && proContext.planId) {
          await createPendingSubscription(userId, {
            mpPreapprovalId: proContext.planId,
            amount: planAmount,
            plan: 'pro',
          }).catch(() => {});
        }

        const priceText = planCurrency === 'USD'
          ? `$${Number(planAmount).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} USD`
          : `$${Number(planAmount).toLocaleString(language === 'en' ? 'en-US' : 'es-CO', { maximumFractionDigits: 0 })} ${planCurrency}`;

        const displayUrl = (isStripe && proContext.shortCheckoutUrl) || checkoutUrl;
        const rawSummary = isStripe
          ? (language === 'en'
            ? `💎 *Your Reminder Pro Access*\n\n💳 *Secure payment link:*\n${displayUrl}`
            : `💎 *Tu acceso Reminder Pro*\n\n💳 *Enlace de pago seguro:*\n${displayUrl}`)
          : `💎 *Tu acceso Reminder Pro*\n\n💰 Precio: ${priceText}\n\n💳 Enlace de pago (${providerName}): ${checkoutUrl}`;

        return {
          success: true,
          action: 'subscription_link_generated',
          data: {
            checkout_url: checkoutUrl,
            checkoutUrl,
            amount: planAmount,
            currency: planCurrency,
            plan: 'Reminder Pro',
            provider: providerName,
            formattedCard: rawSummary,
          },
          ctaUrl: checkoutUrl,
          ctaHeader: proContext.ctaHeader || '💎 Reminder Pro',
          ctaButtonText: proContext.ctaButtonText || (language === 'en' ? 'Pay now' : 'Pagar ahora'),
          rawSummary,
          formattedCard: rawSummary,
        };
      } catch (err) {
        console.error('[subscriptionTools] get_link error:', err);
        return {
          success: false,
          action: 'error',
          errorCode: 'SUBSCRIPTION_LINK_ERROR',
          error: 'No se pudo generar el enlace de pago de suscripción.',
          rawSummary: 'No se pudo generar el enlace de pago de suscripción.',
        };
      }
    }

    case 'cancel': {
      const res = await cancelUserSubscription(userId);
      if (!res.success) {
        return {
          success: false,
          action: 'no_active_subscription',
          errorCode: 'CANCELLATION_FAILED',
          error: res.error || 'No tienes una suscripción activa a Reminder Pro en este momento.',
          rawSummary: 'No tienes una suscripción activa a Reminder Pro en este momento.',
        };
      }

      const rawSummary = 'Tu suscripción a Reminder Pro ha sido cancelada con éxito.';

      return {
        success: true,
        action: 'subscription_cancelled',
        data: {
          result: res,
          subscription: res.subscription,
          formattedCard: rawSummary,
        },
        rawSummary,
        formattedCard: rawSummary,
      };
    }

    case 'status': {
      const sub = await getUserSubscription(userId);
      return {
        success: true,
        action: 'subscription_status',
        rawSummary: sub ? (language === 'en' ? `Subscription: ${sub.plan} (${sub.status}).` : `Suscripción: ${sub.plan} (${sub.status}).`) : (language === 'en' ? 'You have no active subscription.' : 'No tienes una suscripción activa.'),
        data: {
          subscription: sub,
        },
      };
    }

    default:
      return {
        success: false,
        action: 'unsupported_action',
        errorCode: 'UNSUPPORTED_ACTION',
        error: `Acción '${action}' no soportada para manage_subscription.`,
        rawSummary: `Acción '${action}' no soportada para manage_subscription.`,
      };
  }
}
