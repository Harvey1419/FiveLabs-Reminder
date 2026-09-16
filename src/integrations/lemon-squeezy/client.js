import crypto from 'crypto';

export const LEMON_SQUEEZY_DEFAULT_CHECKOUT_URL =
  'https://hermes-templelabs.lemonsqueezy.com/checkout/buy/80fd049b-c823-4446-9c7e-cf34373e53b9?media=0&discount=0';

/**
 * Validate HMAC-SHA256 signature from Lemon Squeezy webhook request.
 *
 * @param {import('express').Request} req
 * @returns {boolean}
 */
export function verifyLemonSqueezySignature(req) {
  const secret = process.env.LEMON_SQUEEZY_WEBHOOK_SECRET;
  if (!secret) {
    // If webhook secret not configured in dev/sandbox, permit request
    return true;
  }

  const signature = req.headers['x-signature'];
  if (!signature) {
    return false;
  }

  try {
    const rawBody = req.rawBody
      ? req.rawBody
      : (typeof req.body === 'string' ? req.body : JSON.stringify(req.body || {}));

    const hmac = crypto.createHmac('sha256', secret);
    const digest = Buffer.from(hmac.update(rawBody).digest('hex'), 'utf8');
    const sigBuf = Buffer.from(String(signature), 'utf8');

    if (digest.length !== sigBuf.length) {
      return false;
    }

    return crypto.timingSafeEqual(digest, sigBuf);
  } catch (err) {
    console.error('[lemon-squeezy] Signature validation error:', err.message);
    return false;
  }
}

/**
 * Build a canonical Lemon Squeezy checkout URL embedding customer identity.
 *
 * @param {object} params
 * @param {string} [params.userId]
 * @param {string} [params.phoneNumber]
 * @param {string} [params.email]
 * @returns {string}
 */
export function buildLemonSqueezyCheckoutUrl({ userId = null, phoneNumber = null, email = null } = {}) {
  const rawBase = process.env.LEMON_SQUEEZY_CHECKOUT_URL || LEMON_SQUEEZY_DEFAULT_CHECKOUT_URL;

  try {
    const url = new URL(rawBase);
    if (userId) {
      url.searchParams.set('checkout[custom][user_id]', String(userId).trim());
    }
    if (phoneNumber) {
      url.searchParams.set('checkout[custom][phone]', String(phoneNumber).trim());
    }
    if (email) {
      url.searchParams.set('checkout[email]', String(email).trim());
    }
    return url.toString();
  } catch {
    return rawBase;
  }
}
