import {
  subscriptionResultSchema, type SubscriptionRequest, type SubscriptionResult,
} from '@templelabs/contracts';
import type { SubscriptionDomainPort, ToolOutcome } from '@templelabs/tools';
import {
  getUserSubscription, hasProAccess, cancelUserSubscription,
} from '../../infrastructure/database/subscriptions.js';
import { resolveReminderProUpgradeContext } from '../../agent/tools/reminder-pro.js';
import type { ProductivityUser } from '../../features/productivity-domain.js';
import { checkDomainContext } from './domain-outcome.js';

export function createSubscriptionDomainPort(user: ProductivityUser): SubscriptionDomainPort {
  const userId = user.id;
  const phoneNumber = user.phone_number;

  return {
    async execute(request, context, operationId): Promise<ToolOutcome<SubscriptionResult>> {
      const invalid = checkDomainContext(userId, context);
      if (invalid) return invalid;

      try {
        const sub = await getUserSubscription(userId);
        const isPro = hasProAccess(sub);
        const upgradeContext = await resolveReminderProUpgradeContext(phoneNumber, context.language, { userId });

        const benefits = context.language === 'en'
          ? ['Schedule reminders for future days', 'Set up recurring reminders', 'Unlimited agenda queries']
          : ['Programar recordatorios para días futuros', 'Configurar recordatorios recurrentes', 'Consultas de agenda ilimitadas'];

        if (request.operation === 'info') {
          const card = isPro
            ? (context.language === 'en' ? '💎 You have an active Hermes Pro subscription.' : '💎 Tienes una suscripción activa a Hermes Pro.')
            : (context.language === 'en'
              ? `Hermes Pro (${upgradeContext.currency} $${upgradeContext.amount}/month) includes:\n• ${benefits.join('\n• ')}`
              : `Hermes Pro (${upgradeContext.currency} $${upgradeContext.amount}/mes) incluye:\n• ${benefits.join('\n• ')}`);

          const checkoutUrl = isPro ? null : (upgradeContext.shortCheckoutUrl || upgradeContext.checkoutUrl);
          const data: SubscriptionResult = subscriptionResultSchema.parse({
            operation: 'info',
            isPro,
            plan: (sub as any)?.plan ?? (isPro ? 'pro' : 'free'),
            status: (sub as any)?.status ?? (isPro ? 'active' : 'none'),
            benefits,
            price: upgradeContext.amount,
            currency: upgradeContext.currency,
            checkoutUrl,
            issues: [],
            presentation: {
              canonicalCard: card,
              questions: [],
              cta: isPro ? null : {
                url: checkoutUrl!,
                header: upgradeContext.ctaHeader,
                buttonText: upgradeContext.ctaButtonText,
              },
            },
          });

          return {
            status: 'success',
            data,
            receipt: {
              userId,
              operationId,
              toolName: 'subscription_info',
              resourceIds: sub ? [(sub as any).id] : [],
            },
            observation: JSON.stringify({
              operation: 'info',
              isPro,
              plan: data.plan,
              price: data.price,
              currency: data.currency,
            }),
          };
        }

        if (request.operation === 'checkout') {
          if (isPro) {
            const card = context.language === 'en'
              ? 'You already have an active Pro subscription.'
              : 'Ya tienes una suscripción activa a Hermes Pro.';
            const data: SubscriptionResult = subscriptionResultSchema.parse({
              operation: 'checkout',
              isPro: true,
              plan: 'pro',
              status: 'active',
              benefits,
              price: upgradeContext.amount,
              currency: upgradeContext.currency,
              checkoutUrl: null,
              issues: [],
              presentation: { canonicalCard: card, questions: [], cta: null },
            });
            return {
              status: 'success',
              data,
              receipt: { userId, operationId, toolName: 'subscription_checkout', resourceIds: sub ? [(sub as any).id] : [] },
              observation: JSON.stringify({ isPro: true, status: 'already_pro' }),
            };
          }

          const checkoutUrl = upgradeContext.shortCheckoutUrl || upgradeContext.checkoutUrl;
          const card = context.language === 'en'
            ? `Upgrade to Hermes Pro (${upgradeContext.currency} $${upgradeContext.amount}/month) here: ${checkoutUrl}`
            : `Activa Hermes Pro (${upgradeContext.currency} $${upgradeContext.amount}/mes) en este enlace: ${checkoutUrl}`;

          const data: SubscriptionResult = subscriptionResultSchema.parse({
            operation: 'checkout',
            isPro: false,
            plan: 'free',
            status: 'none',
            benefits,
            price: upgradeContext.amount,
            currency: upgradeContext.currency,
            checkoutUrl,
            issues: [],
            presentation: {
              canonicalCard: card,
              questions: [],
              cta: {
                url: checkoutUrl,
                header: upgradeContext.ctaHeader,
                buttonText: upgradeContext.ctaButtonText,
              },
            },
          });

          return {
            status: 'success',
            data,
            receipt: { userId, operationId, toolName: 'subscription_checkout', resourceIds: [] },
            observation: JSON.stringify({
              operation: 'checkout',
              checkoutUrl,
              amount: upgradeContext.amount,
              currency: upgradeContext.currency,
            }),
          };
        }

        if (request.operation === 'cancel') {
          if (!isPro) {
            return {
              status: 'failed',
              code: 'NO_ACTIVE_SUBSCRIPTION',
              observation: context.language === 'en'
                ? 'No active subscription found to cancel.'
                : 'No tienes una suscripción activa para cancelar.',
            };
          }

          const cancelRes = await cancelUserSubscription(userId);
          if (!cancelRes.success) {
            return {
              status: 'failed',
              code: 'CANCELLATION_FAILED',
              observation: cancelRes.error ?? 'Could not cancel subscription.',
            };
          }

          const card = context.language === 'en'
            ? 'Your Pro subscription has been cancelled.'
            : 'Tu suscripción Pro ha sido cancelada.';

          const data: SubscriptionResult = subscriptionResultSchema.parse({
            operation: 'cancel',
            isPro: false,
            plan: 'free',
            status: 'cancelled',
            benefits,
            price: upgradeContext.amount,
            currency: upgradeContext.currency,
            checkoutUrl: null,
            issues: [],
            presentation: { canonicalCard: card, questions: [], cta: null },
          });

          return {
            status: 'success',
            data,
            receipt: {
              userId,
              operationId,
              toolName: 'subscription_cancel',
              resourceIds: sub ? [(sub as any).id] : [],
            },
            observation: JSON.stringify({ operation: 'cancel', status: 'cancelled' }),
          };
        }

        return {
          status: 'failed',
          code: 'UNSUPPORTED_OPERATION',
          observation: 'Unsupported subscription operation.',
        };
      } catch (err: any) {
        return {
          status: 'failed',
          code: 'SUBSCRIPTION_ERROR',
          observation: err?.message ?? 'Subscription service error',
        };
      }
    },
  };
}
