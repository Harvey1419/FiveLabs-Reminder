import 'dotenv/config';
import express from 'express';
import { handleWebhook } from './webhook.js';
import { startScheduler } from './scheduler.js';
import { startMorningBriefingWorker } from './workers/morningBriefing.js';

const app = express();

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

const PORT = process.env.PORT || 3005;

// Start server, scheduler, and morning briefing worker
const server = app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

// Start background workers
startScheduler().catch(console.error);
startMorningBriefingWorker();
