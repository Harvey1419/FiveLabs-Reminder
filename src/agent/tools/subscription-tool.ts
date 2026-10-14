import type { DomainInput, SubscriptionRow, ToolResult } from './remaining-tool-ports.js';

export interface Dependencies {
  cancelUserSubscription: (userId: string | undefined) => Promise<{ success: boolean; error?: string; subscription?: unknown }>;
  getUserSubscription: (userId: string | undefined) => Promise<SubscriptionRow | null>;
  hasProAccess: (subscription: unknown, user: unknown) => boolean;
  resolveReminderProUpgradeContext: typeof import('./reminder-pro.js').resolveReminderProUpgradeContext;
  selectReminderProProvider: typeof import('./reminder-pro.js').selectReminderProProvider;
  buildStripeCheckoutUrl: typeof import('../../integrations/stripe/client.js').buildStripeCheckoutUrl;
  logger: Pick<Console, 'log' | 'warn' | 'error'>;
}

export function createSubscriptionTool(dependencies: Dependencies) {
const { cancelUserSubscription, getUserSubscription, hasProAccess, resolveReminderProUpgradeContext, selectReminderProProvider, buildStripeCheckoutUrl, logger } = dependencies;

function proFacts(hasAccess: boolean, language: string) {
  return {
    hasProAccess: hasAccess,
    benefits: language === 'en'
      ? ['Schedule reminders for future days', 'Set up recurring reminders']
      : ['Programa recordatorios para días futuros', 'Configura recordatorios recurrentes'],
  };
}

async function subscriptionFor(user: DomainInput['user'], userId: string | undefined) {
  return Object.hasOwn(user || {}, 'subscription')
    ? user!.subscription
    : (userId ? getUserSubscription(userId) : null);
}

/**
 * Domain tool for managing subscriptions and billing.
 */
async function executeSubscriptionTool({ action, params = {}, user, language = 'es' }: DomainInput) {
  const userId = user?.id || params.userId;
  const phoneNumber = user?.phone_number || params.phoneNumber || params.phone;

  switch (action) {
    case 'info': {
      // Generic billing questions remain informational. Only declared plan scope
      // can display an existing Payment Link; it never resolves or creates checkout.
      const provider = selectReminderProProvider(phoneNumber);
      const data: Record<string, unknown> = { provider, paymentMethods: null, price: null, discounts: null,
        checkoutConfirmation: null, chargeOutcome: null, paymentOutcome: null, subscriptionStatus: null };
      const result: ToolResult = { success: true, action: 'subscription_info', data };
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
        const providerName = 'Stripe';
        const displayUrl = proContext.shortCheckoutUrl || checkoutUrl;
        const rawSummary = language === 'en'
          ? `💎 *Your Reminder Pro Access*\n\n💳 *Secure payment link:*\n${displayUrl}`
          : `💎 *Tu acceso Reminder Pro*\n\n💳 *Enlace de pago seguro:*\n${displayUrl}`;

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
        logger.error('[subscriptionTools] get_link error:', err);
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
      let res;
      try { res = await cancelUserSubscription(userId); } catch { return { success: false, action: 'error', errorCode: 'CANCELLATION_FAILED', rawSummary: language === 'en' ? 'I could not confirm the subscription cancellation.' : 'No pude confirmar la cancelación de la suscripción.' }; }
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

return { executeSubscriptionTool };
}
