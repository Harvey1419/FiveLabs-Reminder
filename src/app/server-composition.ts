import { createRequire } from 'node:module';
const express = createRequire(import.meta.url)('express') as { (): import('./server-ports.js').ExpressApp; static(path: string): unknown; json(options: Parameters<import('./server-ports.js').ServerDependencies['jsonMiddleware']>[0]): unknown };
import { handleWebhook, processWebhookMessage } from '../http/webhooks/whatsapp.js';
import { assertInboundQueueReady } from '../infrastructure/database/inbound-turns.js';
import { startInboundTurnWorker } from '../jobs/inbound-turn-worker.js';
import { handleStripeWebhook } from '../http/webhooks/stripe.js';
import { handleGoogleCalendarWebhook } from '../http/webhooks/google-calendar.js';
import { buildStripeCheckoutUrl } from '../integrations/stripe/client.js';
import { googleAuthRouter } from '../http/routes/google-auth.js';
import { renderSubscriptionSuccessPage } from '../http/views/landing.js';
import { renderPrivacyPolicyPage, renderTermsOfServicePage } from '../http/views/legal.js';
import { renderHomePage } from '../http/views/home.js';
import { startScheduler } from '../jobs/reminder-scheduler.js';
import { startMorningBriefingWorker } from '../jobs/morning-briefing.js';
import { startCalendarWatchWorker } from '../jobs/calendar-watch-renewal.js';

import { startExpressServer } from './server-runtime.js';
import type { ServerDependencies } from './server-ports.js';
export function createServerDependencies(): ServerDependencies { return { createApp: () => express(), staticMiddleware: ((...args: Parameters<typeof express.static>) => express.static(...args)) as unknown as Parameters<typeof startExpressServer>[0]['staticMiddleware'], jsonMiddleware: ((...args: Parameters<typeof express.json>) => express.json(...args)) as unknown as Parameters<typeof startExpressServer>[0]['jsonMiddleware'],
  handleWebhook: ((...args: Parameters<typeof handleWebhook>) => handleWebhook(...args)) as unknown as Parameters<typeof startExpressServer>[0]['handleWebhook'],
  processWebhookMessage: ((...args: Parameters<typeof processWebhookMessage>) => processWebhookMessage(...args)) as unknown as Parameters<typeof startExpressServer>[0]['processWebhookMessage'],
  assertInboundQueueReady: ((...args: Parameters<typeof assertInboundQueueReady>) => assertInboundQueueReady(...args)) as unknown as Parameters<typeof startExpressServer>[0]['assertInboundQueueReady'],
  startInboundTurnWorker: ((...args: Parameters<typeof startInboundTurnWorker>) => startInboundTurnWorker(...args)) as unknown as Parameters<typeof startExpressServer>[0]['startInboundTurnWorker'],
  handleStripeWebhook: ((...args: Parameters<typeof handleStripeWebhook>) => handleStripeWebhook(...args)) as unknown as Parameters<typeof startExpressServer>[0]['handleStripeWebhook'],
  handleGoogleCalendarWebhook: ((...args: Parameters<typeof handleGoogleCalendarWebhook>) => handleGoogleCalendarWebhook(...args)) as unknown as Parameters<typeof startExpressServer>[0]['handleGoogleCalendarWebhook'],
  buildStripeCheckoutUrl: ((...args: Parameters<typeof buildStripeCheckoutUrl>) => buildStripeCheckoutUrl(...args)) as unknown as Parameters<typeof startExpressServer>[0]['buildStripeCheckoutUrl'],
  googleAuthRouter: googleAuthRouter as unknown as Parameters<typeof startExpressServer>[0]['googleAuthRouter'],
  renderSubscriptionSuccessPage: ((...args: Parameters<typeof renderSubscriptionSuccessPage>) => renderSubscriptionSuccessPage(...args)) as unknown as Parameters<typeof startExpressServer>[0]['renderSubscriptionSuccessPage'],
  renderPrivacyPolicyPage: ((...args: Parameters<typeof renderPrivacyPolicyPage>) => renderPrivacyPolicyPage(...args)) as unknown as Parameters<typeof startExpressServer>[0]['renderPrivacyPolicyPage'],
  renderTermsOfServicePage: ((...args: Parameters<typeof renderTermsOfServicePage>) => renderTermsOfServicePage(...args)) as unknown as Parameters<typeof startExpressServer>[0]['renderTermsOfServicePage'],
  renderHomePage: ((...args: Parameters<typeof renderHomePage>) => renderHomePage(...args)) as unknown as Parameters<typeof startExpressServer>[0]['renderHomePage'],
  startScheduler: ((...args: Parameters<typeof startScheduler>) => startScheduler(...args)) as unknown as Parameters<typeof startExpressServer>[0]['startScheduler'],
  startMorningBriefingWorker: ((...args: Parameters<typeof startMorningBriefingWorker>) => startMorningBriefingWorker(...args)) as unknown as Parameters<typeof startExpressServer>[0]['startMorningBriefingWorker'],
  startCalendarWatchWorker: ((...args: Parameters<typeof startCalendarWatchWorker>) => startCalendarWatchWorker(...args)) as unknown as Parameters<typeof startExpressServer>[0]['startCalendarWatchWorker'],
  getEnv: () => process.env, once: ((...args: Parameters<typeof process.once>) => process.once(...args)) as unknown as Parameters<typeof startExpressServer>[0]['once'], exit: ((...args: Parameters<typeof process.exit>) => process.exit(...args)) as unknown as Parameters<typeof startExpressServer>[0]['exit'],
  setTimeout: ((...args: Parameters<typeof setTimeout>) => setTimeout(...args)) as unknown as Parameters<typeof startExpressServer>[0]['setTimeout'], clearTimeout: ((...args: Parameters<typeof clearTimeout>) => clearTimeout(...args)) as unknown as Parameters<typeof startExpressServer>[0]['clearTimeout'], logger: console,
}; }

export function startApplication(overrides: Partial<ServerDependencies> = {}) { return startExpressServer({ ...createServerDependencies(), ...overrides }); }
