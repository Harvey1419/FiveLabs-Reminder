import { verifyLemonSqueezySignature } from '../../integrations/lemon-squeezy/client.js';
import { supabase } from '../../infrastructure/database/index.js';
import { normalizeUserPhone } from '../../infrastructure/database/users.js';
import { sendWhatsAppText, sendWhatsAppTemplate } from '../../integrations/whatsapp/kapso-client.js';

/**
 * Resolve target user in database using custom data or customer email.
 *
 * @param {object} customData
 * @param {string} [customData.user_id]
 * @param {string} [customData.phone]
 * @param {string} [userEmail]
 * @returns {Promise<object|null>}
 */
async function resolveUserFromWebhook(customData = {}, userEmail = null) {
  const userId = customData.user_id ? String(customData.user_id).trim() : null;
  if (userId) {
    const { data: user } = await supabase
      .from('users')
      .select('*')
      .eq('id', userId)
      .maybeSingle();
    if (user) return user;
  }

  const rawPhone = customData.phone ? String(customData.phone).trim() : null;
  if (rawPhone) {
    const cleanPhone = normalizeUserPhone(rawPhone);
    if (cleanPhone) {
      const { data: user } = await supabase
        .from('users')
        .select('*')
        .eq('phone_number', cleanPhone)
        .maybeSingle();
      if (user) return user;
    }
  }

  if (userEmail && typeof userEmail === 'string') {
    const cleanEmail = userEmail.trim().toLowerCase();
    if (cleanEmail) {
      const { data: user } = await supabase
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
 * Handle incoming Lemon Squeezy Webhook notifications.
 *
 * Listens for:
 * - subscription_created
 * - subscription_updated
 * - subscription_payment_success
 * - subscription_resumed
 * - subscription_cancelled
 * - subscription_expired
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 */
export async function handleLemonSqueezyWebhook(req, res) {
  // 1. Signature validation
  if (!verifyLemonSqueezySignature(req)) {
    console.warn('[lemon-squeezy-webhook] Signature verification failed');
    return res.status(401).json({ error: 'Unauthorized: Invalid signature' });
  }

  // 2. Respond immediately to avoid timeout
  const eventName = req.body?.meta?.event_name;
  const customData = req.body?.meta?.custom_data || {};
  const data = req.body?.data || {};
  const attributes = data.attributes || {};
  const subId = data.id ? String(data.id) : null;

  console.log(`[lemon-squeezy-webhook] Received event="${eventName}" subId="${subId}" user_email="${attributes.user_email || 'none'}"`);

  res.status(200).json({ status: 'received' });

  if (!eventName || !subId) {
    return;
  }

  try {
    const providerSubId = `ls_${subId}`;
    const userEmail = attributes.user_email || null;
    const rawStatus = String(attributes.status || '').toLowerCase();
    const renewsAt = attributes.renews_at || attributes.ends_at || null;

    // Find the user to associate with this subscription
    const user = await resolveUserFromWebhook(customData, userEmail);

    if (
      eventName === 'subscription_created'
      || eventName === 'subscription_updated'
      || eventName === 'subscription_payment_success'
      || eventName === 'subscription_resumed'
    ) {
      const isPaidActive = ['active', 'on_trial'].includes(rawStatus) || eventName === 'subscription_payment_success';
      const dbStatus = isPaidActive ? 'authorized' : (rawStatus === 'cancelled' ? 'cancelled' : 'paused');
      const plan = isPaidActive ? 'pro' : 'free';

      if (user?.id) {
        const { data: existingSub } = await supabase
          .from('subscriptions')
          .select('*')
          .or(`mp_preapproval_id.eq.${providerSubId},user_id.eq.${user.id}`)
          .order('created_at', { ascending: false })
          .limit(1)
          .maybeSingle();

        if (existingSub) {
          await supabase
            .from('subscriptions')
            .update({
              mp_preapproval_id: providerSubId,
              plan,
              status: dbStatus,
              next_payment_date: renewsAt,
              updated_at: new Date().toISOString(),
            })
            .eq('id', existingSub.id);
        } else {
          await supabase
            .from('subscriptions')
            .insert({
              user_id: user.id,
              mp_preapproval_id: providerSubId,
              plan,
              status: dbStatus,
              next_payment_date: renewsAt,
            });
        }

        console.log(`[lemon-squeezy-webhook] Subscription synced: userId=${user.id} plan=${plan} status=${dbStatus}`);

        // If newly authorized or created, send welcome WhatsApp notification
        if (dbStatus === 'authorized' && user.phone_number) {
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
            console.warn(`[lemon-squeezy-webhook] sendWhatsAppText failed (${textErr.message}), trying template fallback...`);
            await sendWhatsAppTemplate({
              phoneNumber: user.phone_number,
              templateName: 'reminder_task_one_reminder',
              parameters: [
                isEnglish
                  ? '🎉 Your Reminder Pro subscription is active! You now have unlimited access.'
                  : '🎉 ¡Tu suscripción a Reminder Pro está activa! Ya tienes acceso ilimitado.',
              ],
            }).catch((tmplErr) => {
              console.error(`[lemon-squeezy-webhook] Failed to send template welcome to ${user.phone_number}:`, tmplErr.message);
            });
          }
        }
      } else {
        console.warn(`[lemon-squeezy-webhook] Could not resolve user for subscription ${providerSubId} (customData=${JSON.stringify(customData)}, email=${userEmail})`);
      }
    } else if (eventName === 'subscription_cancelled' || eventName === 'subscription_expired') {
      const canceledAt = new Date().toISOString();
      await supabase
        .from('subscriptions')
        .update({
          status: 'cancelled',
          plan: 'free',
          canceled_at: canceledAt,
          updated_at: canceledAt,
        })
        .eq('mp_preapproval_id', providerSubId);

      console.log(`[lemon-squeezy-webhook] Subscription marked as cancelled for ${providerSubId}`);
    }
  } catch (err) {
    console.error('[lemon-squeezy-webhook] Error processing event:', err);
  }
}
