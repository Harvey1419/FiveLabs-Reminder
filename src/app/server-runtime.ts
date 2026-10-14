import type { ServerDependencies } from './server-ports.js';
/** Explicit startup boundary; construction/import of ports starts no listener or worker. */
export async function startExpressServer({ createApp, staticMiddleware, jsonMiddleware, handleWebhook, processWebhookMessage, assertInboundQueueReady, startInboundTurnWorker, handleStripeWebhook, handleGoogleCalendarWebhook, buildStripeCheckoutUrl, googleAuthRouter, renderSubscriptionSuccessPage, renderPrivacyPolicyPage, renderTermsOfServicePage, renderHomePage, startScheduler, startMorningBriefingWorker, startCalendarWatchWorker, getEnv, once, exit, setTimeout, clearTimeout, logger }: ServerDependencies) {
const app = createApp();

// Validate critical environment variables on boot
const requiredEnvs = ['SUPABASE_URL', 'SUPABASE_SECRET', 'KAPSO_API_KEY', 'OPENROUTER_API_KEY'];
const missingEnvs = requiredEnvs.filter(key => !getEnv()[key]);
if (missingEnvs.length > 0) {
  throw new Error(`Missing required environment variables: ${missingEnvs.join(', ')}`);
}

// Serve static assets from public/ (brand logo, favicon, etc.)
app.use(staticMiddleware('public'));

app.use(jsonMiddleware({
  limit: '2mb',
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
    if (token === getEnv().KAPSO_WEBHOOK_VERIFY_TOKEN) {
      logger.log('[webhook] Webhook verification successful');
      return res.status(200).send(challenge);
    } else {
      logger.warn('[webhook] Verification failed: invalid verify token');
      return res.status(403).send('Forbidden: Invalid Verify Token');
    }
  }

  // 2. Direct browser check
  res.status(200).send('Webhook endpoint is active and waiting for WhatsApp events.');
});

app.post('/webhook', handleWebhook);

// Stripe Webhook Endpoint
app.post('/webhooks/stripe', handleStripeWebhook);

// Google Calendar Push Notification Webhook Endpoint
app.post('/webhooks/google-calendar', handleGoogleCalendarWebhook);

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

const PORT = getEnv().PORT || 3005;

// Fail before Railway considers the new deployment healthy if its migration is absent.
await assertInboundQueueReady();
app.get('/health', (_req, res) => res.status(200).json({ status: 'ok' }));

// Start the HTTP server in every environment.
const server = app.listen(PORT, () => {
  logger.log(`Server running on port ${PORT}`);
});
const inboundWorker = startInboundTurnWorker(processWebhookMessage);

let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  server.close();
  // Railway may terminate earlier; leased turns remain durable and cannot be replayed.
  const deadline = setTimeout(() => exit(1), 25000);
  deadline.unref();
  await inboundWorker.stop();
  clearTimeout(deadline);
  exit(0);
}
once('SIGTERM', shutdown);
once('SIGINT', shutdown);

// Foreground workers coordinate through Postgres in every environment.
// Scheduled jobs run only on production hosts.
const isBackgroundWorkerHost = getEnv().NODE_ENV === 'production'
  || Boolean(getEnv().RAILWAY_ENVIRONMENT_ID);

if (isBackgroundWorkerHost) {
  startScheduler().catch(logger.error);
  startMorningBriefingWorker();
  startCalendarWatchWorker();
} else {
  logger.log('[workers] local HTTP process connected to shared queue; background jobs remain on Railway');
}

return { app, server, inboundWorker, shutdown };
}
