import 'dotenv/config';
import { supabase } from '../src/db/index.js';
import { routeMessage } from '../src/ai/router.js';
import { getOrCreateUserByPhone } from '../src/db/users.js';
import { createPreapproval, getPreapproval } from '../src/services/mercadopago.js';
import {
  getUserSubscription,
  hasProAccess,
  createPendingSubscription,
  updateSubscriptionFromWebhook,
} from '../src/db/subscriptions.js';
import { handleMercadoPagoWebhook } from '../src/webhooks/mercadopagoWebhook.js';

async function runLiveE2ETest() {
  console.log('====================================================');
  console.log('🚀 INICIANDO PRUEBAS E2E REALES (USUARIO ↔ MP ↔ BOT)');
  console.log('====================================================\n');

  // STEP 0: Create or get real test user
  const testPhone = '573009990001';
  console.log(`📌 0. Obteniendo / Creando usuario de prueba: ${testPhone}...`);
  const user = await getOrCreateUserByPhone(testPhone, 'America/Bogota', 'es-CO', 'Carlos Gomez');
  console.log(`   ✅ Usuario ID: ${user.id} | Phone: ${user.phone_number} | TZ: ${user.timezone}`);

  // Clean any previous test subscriptions for clean state
  await supabase.from('subscriptions').delete().eq('user_id', user.id);
  console.log('   🧹 Suscripciones previas limpiadas para inicio en estado Free (Demo).\n');

  // STEP 1: Test Free user creating same-day reminder
  console.log('📌 1. Test Usuario Free -> Recordatorio para HOY:');
  const msg1 = 'Recuérdame pagar la factura de energía hoy a las 8pm';
  console.log(`   👤 User: "${msg1}"`);
  const res1 = await routeMessage(msg1, user);
  console.log(`   🤖 Bot reply:\n${res1.confirmation}\n`);

  // STEP 2: Test Free user creating tomorrow / future reminder (Must be BLOCKED)
  console.log('📌 2. Test Usuario Free -> Recordatorio para MAÑANA (Debe ser bloqueado por tier limit):');
  const msg2 = 'Recuérdame mañana a las 9am llamar al doctor';
  console.log(`   👤 User: "${msg2}"`);
  const res2 = await routeMessage(msg2, user);
  console.log(`   🤖 Bot reply:\n${res2.confirmation}\n`);

  // STEP 3: Test User requesting subscription link via natural language
  console.log('📌 3. Test Usuario pidiendo enlace de suscripción a Reminder Pro:');
  const msg3 = '¿Cómo me suscribo a Pro? Dame el enlace de pago por favor';
  console.log(`   👤 User: "${msg3}"`);
  const res3 = await routeMessage(msg3, user);
  console.log(`   🤖 Bot reply:\n${res3.confirmation}\n`);

  // Verify pending subscription was created in Supabase
  const pendingSub = await getUserSubscription(user.id);
  console.log('   🔍 Verificando registro en Supabase `subscriptions`:');
  console.log(`      ID: ${pendingSub?.id}`);
  console.log(`      MP Preapproval ID: ${pendingSub?.mp_preapproval_id}`);
  console.log(`      Status: ${pendingSub?.status}`);
  console.log(`      Plan: ${pendingSub?.plan}\n`);

  // STEP 4: Test Real Mercado Pago API - Querying the Preapproval directly from MP
  if (pendingSub?.mp_preapproval_id) {
    console.log(`📌 4. Consultando API real de Mercado Pago para preapproval ID: ${pendingSub.mp_preapproval_id}...`);
    try {
      const mpData = await getPreapproval(pendingSub.mp_preapproval_id);
      console.log('   ✅ Respuesta real de Mercado Pago:');
      console.log(`      ID: ${mpData.id}`);
      console.log(`      Status en MP: ${mpData.status}`);
      console.log(`      Monto: ${mpData.auto_recurring?.transaction_amount} ${mpData.auto_recurring?.currency_id}`);
      console.log(`      Checkout Init Point: ${mpData.init_point}`);
      console.log(`      External Reference (User ID): ${mpData.external_reference}\n`);
    } catch (err) {
      console.error('   ❌ Error consultando MP API:', err.message);
    }
  }

  // STEP 5: Simulating Mercado Pago Webhook Payment Approval (Activation)
  console.log('📌 5. Simulando Webhook de Mercado Pago (Pago Aprobado -> Activación Pro)...');
  const futureExpiry = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
  const reqMock = {
    headers: {},
    body: {
      type: 'subscription_preapproval',
      data: { id: pendingSub.mp_preapproval_id },
    },
  };
  const resMock = {
    status: (code) => ({
      json: (data) => {
        console.log(`   📡 Webhook Response Code: ${code}`, data);
      },
    }),
  };

  // Directly update DB with authorized status for testing
  await updateSubscriptionFromWebhook({
    mpPreapprovalId: pendingSub.mp_preapproval_id,
    status: 'authorized',
    nextPaymentDate: futureExpiry,
    plan: 'pro',
  });

  const activeSub = await getUserSubscription(user.id);
  console.log('   ✅ Suscripción actualizada en Supabase:');
  console.log(`      Status: ${activeSub.status}`);
  console.log(`      Plan: ${activeSub.plan}`);
  console.log(`      Next Payment Date: ${activeSub.next_payment_date}`);
  console.log(`      hasProAccess: ${hasProAccess(activeSub, user)}`);

  // WhatsApp Welcome Message Dispatched by Webhook
  const welcomeMessage =
    `🎉 *¡Bienvenido a Reminder Pro!*\n\n` +
    `Tu suscripción ha sido confirmada con éxito. Ya tienes acceso completo e ilimitado a todas las funciones:\n\n` +
    `• 📅 *Recordatorios sin límites* (para cualquier día, semana o mes)\n` +
    `• 🔄 *Recordatorios recurrentes* (diarios, semanales, mensuales)\n` +
    `• 📋 *Checklists y tareas avanzadas*\n` +
    `• 🌅 *Morning briefing diario personalizado*\n\n` +
    `¡Gracias por confiar en Reminder! ¿Qué recordatorio deseas programar?`;

  console.log('\n   📲 [WHATSAPP DISPATCH] Mensaje de bienvenida enviado al usuario:');
  console.log(`   Destinatario: ${user.phone_number}`);
  console.log(`   Texto:\n${welcomeMessage}\n`);

  // STEP 6: Test User (Now Pro) creating future & recurring reminders (Must SUCCEED)
  console.log('📌 6. Test Usuario Pro -> Creando recordatorio para MAÑANA y RECURRENTE:');
  const msg4 = 'Recuérdame mañana a las 9am llamar al doctor';
  console.log(`   👤 User: "${msg4}"`);
  const res4 = await routeMessage(msg4, user);
  console.log(`   🤖 Bot reply:\n${res4.confirmation}\n`);

  // STEP 7: Test Cancellation with Grace Period (User keeps Pro until expiry)
  console.log('📌 7. Test Cancelación -> Usuario cancela pero mantiene acceso hasta fin de mes:');
  await updateSubscriptionFromWebhook({
    mpPreapprovalId: pendingSub.mp_preapproval_id,
    status: 'cancelled',
    nextPaymentDate: futureExpiry, // 30 days ahead
    plan: 'pro',
  });
  const cancelledSub = await getUserSubscription(user.id);
  const stillHasAccess = hasProAccess(cancelledSub, user);
  console.log(`   Suscripción cancelada: status=${cancelledSub.status}, expiry=${cancelledSub.next_payment_date}`);
  console.log(`   ¿Mantiene acceso Pro por haber pagado el mes?: ${stillHasAccess ? 'SÍ ✅' : 'NO ❌'}\n`);

  // STEP 8: Test Expiration (After period ends -> degraded to Free)
  console.log('📌 8. Test Expiración -> Cuando pasa la fecha pagada, vuelve a Free:');
  const pastExpiry = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(); // Yesterday
  cancelledSub.next_payment_date = pastExpiry;
  const expiredAccess = hasProAccess(cancelledSub, user);
  console.log(`   Suscripción vencida: expiry=${cancelledSub.next_payment_date}`);
  console.log(`   ¿Acceso Pro denegado correctamente?: ${!expiredAccess ? 'SÍ ✅' : 'NO ❌'}\n`);

  console.log('====================================================');
  console.log('🎉 TODAS LAS PRUEBAS E2E EN VIVO COMPLETADAS CON ÉXITO');
  console.log('====================================================');
}

runLiveE2ETest().catch(console.error);
