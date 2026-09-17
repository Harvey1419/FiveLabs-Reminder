import {
  cancelUserSubscription,
  getUserSubscription,
  createPendingSubscription,
} from '../../infrastructure/database/index.js';
import { resolveReminderProUpgradeContext } from './reminder-pro.js';

/**
 * Domain tool for managing subscriptions and billing.
 */
export async function executeSubscriptionTool({ action, params = {}, user, language = 'es' }) {
  const userId = user?.id;
  const phoneNumber = user?.phone_number;

  switch (action) {
    case 'get_link': {
      try {
        const proContext = await resolveReminderProUpgradeContext(phoneNumber, language, {
          userId,
          timezone: user?.timezone,
          country: user?.country,
        });
        const checkoutUrl = proContext.checkoutUrl || proContext.fallbackCheckoutUrl;
        const planAmount = proContext.amount;
        const planCurrency = proContext.currency;
        const providerName = proContext.provider || (checkoutUrl?.includes('lemonsqueezy') ? 'Lemon Squeezy' : 'Mercado Pago');

        if (userId && !checkoutUrl?.includes('lemonsqueezy') && proContext.planId) {
          await createPendingSubscription(userId, {
            mpPreapprovalId: proContext.planId,
            amount: planAmount,
            plan: 'pro',
          }).catch(() => {});
        }

        const priceText = planCurrency === 'USD'
          ? `$${Number(planAmount).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} USD`
          : `$${Number(planAmount).toLocaleString(language === 'en' ? 'en-US' : 'es-CO', { maximumFractionDigits: 0 })} ${planCurrency}`;

        const rawSummary = `💎 *Tu acceso Reminder Pro*\n\n💰 Precio: ${priceText}\n\n💳 Enlace de pago (${providerName}): ${checkoutUrl}`;

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
