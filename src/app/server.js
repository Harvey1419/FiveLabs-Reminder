import 'dotenv/config';
import express from 'express';
import { handleWebhook } from '../http/webhooks/whatsapp.js';
import { handleMercadoPagoWebhook } from '../http/webhooks/mercado-pago.js';
import { handleLemonSqueezyWebhook } from '../http/webhooks/lemon-squeezy.js';
import { handleStripeWebhook } from '../http/webhooks/stripe.js';
import { buildStripeCheckoutUrl } from '../integrations/stripe/client.js';
import { googleAuthRouter } from '../http/routes/google-auth.js';
import { renderSubscriptionSuccessPage } from '../http/views/landing.js';
import { renderPrivacyPolicyPage, renderTermsOfServicePage } from '../http/views/legal.js';
import { renderHomePage } from '../http/views/home.js';
import { startScheduler } from '../jobs/reminder-scheduler.js';
import { startMorningBriefingWorker } from '../jobs/morning-briefing.js';

const app = express();

// Validate critical environment variables on boot
const requiredEnvs = ['SUPABASE_URL', 'SUPABASE_SECRET', 'KAPSO_API_KEY', 'OPENROUTER_API_KEY'];
const missingEnvs = requiredEnvs.filter(key => !process.env[key]);
if (missingEnvs.length > 0) {
  console.warn(`\n⚠️  [CONFIG WARNING] Missing required environment variables: ${missingEnvs.join(', ')}`);
  console.warn(`👉 Please configure them in your Railway Dashboard -> "Variables" tab.\n`);
}

// Serve static assets from public/ (brand logo, favicon, etc.)
app.use(express.static('public'));

app.use(express.json({
  limit: '10mb',
  verify: (req, res, buf) => {
    req.rawBody = buf;
  },
}));

// Public Home / Landing Page (Required by Google OAuth Verification)
app.get(['/', '/about', '/app'], (req, res) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.status(200).send(renderHomePage());
});

// Privacy Policy & Terms of Service (Required by Google OAuth Consent Screen)
app.get(['/privacy', '/politica-de-privacidad'], (req, res) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.status(200).send(renderPrivacyPolicyPage());
});

app.get(['/terms', '/terminos-y-condiciones'], (req, res) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
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
      console.warn('[webhook] Verification failed: invalid verify token');
      return res.status(403).send('Forbidden: Invalid Verify Token');
    }
  }

  // 2. Direct browser check
  res.status(200).send('Webhook endpoint is active and waiting for WhatsApp events.');
});

app.post('/webhook', handleWebhook);

// MercadoPago Webhook Endpoint
app.post('/webhooks/mercadopago', handleMercadoPagoWebhook);

// Lemon Squeezy Webhook Endpoint
app.post('/webhooks/lemonsqueezy', handleLemonSqueezyWebhook);

// Stripe Webhook Endpoint
app.post('/webhooks/stripe', handleStripeWebhook);

// Subscription Callback Return Page (Browser redirect after payment)
app.get('/subscription/callback', (req, res) => {
  const theme = req.query.theme || 'obsidian';
  res.status(200).send(renderSubscriptionSuccessPage({ theme }));
});

// Short billing redirect route
app.get(['/pay', '/pro'], (req, res) => {
  const ref = req.query.ref || req.query.u || req.query.userId || req.query.phone || req.query.p;
  const language = req.query.lang || (req.headers['accept-language']?.startsWith('en') ? 'en' : 'es');
  const destination = buildStripeCheckoutUrl({
    userId: ref,
    language,
  });
  return res.redirect(302, destination);
});

const PORT = process.env.PORT || 3005;

// Start the HTTP server in every environment.
const server = app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

// Railway is the single background-worker host. A local webhook process writes
// to the same Supabase queue and Railway consumes it, avoiding scheduler races
// while keeping local sandbox testing connected to the deployed worker.
const isBackgroundWorkerHost = process.env.NODE_ENV === 'production'
  || Boolean(process.env.RAILWAY_ENVIRONMENT_ID);

if (isBackgroundWorkerHost) {
  startScheduler().catch(console.error);
  startMorningBriefingWorker();
} else {
  console.log('[workers] local HTTP process connected to shared queue; background jobs remain on Railway');
}
