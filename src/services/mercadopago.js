import crypto from 'crypto';

const MP_API_BASE = 'https://api.mercadopago.com';

/**
 * Get configured MercadoPago access token.
 */
function getAccessToken() {
  const token = process.env.MP_ACCESS_TOKEN;
  if (!token) {
    console.warn('[mercadopago] MP_ACCESS_TOKEN is not configured.');
  }
  return token;
}

let cachedCanonicalPlan = null;

/**
 * Get existing active plan or create one canonically (Idempotent single plan pattern).
 *
 * @param {object} [params]
 * @param {string} [params.reason='FiveLabs Reminder Pro']
 * @param {number} [params.amount=49900]
 * @param {string} [params.currency='COP']
 * @param {string} [params.backUrl]
 * @returns {Promise<{id: string, init_point: string, status: string}>}
 */
export async function getOrCreateCanonicalPlan({
  reason = 'FiveLabs Reminder Pro',
  amount = 49900,
  currency = 'COP',
  backUrl = null,
} = {}) {
  if (process.env.MP_PLAN_ID) {
    return {
      id: process.env.MP_PLAN_ID,
      init_point: `https://www.mercadopago.com.co/subscriptions/checkout?preapproval_plan_id=${process.env.MP_PLAN_ID}`,
      status: 'active',
    };
  }

  if (cachedCanonicalPlan) {
    return cachedCanonicalPlan;
  }

  const token = getAccessToken();
  if (token) {
    try {
      const res = await fetch(`${MP_API_BASE}/preapproval_plan/search?status=active`, {
        headers: { 'Authorization': `Bearer ${token}` },
      });
      const data = await res.json();
      const existing = (data.results || []).find(p =>
        (p.reason === reason || p.reason?.includes('Reminder Pro')) &&
        p.auto_recurring?.transaction_amount === Number(amount)
      );

      if (existing) {
        cachedCanonicalPlan = {
          id: existing.id,
          init_point: existing.init_point,
          status: existing.status,
        };
        console.log(`[mercadopago] Reusing canonical active plan: ${existing.id} (${existing.reason})`);
        return cachedCanonicalPlan;
      }
    } catch (err) {
      console.warn('[mercadopago] plan lookup warning:', err.message);
    }
  }

  const created = await createPreapprovalPlan({ reason, amount, currency, backUrl });
  cachedCanonicalPlan = created;
  return created;
}

/**
 * Create a recurring preapproval plan without locking payer_email.
 * Customers can subscribe and enter any email in the MercadoPago checkout.
 *
 * @param {object} [params]
 * @param {string} [params.reason='FiveLabs Reminder Pro']
 * @param {number} [params.amount=49900]
 * @param {string} [params.currency='COP']
 * @param {string} [params.backUrl]
 * @returns {Promise<{id: string, init_point: string, status: string}>}
 */
