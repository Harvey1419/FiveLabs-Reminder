import {
  cancelUserSubscription,
  getUserSubscription,
  createPendingSubscription,
} from '../../db/index.js';
import { getOrCreateCanonicalPlan } from '../../services/mercadopago.js';

/**
 * Domain tool for managing subscriptions and billing.
 */
export async function executeSubscriptionTool({ action, params = {}, user, language = 'es' }) {
  const userId = user?.id;
  const phoneNumber = user?.phone_number;

  switch (action) {
    case 'get_link':
    case 'get_subscription_link': {
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

        const rawSummary = `🔗 Enlace de suscripción a Reminder Pro ($${planAmount.toLocaleString('es-CO')} COP/mes): ${checkoutUrl}`;

        return {
          success: true,
          action: 'subscription_link_generated',
          data: {
            checkout_url: checkoutUrl,
            checkoutUrl,
            amount: planAmount,
            currency: 'COP',
            plan: 'Reminder Pro',
            formattedCard: rawSummary,
          },
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

    case 'cancel':
    case 'unsubscribe':
    case 'delete': {
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
