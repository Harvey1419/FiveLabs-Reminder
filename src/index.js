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
        <title>¡Suscripción Exitosa! — FiveLabs Reminder Pro</title>
        <link rel="preconnect" href="https://fonts.googleapis.com">
        <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
        <link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&display=swap" rel="stylesheet">
        <style>
          * { box-sizing: border-box; margin: 0; padding: 0; }
          body {
            font-family: 'Plus Jakarta Sans', system-ui, -apple-system, sans-serif;
            display: flex;
            align-items: center;
            justify-content: center;
            min-height: 100vh;
            background: radial-gradient(circle at top center, #1e1b4b 0%, #090d16 100%);
            color: #f8fafc;
            padding: 1.5rem;
          }
          .container {
            background: rgba(30, 41, 59, 0.7);
            backdrop-filter: blur(16px);
            -webkit-backdrop-filter: blur(16px);
            border: 1px solid rgba(255, 255, 255, 0.1);
            border-radius: 1.5rem;
            padding: 2.5rem 2rem;
            text-align: center;
            max-width: 440px;
            width: 100%;
            box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.7), 0 0 40px rgba(16, 185, 129, 0.15);
            animation: fadeIn 0.6s cubic-bezier(0.16, 1, 0.3, 1);
          }
          @keyframes fadeIn {
            from { opacity: 0; transform: translateY(20px) scale(0.96); }
            to { opacity: 1; transform: translateY(0) scale(1); }
          }
          .icon-wrapper {
            width: 80px;
            height: 80px;
            background: linear-gradient(135deg, #10b981 0%, #059669 100%);
            border-radius: 50%;
            display: flex;
            align-items: center;
            justify-content: center;
            margin: 0 auto 1.5rem;
            box-shadow: 0 0 30px rgba(16, 185, 129, 0.4);
            animation: pulse 2s infinite;
          }
          @keyframes pulse {
            0%, 100% { transform: scale(1); box-shadow: 0 0 30px rgba(16, 185, 129, 0.4); }
            50% { transform: scale(1.05); box-shadow: 0 0 45px rgba(16, 185, 129, 0.6); }
          }
          .icon-wrapper svg {
            width: 44px;
            height: 44px;
            stroke: #ffffff;
            stroke-width: 2.5;
          }
          .badge {
            display: inline-flex;
            align-items: center;
            gap: 0.35rem;
            background: rgba(16, 185, 129, 0.15);
            color: #34d399;
            border: 1px solid rgba(52, 211, 153, 0.3);
            padding: 0.35rem 0.85rem;
            border-radius: 9999px;
            font-size: 0.8rem;
            font-weight: 700;
            letter-spacing: 0.05em;
            text-transform: uppercase;
            margin-bottom: 1rem;
          }
          h1 {
            font-size: 1.75rem;
            font-weight: 800;
            color: #ffffff;
            margin-bottom: 0.75rem;
            letter-spacing: -0.02em;
          }
          p {
            color: #94a3b8;
            font-size: 0.95rem;
            line-height: 1.6;
            margin-bottom: 1.75rem;
          }
          .features {
            background: rgba(15, 23, 42, 0.6);
            border: 1px solid rgba(255, 255, 255, 0.05);
            border-radius: 1rem;
            padding: 1.25rem 1rem;
            text-align: left;
            margin-bottom: 2rem;
          }
          .feature-item {
            display: flex;
            align-items: center;
            gap: 0.75rem;
            color: #e2e8f0;
            font-size: 0.875rem;
            font-weight: 500;
            margin-bottom: 0.75rem;
          }
          .feature-item:last-child {
            margin-bottom: 0;
          }
          .feature-item span {
            font-size: 1.1rem;
          }
          .btn-whatsapp {
            display: inline-flex;
            align-items: center;
            justify-content: center;
            gap: 0.6rem;
            width: 100%;
            background: linear-gradient(135deg, #25D366 0%, #128C7E 100%);
            color: #ffffff;
            font-size: 1rem;
            font-weight: 700;
            padding: 1rem 1.5rem;
            border-radius: 0.875rem;
            text-decoration: none;
            box-shadow: 0 10px 25px -5px rgba(37, 211, 102, 0.4);
            transition: all 0.2s ease;
          }
          .btn-whatsapp:hover {
            transform: translateY(-2px);
            box-shadow: 0 15px 30px -5px rgba(37, 211, 102, 0.5);
          }
          .btn-whatsapp svg {
            width: 22px;
            height: 22px;
            fill: currentColor;
          }
          .footer {
            margin-top: 1.5rem;
            font-size: 0.75rem;
            color: #64748b;
          }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="icon-wrapper">
            <svg fill="none" viewBox="0 0 24 24" stroke-linecap="round" stroke-linejoin="round">
              <polyline points="20 6 9 17 4 12"></polyline>
            </svg>
          </div>
          <div class="badge">🌟 Reminder Pro Activo</div>
          <h1>¡Pago Confirmado!</h1>
          <p>Tu suscripción se ha procesado con éxito. Tu segundo cerebro ahora tiene superpoderes sin restricciones.</p>
          
          <div class="features">
            <div class="feature-item"><span>📅</span> Recordatorios para cualquier día y hora</div>
            <div class="feature-item"><span>🔄</span> Recurrencias automáticas e intervalos</div>
            <div class="feature-item"><span>🌅</span> Morning briefing matutino en WhatsApp</div>
            <div class="feature-item"><span>🔔</span> Insistencia inteligente y confirmaciones</div>
          </div>

          <a href="https://api.whatsapp.com/send" class="btn-whatsapp">
            <svg viewBox="0 0 24 24">
              <path d="M.057 24l1.687-6.163c-1.041-1.804-1.588-3.849-1.587-5.946.003-6.556 5.338-11.891 11.893-11.891 3.181.001 6.167 1.24 8.413 3.488 2.245 2.248 3.481 5.236 3.48 8.414-.003 6.557-5.338 11.892-11.893 11.892-1.99-.001-3.951-.5-5.688-1.448l-6.305 1.654zm6.597-3.807c1.676.995 3.276 1.591 5.392 1.592 5.448 0 9.886-4.434 9.889-9.885.002-5.462-4.415-9.89-9.881-9.892-5.452 0-9.887 4.434-9.889 9.884-.001 2.225.651 3.891 1.746 5.634l-.999 3.648 3.742-.981zm11.387-5.464c-.074-.124-.272-.198-.57-.347-.297-.149-1.758-.868-2.031-.967-.272-.099-.47-.149-.669.149-.198.297-.768.967-.941 1.165-.173.198-.347.223-.644.074-.297-.149-1.255-.462-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.297-.347.446-.521.151-.172.2-.296.3-.495.099-.198.05-.372-.025-.521-.075-.148-.669-1.611-.916-2.206-.242-.579-.487-.501-.669-.51l-.57-.01c-.198 0-.52.074-.792.372s-1.04 1.016-1.04 2.479 1.065 2.876 1.213 3.074c.149.198 2.095 3.2 5.076 4.487.709.306 1.263.489 1.694.626.712.226 1.36.194 1.872.118.571-.085 1.758-.719 2.006-1.413.248-.695.248-1.29.173-1.414z"/>
            </svg>
            Volver a WhatsApp
          </a>
          <div class="footer">FiveLabs Reminder Assistant • Todos los derechos reservados</div>
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