export async function createPreapprovalPlan({
  reason = 'FiveLabs Reminder Pro',
  amount = 49900,
  currency = 'COP',
  backUrl = null,
} = {}) {
  const token = getAccessToken();
  if (!token) {
    throw new Error('MercadoPago Access Token not configured (MP_ACCESS_TOKEN)');
  }

  const defaultBackUrl = process.env.APP_BASE_URL
    ? `${process.env.APP_BASE_URL.replace(/\/$/, '')}/subscription/callback`
    : 'https://fivelabs-reminder-production.up.railway.app/subscription/callback';

  const body = {
    reason,
    auto_recurring: {
      frequency: 1,
      frequency_type: 'months',
      transaction_amount: Number(amount),
      currency_id: currency,
    },
    back_url: backUrl || defaultBackUrl,
  };

  const response = await fetch(`${MP_API_BASE}/preapproval_plan`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  const data = await response.json();

  if (!response.ok) {
    console.error('[mercadopago] createPreapprovalPlan failed:', response.status, data);
    const errorMsg = data.message || data.error || JSON.stringify(data);
    throw new Error(`MercadoPago createPreapprovalPlan error (${response.status}): ${errorMsg}`);
  }

  return {
    id: data.id,
    init_point: data.init_point,
    status: data.status,
  };
}

/**
 * Create a recurring preapproval subscription with status 'pending' (checkout URL).
 *
 * @param {object} params
 * @param {string} params.userId - User UUID (stored in external_reference)
 * @param {string} [params.reason='FiveLabs Reminder Pro'] - Plan title shown to customer
 * @param {number} [params.amount=49900] - Subscription price per month (COP)
 * @param {string} [params.currency='COP'] - Currency code
 * @param {string} [params.backUrl] - Redirect URL after checkout completion
 * @param {string} [params.payerEmail] - Optional payer email
 * @returns {Promise<{id: string, init_point: string, status: string, external_reference: string}>}
 */
export async function createPreapproval({
  userId,
  phoneNumber = null,
  reason = 'FiveLabs Reminder Pro',
  amount = 49900,
  currency = 'COP',
  backUrl = null,
  payerEmail = null,
}) {
  const token = getAccessToken();
  if (!token) {
    throw new Error('MercadoPago Access Token not configured (MP_ACCESS_TOKEN)');
  }

  const defaultBackUrl = process.env.APP_BASE_URL
    ? `${process.env.APP_BASE_URL.replace(/\/$/, '')}/subscription/callback`
    : 'https://fivelabs-reminder-production.up.railway.app/subscription/callback';

  // MercadoPago requires a payer_email format string in the API payload.
  // The customer can change/confirm their actual personal email in the MercadoPago checkout UI.
  const cleanPhone = phoneNumber ? String(phoneNumber).replace(/\D/g, '') : '';
  const fallbackEmail = cleanPhone
    ? `user_${cleanPhone}@reminder.fivelabs.co`
    : `user_${String(userId).replace(/[^a-zA-Z0-9]/g, '').slice(0, 16)}@reminder.fivelabs.co`;
  const emailToUse = payerEmail || fallbackEmail;

  const body = {
    reason,
    external_reference: String(userId),
    payer_email: emailToUse,
    auto_recurring: {
      frequency: 1,
      frequency_type: 'months',
      transaction_amount: Number(amount),
      currency_id: currency,
    },
    back_url: backUrl || defaultBackUrl,
    status: 'pending',
  };

  const response = await fetch(`${MP_API_BASE}/preapproval`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  const data = await response.json();

  if (!response.ok) {
    console.error('[mercadopago] createPreapproval failed:', response.status, data);
    const errorMsg = data.message || data.error || JSON.stringify(data);
    throw new Error(`MercadoPago createPreapproval error (${response.status}): ${errorMsg}`);
  }

  return {
    id: data.id,
    init_point: data.init_point,
    status: data.status,
    external_reference: data.external_reference,
  };
}

/**
 * Fetch preapproval subscription status and next payment date from MercadoPago.
 *
 * @param {string} preapprovalId
 * @returns {Promise<object>}
 */
export async function getPreapproval(preapprovalId) {
  if (!preapprovalId) {
    throw new Error('preapprovalId is required');
  }

  const token = getAccessToken();
  if (!token) {
    throw new Error('MercadoPago Access Token not configured');
  }

  const response = await fetch(`${MP_API_BASE}/preapproval/${preapprovalId}`, {
    method: 'GET',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
  });

  const data = await response.json();

  if (!response.ok) {
    console.error('[mercadopago] getPreapproval failed:', response.status, data);
    throw new Error(`MercadoPago getPreapproval error (${response.status}): ${data.message || JSON.stringify(data)}`);
  }

  return data;
}

/**
 * Validate HMAC-SHA256 signature from MercadoPago webhook request.
 * Header format: ts=[timestamp],v1=[hash]
 *
 * @param {object} req - Express request
 * @returns {boolean}
 */
export function verifyWebhookSignature(req) {
  const secret = process.env.MP_WEBHOOK_SECRET;
  if (!secret) {
    // If webhook secret not configured in dev/sandbox, permit request
    return true;
  }

  const signatureHeader = req.headers['x-signature'];
  if (!signatureHeader) {
    return false;
  }

  // Parse ts and v1 from header: "ts=1700000000,v1=abcdef..."
  const parts = signatureHeader.split(',');
  let ts = null;
  let hash = null;

  for (const part of parts) {
    const [key, value] = part.trim().split('=');
    if (key === 'ts') ts = value;
    if (key === 'v1') hash = value;
  }

  if (!ts || !hash) {
    return false;
  }

  // MercadoPago manifest format: id:[data.id_url];request-id:[x-request-id];ts:[ts];
  // Or direct payload HMAC validation:
  const dataId = req.query?.['data.id'] || req.body?.data?.id || req.body?.id || '';
  const requestId = req.headers['x-request-id'] || '';

  const manifest = `id:${dataId};request-id:${requestId};ts:${ts};`;
  const expectedHash = crypto
    .createHmac('sha256', secret)
    .update(manifest)
    .digest('hex');

  try {
    const a = Buffer.from(hash, 'utf8');
    const b = Buffer.from(expectedHash, 'utf8');
    if (a.length === b.length && crypto.timingSafeEqual(a, b)) {
      return true;
    }
  } catch {
    // Fallback to body digest if manifest format differed
  }

  // Direct raw body fallback validation:
  const rawBody = req.rawBody || Buffer.from(JSON.stringify(req.body || {}));
  const expectedBodyHash = crypto
    .createHmac('sha256', secret)
    .update(rawBody)
    .digest('hex');

  try {
    const a = Buffer.from(hash, 'utf8');
    const b = Buffer.from(expectedBodyHash, 'utf8');
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}
