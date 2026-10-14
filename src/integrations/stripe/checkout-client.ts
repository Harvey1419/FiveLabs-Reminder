import crypto from 'node:crypto';

export const STRIPE_DEFAULT_CHECKOUT_URL =
  'https://buy.stripe.com/8x2dR9dZsez51usg3A73G03';

export interface CheckoutParameters {
  userId?: unknown;
  phoneNumber?: unknown;
  email?: unknown;
  language?: unknown;
  baseUrl?: unknown;
}
export interface WebhookRequest {
  headers?: Record<string, unknown>;
  rawBody?: unknown;
  body?: unknown;
}
export interface ClientDependencies {
  getEnvironment(): Readonly<Record<string, string | undefined>>;
  now(): number;
  logger: Pick<Console, 'warn' | 'error'>;
}

export function createStripeClient({ getEnvironment, now, logger }: ClientDependencies) {
  function buildStripeCheckoutUrl({
    userId = null,
    phoneNumber = null,
    email = null,
    language = 'es',
  }: CheckoutParameters = {}) {
    const rawBase = getEnvironment().STRIPE_CHECKOUT_URL || STRIPE_DEFAULT_CHECKOUT_URL;

    try {
      const url = new URL(rawBase);

      const clientRef = (userId && String(userId).trim()) || (phoneNumber && String(phoneNumber).trim()) || null;
      if (clientRef) {
        url.searchParams.set('client_reference_id', clientRef as string);
      } else {
        url.searchParams.delete('client_reference_id');
      }

      if (email) {
        url.searchParams.set('prefilled_email', String(email).trim().toLowerCase());
      }

      const targetLocale = String(language || 'es').toLowerCase().startsWith('en') ? 'en' : 'es';
      url.searchParams.set('locale', targetLocale);

      return url.toString();
    } catch {
      return rawBase;
    }
  }

  function getShortStripeCheckoutUrl({ userId = null, phoneNumber = null, baseUrl = null }: CheckoutParameters = {}) {
    // Type-only boundary: preserve native rejection of non-string base URLs.
    const appBase = ((baseUrl || getEnvironment().APP_BASE_URL || 'https://hermes.templelabs.co') as string).replace(/\/$/, '');
    const ref = (userId && String(userId).trim()) || (phoneNumber && String(phoneNumber).trim()) || null;
    return ref ? `${appBase}/pay?ref=${encodeURIComponent(ref as string)}` : `${appBase}/pay`;
  }

  function verifyStripeSignature(req: WebhookRequest, toleranceSeconds = 300) {
    const secret = getEnvironment().STRIPE_WEBHOOK_SECRET;
    if (!secret) {
      // If webhook secret not configured in dev/sandbox, permit request
      return true;
    }

    const sigHeader = req.headers ? req.headers['stripe-signature'] : null;
    if (!sigHeader) {
      return false;
    }

    try {
      const parts = String(sigHeader).split(',');
      let timestamp: number | null = null;
      const signatures: string[] = [];

      for (const part of parts) {
        const [key, ...rest] = part.trim().split('=');
        const val = rest.join('=');
        if (key === 't') {
          timestamp = parseInt(val, 10);
        } else if (key === 'v1' && val) {
          signatures.push(val);
        }
      }

      if (!timestamp || signatures.length === 0 || Number.isNaN(timestamp)) {
        return false;
      }

      // Verify timestamp tolerance against replay attacks
      const currentSeconds = Math.floor(now() / 1000);
      if (Math.abs(currentSeconds - timestamp) > toleranceSeconds) {
        logger.warn('[stripe] Webhook signature timestamp exceeds tolerance window');
        return false;
      }

      const rawBody = req.rawBody
        ? (Buffer.isBuffer(req.rawBody) ? req.rawBody.toString('utf8') : String(req.rawBody))
        : (typeof req.body === 'string' ? req.body : JSON.stringify(req.body || {}));

      const signedPayload = `${timestamp}.${rawBody}`;
      const expectedSignature = crypto
        .createHmac('sha256', secret)
        .update(signedPayload, 'utf8')
        .digest('hex');

      const expectedBuf = Buffer.from(expectedSignature, 'utf8');

      for (const sig of signatures) {
        const sigBuf = Buffer.from(sig, 'utf8');
        if (sigBuf.length === expectedBuf.length && crypto.timingSafeEqual(sigBuf, expectedBuf)) {
          return true;
        }
      }

      return false;
    } catch (err) {
      logger.error('[stripe] Signature validation error:', (err as Error).message);
      return false;
    }
  }
  return { buildStripeCheckoutUrl, getShortStripeCheckoutUrl, verifyStripeSignature };
}
