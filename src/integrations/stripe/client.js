import crypto from 'crypto';

export const STRIPE_DEFAULT_CHECKOUT_URL =
  'https://buy.stripe.com/8x2dR9dZsez51usg3A73G03';

/**
 * Build a canonical Stripe Payment Link embedding customer reference and language.
 *
 * Supported query parameters for Stripe Payment Links:
 * - client_reference_id: identifies user in checkout.session.completed webhook
 * - prefilled_email: pre-populates email field
 * - locale: forces user interface language ('es' or 'en')
 *
 * @param {object} params
 * @param {string} [params.userId]
 * @param {string} [params.phoneNumber]
 * @param {string} [params.email]
 * @param {string} [params.language]
 * @returns {string}
 */
export function buildStripeCheckoutUrl({
  userId = null,
  phoneNumber = null,
  email = null,
  language = 'es',
} = {}) {
  const rawBase = process.env.STRIPE_CHECKOUT_URL || STRIPE_DEFAULT_CHECKOUT_URL;

  try {
    const url = new URL(rawBase);

    if (userId) {
      url.searchParams.set('client_reference_id', String(userId).trim());
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

/**
 * Validate HMAC-SHA256 signature from Stripe webhook request.
 *
 * Stripe signature format:
 *   t=1492774577,v1=5257a869e7ecebeda32affa62cd323080cd477e62cf51e299a008645f1336dd1
 *
 * @param {import('express').Request} req
 * @param {number} [toleranceSeconds=300]
 * @returns {boolean}
 */
export function verifyStripeSignature(req, toleranceSeconds = 300) {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
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
    let timestamp = null;
    const signatures = [];

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
    const now = Math.floor(Date.now() / 1000);
    if (Math.abs(now - timestamp) > toleranceSeconds) {
      console.warn('[stripe] Webhook signature timestamp exceeds tolerance window');
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
    console.error('[stripe] Signature validation error:', err.message);
    return false;
  }
}
