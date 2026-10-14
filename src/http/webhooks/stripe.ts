import { verifyStripeSignature } from '../../integrations/stripe/client.js';
import { supabase } from '../../infrastructure/database/index.js';
import { normalizeUserPhone } from '../../infrastructure/database/users.js';
import { sendWhatsAppText, sendWhatsAppTemplate } from '../../integrations/whatsapp/kapso-client.js';

import { createStripeWebhook } from './stripe-handler.js';

const handler = createStripeWebhook({ getClient: () => supabase as unknown as ReturnType<Parameters<typeof createStripeWebhook>[0]['getClient']>, normalizeUserPhone: normalizeUserPhone as unknown as Parameters<typeof createStripeWebhook>[0]['normalizeUserPhone'], verifySignature: verifyStripeSignature as unknown as Parameters<typeof createStripeWebhook>[0]['verifySignature'], getNow: () => new Date(), getNowMs: () => Date.now(), sendWhatsAppText: sendWhatsAppText as unknown as Parameters<typeof createStripeWebhook>[0]['sendWhatsAppText'], sendWhatsAppTemplate: sendWhatsAppTemplate as unknown as Parameters<typeof createStripeWebhook>[0]['sendWhatsAppTemplate'], logger: console});
export function handleStripeWebhook(...args: Parameters<typeof handler.handleStripeWebhook>) { return handler.handleStripeWebhook(...args); }


