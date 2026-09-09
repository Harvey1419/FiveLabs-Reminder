import {
  cancelUserSubscription,
  getUserSubscription,
  createPendingSubscription,
} from '../../infrastructure/database/index.js';
import { getOrCreateCanonicalPlan } from '../../integrations/mercado-pago/client.js';

/**
 * Domain tool for managing subscriptions and billing.
 */
export async function executeSubscriptionTool({ action, params = {}, user, language = 'es' }) {
  const userId = user?.id;
  const phoneNumber = user?.phone_number;

  switch (action) {
    case 'get_link': {
      try {
        const plan = await getOrCreateCanonicalPlan({
          reason: 'Hermes TempleLabs Pro',
          amount: 49900,
          currency: 'COP',
          phoneNumber,
        });

        const planAmount = plan.amount || 49900;
        const checkoutUrl = plan.init_point || plan.checkout_url;

        if (userId) {
          await createPendingSubscription(userId, {
            mpPreapprovalId: plan.id,
            amount: planAmount,
            plan: 'pro',
          }).catch(() => {});
        }

        const planCurrency = plan.currency || 'COP';
        const priceText = language === 'en'
          ? `$${planAmount.toLocaleString('en-US', { maximumFractionDigits: 0 })} ${planCurrency}`
          : `$${planAmount.toLocaleString('es-CO', { maximumFractionDigits: 0 })} ${planCurrency}`;
        const rawSummary = `💎 *Tu acceso Reminder Pro*\n\n💰 Precio: ${priceText}\n\n💳 Enlace de pago (Mercado Pago): ${checkoutUrl}`;

        return {
          success: true,
          action: 'subscription_link_generated',
          data: {
            checkout_url: checkoutUrl,
            checkoutUrl,
            amount: planAmount,
            currency: planCurrency,
            plan: 'Reminder Pro',
            formattedCard: rawSummary,
          },
          ctaUrl: checkoutUrl,
          ctaHeader: '💎 Reminder Pro',
          ctaButtonText: language === 'en' ? 'Pay now' : 'Pagar ahora',
          rawSummary,
          formattedCard: rawSummary,
        };
      } catch (err) {
        console.error('[subscriptionTools] get_link error:', err);
        return {
          success: false,
          action: 'error',
          errorCode: 'MERCADOPAGO_ERROR',
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
