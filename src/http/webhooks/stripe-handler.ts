import { ensureBillingWrite, canFallbackBillingMessage } from './billing-webhook-ports.js';
import type { BillingRequest, BillingResponse, BillingStorePorts, StripeSession } from './billing-webhook-ports.js';

export function createStripeWebhook({ getClient, normalizeUserPhone, verifySignature, getNow, getNowMs, sendWhatsAppText, sendWhatsAppTemplate, logger }: BillingStorePorts) {
  /**
   * Resolve target user in database using client_reference_id, phone, or customer email.
   *
   * @param {object} session
   * @returns {Promise<object|null>}
   */
  async function resolveUserFromStripeSession(session: StripeSession = {}) {
    const clientRef = session.client_reference_id ? String(session.client_reference_id).trim() : null;
    if (clientRef) {
      const { data: userById } = await getClient()
        .from('users')
        .select('*')
        .eq('id', clientRef)
        .maybeSingle();
      if (userById) return userById;

      const cleanRefPhone = normalizeUserPhone(clientRef);
      if (cleanRefPhone) {
        const { data: userByPhone } = await getClient()
          .from('users')
          .select('*')
          .eq('phone_number', cleanRefPhone)
          .maybeSingle();
        if (userByPhone) return userByPhone;
      }
    }

    const rawPhone = session.customer_details?.phone || session.metadata?.phone || null;
    if (rawPhone) {
      const cleanPhone = normalizeUserPhone(rawPhone);
      if (cleanPhone) {
        const { data: user } = await getClient()
          .from('users')
          .select('*')
          .eq('phone_number', cleanPhone)
          .maybeSingle();
        if (user) return user;
      }
    }

    const rawEmail = session.customer_details?.email || session.customer_email || session.metadata?.email || null;
    if (rawEmail && typeof rawEmail === 'string') {
      const cleanEmail = rawEmail.trim().toLowerCase();
      if (cleanEmail) {
        const { data: user } = await getClient()
          .from('users')
          .select('*')
          .eq('email', cleanEmail)
          .maybeSingle();
        if (user) return user;
      }
    }

    return null;
  }

  /**
   * Handle incoming Stripe Webhook notifications.
   *
   * Listens for:
   * - checkout.session.completed
   * - customer.subscription.updated
   * - customer.subscription.deleted
   * - invoice.payment_succeeded
   * - invoice.payment_failed
   *
   * @param {import('express').Request} req
   * @param {import('express').Response} res
   */
  async function handleStripeWebhook(req: BillingRequest, res: BillingResponse) {
    // 1. Signature validation
    if (!verifySignature(req)) {
      logger.warn('[stripe-webhook] Signature verification failed');
      return res.status(401).json({ error: 'Unauthorized: Invalid signature' });
    }

    const event = req.body || {};
    const eventType = event.type;
    const dataObject = event.data?.object || {};

    logger.log(`[stripe-webhook] Received event="${eventType}" id="${event.id || 'none'}"`);

    // 2. Respond immediately to avoid timeout
    res.status(200).json({ received: true });

    if (!eventType) {
      return;
    }

    try {
      if (eventType === 'checkout.session.completed') {
        const user = await resolveUserFromStripeSession(dataObject);
        const subId = dataObject.subscription ? String(dataObject.subscription) : (dataObject.id ? `stripe_${dataObject.id}` : null);

        if (user?.id && subId) {
          const nextPaymentDate = new Date(getNowMs() + 30 * 24 * 60 * 60 * 1000).toISOString();
          const amount = dataObject.amount_total ? Number(dataObject.amount_total) / 100 : 14.99;

          const { data: existingSub } = await getClient()
            .from('subscriptions')
            .select('*')
            .or(`mp_preapproval_id.eq.${subId},user_id.eq.${user.id}`)
            .order('created_at', { ascending: false })
            .limit(1)
            .maybeSingle();

          if (existingSub) {
            await ensureBillingWrite(getClient()
              .from('subscriptions')
              .update({
                mp_preapproval_id: subId,
                plan: 'pro',
                status: 'authorized',
                amount,
                next_payment_date: nextPaymentDate,
                updated_at: getNow().toISOString(),
              })
              .eq('id', existingSub.id));
          } else {
            await ensureBillingWrite(getClient()
              .from('subscriptions')
              .insert({
                user_id: user.id,
                mp_preapproval_id: subId,
                plan: 'pro',
                status: 'authorized',
                amount,
                next_payment_date: nextPaymentDate,
              }));
          }

          logger.log(`[stripe-webhook] Subscription active for userId=${user.id} subId=${subId}`);

          // Send welcome WhatsApp notification
          if (user.phone_number) {
            const isEnglish = Boolean(user.locale?.startsWith('en'));
            const welcomeMessage = isEnglish
              ? '🎉 *Welcome to Reminder Pro!*\n\n'
                + 'Your subscription has been confirmed successfully! You now have full, unlimited access to all features:\n\n'
                + '• 📅 *Unlimited reminders* (any day, week, or month)\n'
                + '• 🔄 *Recurring routines* (daily, weekly, monthly)\n'
                + '• 📋 *Tasks, checklists & persistent memory*\n'
                + '• 🌅 *Personalized daily morning briefing*\n\n'
                + 'Thank you for choosing Reminder! What would you like to schedule?'
              : '🎉 *¡Bienvenido a Reminder Pro!*\n\n'
                + 'Tu suscripción ha sido confirmada con éxito. Ya tienes acceso completo e ilimitado a todas las funciones:\n\n'
                + '• 📅 *Recordatorios sin límites* (para cualquier día, semana o mes)\n'
                + '• 🔄 *Recordatorios recurrentes* (diarios, semanales, mensuales)\n'
                + '• 📋 *Checklists, tareas y memoria persistente*\n'
                + '• 🌅 *Morning briefing diario personalizado*\n\n'
                + '¡Gracias por confiar en Reminder! ¿Qué recordatorio deseas programar?';

            try {
              await sendWhatsAppText({ phoneNumber: user.phone_number, text: welcomeMessage });
            } catch (textErr) {
              if (!canFallbackBillingMessage(textErr)) throw textErr;
              logger.warn(`[stripe-webhook] sendWhatsAppText failed (${(textErr as Error).message}), trying template fallback...`);
              await sendWhatsAppTemplate({
                phoneNumber: user.phone_number,
                templateName: 'reminder_task_one_reminder',
                parameters: [
                  isEnglish
                    ? '🎉 Your Reminder Pro subscription is active! You now have unlimited access.'
                    : '🎉 ¡Tu suscripción a Reminder Pro está activa! Ya tienes acceso ilimitado.',
                ],
              }).catch((tmplErr) => {
                logger.error(`[stripe-webhook] Failed to send template welcome to ${user.phone_number}:`, (tmplErr as Error).message);
              });
            }
          }
        } else {
          logger.warn(`[stripe-webhook] Could not resolve user or subId for session: ${JSON.stringify({
            client_reference_id: dataObject.client_reference_id,
            email: dataObject.customer_details?.email,
            phone: dataObject.customer_details?.phone,
          })}`);
        }
      } else if (eventType === 'customer.subscription.updated') {
        const subId = dataObject.id ? String(dataObject.id) : null;
        if (!subId) return;

        const rawStatus = String(dataObject.status || '').toLowerCase();
        const isPaidActive = ['active', 'trialing'].includes(rawStatus);
        const dbStatus = isPaidActive ? 'authorized' : (rawStatus === 'canceled' ? 'cancelled' : 'paused');
        const plan = isPaidActive ? 'pro' : 'free';
        const renewsAt = dataObject.current_period_end
          ? new Date(dataObject.current_period_end * 1000).toISOString()
          : null;

        await ensureBillingWrite(getClient()
          .from('subscriptions')
          .update({
            plan,
            status: dbStatus,
            ...(renewsAt ? { next_payment_date: renewsAt } : {}),
            updated_at: getNow().toISOString(),
          })
          .eq('mp_preapproval_id', subId));

        logger.log(`[stripe-webhook] Subscription ${subId} updated: status=${dbStatus} plan=${plan}`);
      } else if (eventType === 'customer.subscription.deleted') {
        const subId = dataObject.id ? String(dataObject.id) : null;
        if (!subId) return;

        const canceledAt = getNow().toISOString();
        await ensureBillingWrite(getClient()
          .from('subscriptions')
          .update({
            status: 'cancelled',
            plan: 'free',
            canceled_at: canceledAt,
            updated_at: canceledAt,
          })
          .eq('mp_preapproval_id', subId));

        logger.log(`[stripe-webhook] Subscription marked as cancelled for ${subId}`);
      } else if (eventType === 'invoice.payment_succeeded' || eventType === 'invoice.paid') {
        const subId = dataObject.subscription ? String(dataObject.subscription) : null;
        if (subId) {
          const periodEnd = dataObject.lines?.data?.[0]?.period?.end;
          const renewsAt = periodEnd ? new Date(periodEnd * 1000).toISOString() : null;

          await ensureBillingWrite(getClient()
            .from('subscriptions')
            .update({
              status: 'authorized',
              plan: 'pro',
              ...(renewsAt ? { next_payment_date: renewsAt } : {}),
              updated_at: getNow().toISOString(),
            })
            .eq('mp_preapproval_id', subId));

          logger.log(`[stripe-webhook] Invoice payment succeeded for subId=${subId}`);
        }
      } else if (eventType === 'invoice.payment_failed') {
        const subId = dataObject.subscription ? String(dataObject.subscription) : null;
        logger.warn(`[stripe-webhook] Invoice payment failed for subId=${subId || 'none'}`);
      }
    } catch (err) {
      logger.error('[stripe-webhook] Error processing event:', err);
    }
  }
  return { handleStripeWebhook };
}
