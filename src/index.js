import 'dotenv/config';
import express from 'express';
import { handleWebhook } from './webhook.js';
import { handleMercadoPagoWebhook } from './webhooks/mercadopagoWebhook.js';
import { googleAuthRouter } from './routes/googleAuthRoutes.js';
import { renderSubscriptionSuccessPage } from './routes/views/landingTemplates.js';
import { renderPrivacyPolicyPage, renderTermsOfServicePage } from './routes/views/legalTemplates.js';
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

// Serve static assets from public/ (brand logo, favicon, etc.)
app.use(express.static('public'));

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

// Privacy Policy & Terms of Service (Required by Google OAuth Consent Screen)
app.get(['/privacy', '/politica-de-privacidad'], (req, res) => {
  res.status(200).send(renderPrivacyPolicyPage());
});

app.get(['/terms', '/terminos-y-condiciones'], (req, res) => {
  res.status(200).send(renderTermsOfServicePage());
});

// Google OAuth Routes
app.use('/auth/google', googleAuthRouter);

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
  const theme = req.query.theme || 'obsidian';
  res.status(200).send(renderSubscriptionSuccessPage({ theme }));
});

const PORT = process.env.PORT || 3005;

// Start server, scheduler, and morning briefing worker
const server = app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

// Start background workers
startScheduler().catch(console.error);
startMorningBriefingWorker();
