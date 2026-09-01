import { getPreapproval, verifyWebhookSignature } from '../services/mercadopago.js';
import { updateSubscriptionFromWebhook, getSubscriptionByMpId } from '../db/subscriptions.js';
import { sendWhatsAppText, sendWhatsAppTemplate } from '../utils/kapso.js';

/**
 * Handle incoming MercadoPago Webhook notifications.
 * Listens for 'subscription_preapproval' and 'subscription_authorized_payment'.
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 */
export async function handleMercadoPagoWebhook(req, res) {
  // 1. Signature validation
  if (!verifyWebhookSignature(req)) {
    console.warn('[mp-webhook] Signature verification failed');
    return res.status(401).json({ error: 'Unauthorized: Invalid signature' });
  }

  // 2. Respond immediately to avoid timeouts
  const topic = req.body?.type || req.query?.type || req.query?.topic || req.body?.topic;
  const dataId = req.body?.data?.id || req.query?.['data.id'] || req.body?.id;

  console.log(`[mp-webhook] Inbound notification: topic="${topic}", dataId="${dataId}"`);

  // Acknowledge receipt to MercadoPago
  res.status(200).json({ status: 'received' });

  if (!dataId) {
    return;
  }

  try {
    // 3. Handle Subscription Preapproval (creation, approval, cancellation, pauses)
    if (topic === 'subscription_preapproval' || topic === 'preapproval') {
      const mpSub = await getPreapproval(dataId);
      if (!mpSub) return;

      const mpStatus = mpSub.status; // 'authorized' | 'paused' | 'cancelled' | 'pending'
      const nextPaymentDate = mpSub.next_payment_date || null;
      const externalReference = mpSub.external_reference; // user.id

      console.log(`[mp-webhook] Preapproval sync: id=${dataId} status=${mpStatus} next_payment=${nextPaymentDate}`);

      const subRecord = await updateSubscriptionFromWebhook({
        mpPreapprovalId: dataId,
        preapprovalPlanId: mpSub.preapproval_plan_id || null,
        status: mpStatus,
        nextPaymentDate,
        plan: mpStatus === 'authorized' ? 'pro' : 'free',
      });

      // If subscription became authorized (activated), notify user via WhatsApp
      if (mpStatus === 'authorized') {
        const subWithUser = await getSubscriptionByMpId(dataId);
        const phoneNumber = subWithUser?.user?.phone_number;

        if (phoneNumber) {
          const welcomeMessage =
            `🎉 *¡Bienvenido a Reminder Pro!*\n\n` +
            `Tu suscripción ha sido confirmada con éxito. Ya tienes acceso completo e ilimitado a todas las funciones:\n\n` +
            `• 📅 *Recordatorios sin límites* (para cualquier día, semana o mes)\n` +
            `• 🔄 *Recordatorios recurrentes* (diarios, semanales, mensuales)\n` +
            `• 📋 *Checklists y tareas avanzadas*\n` +
            `• 🌅 *Morning briefing diario personalizado*\n\n` +
            `¡Gracias por confiar en Reminder! ¿Qué recordatorio deseas programar?`;

          try {
            await sendWhatsAppText({ phoneNumber, text: welcomeMessage });
          } catch (textErr) {
            console.warn(`[mp-webhook] sendWhatsAppText failed (${textErr.message}), falling back to template message...`);
            await sendWhatsAppTemplate({
              phoneNumber,
              templateName: 'reminder_task_one_reminder',
              parameters: ['🎉 ¡Tu suscripción a Reminder Pro está activa! Ya tienes acceso ilimitado a todas las funciones.'],
            }).catch(tmplErr => {
              console.error(`[mp-webhook] Failed to send template welcome WhatsApp to ${phoneNumber}:`, tmplErr.message);
            });
          }
        }
      }
    } else if (topic === 'subscription_authorized_payment' || topic === 'authorized_payment') {
      // Recurring payment succeeded: dataId might be payment ID or preapproval ID
      console.log(`[mp-webhook] Authorized payment event received for ${dataId}`);
    }
  } catch (err) {
    console.error(`[mp-webhook] Error processing notification:`, err);
  }
}
