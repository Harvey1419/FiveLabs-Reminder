import 'dotenv/config';
import express from 'express';
import { handleWebhook } from './webhook.js';
import { handleMercadoPagoWebhook } from './webhooks/mercadopagoWebhook.js';
import { startScheduler } from './scheduler.js';
import { startMorningBriefingWorker } from './workers/morningBriefing.js';

const app = express();

// Validate critical environment variables on boot
const requiredEnvs = ['SUPABASE_URL', 'SUPABASE_SECRET', 'KAPSO_API_KEY', 'GEMINI_API_KEY'];
const missingEnvs = requiredEnvs.filter(key => !process.env[key]);
if (missingEnvs.length > 0) {
  console.warn(`\n⚠️  [CONFIG WARNING] Missing required environment variables: ${missingEnvs.join(', ')}`);
  console.warn(`👉 Please configure them in your Railway Dashboard -> "Variables" tab.\n`);
}

// Parse json with rawBody preserved for HMAC-SHA256 signature validation
app.use(express.json({
  limit: '10mb',
  verify: (req, res, buf) => {
    req.rawBody = buf;
  },
}));

// Root health check for browser visits
app.get('/', (req, res) => {
  res.status(200).send('🚀 Reminder WhatsApp Bot Service is running.');
});

// Webhook verification endpoint (Meta / Kapso standard)
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  // 1. Kapso / Meta Webhook Verification handshake
  if (mode === 'subscribe') {
    if (token === process.env.KAPSO_WEBHOOK_VERIFY_TOKEN) {
      console.log('[webhook] Webhook verification successful');
      return res.status(200).send(challenge);
    } else {
      console.warn(`[webhook] Verification failed. Received token "${token}", expected "${process.env.KAPSO_WEBHOOK_VERIFY_TOKEN}"`);
      return res.status(403).send('Forbidden: Invalid Verify Token');
    }
  }

  // 2. Direct browser check
  res.status(200).send('Webhook endpoint is active and waiting for WhatsApp events.');
});

app.post('/webhook', handleWebhook);

// MercadoPago Webhook Endpoint
app.post('/webhooks/mercadopago', handleMercadoPagoWebhook);

// Subscription Callback Return Page (Browser redirect after payment)
app.get('/subscription/callback', (req, res) => {
  res.status(200).send(`
    <!DOCTYPE html>
    <html lang="es">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <title>Suscripción Completada - Reminder</title>
        <style>
          body { font-family: system-ui, -apple-system, sans-serif; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; background: #0f172a; color: #f8fafc; }
          .card { background: #1e293b; padding: 2rem; border-radius: 1rem; text-align: center; max-width: 420px; border: 1px solid #334155; box-shadow: 0 20px 25px -5px rgba(0, 0, 0, 0.5); }
          h1 { color: #38bdf8; margin-bottom: 0.5rem; }
          p { color: #94a3b8; line-height: 1.6; }
          .badge { display: inline-block; background: #10b981; color: white; padding: 0.25rem 0.75rem; border-radius: 9999px; font-weight: bold; margin-bottom: 1rem; }
        </style>
      </head>
      <body>
        <div class="card">
          <div class="badge">PRO ACTIVADO</div>
          <h1>¡Gracias por suscribirte!</h1>
          <p>Tu cuenta ha sido actualizada a <strong>Reminder Pro</strong>. Ya puedes regresar a WhatsApp y disfrutar de todos los recordatorios y funciones sin límites.</p>
        </div>
      </body>
    </html>
  `);
});

const PORT = process.env.PORT || 3005;

// Start server, scheduler, and morning briefing worker
const server = app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

// Start background workers
startScheduler().catch(console.error);
startMorningBriefingWorker();
