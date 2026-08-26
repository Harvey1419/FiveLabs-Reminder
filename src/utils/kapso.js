import { markAsProcessed } from '../webhook.js';

const KAPSO_API_BASE = 'https://api.kapso.ai/meta/whatsapp/v24.0';
const DEPRECATED_SANDBOX_ID = '597907523413541';
const PRODUCTION_PHONE_NUMBER_ID = '1248246475047194';

export class KapsoError extends Error {
  constructor(message, { status, code, data } = {}) {
    super(message);
    this.name = 'KapsoError';
    this.status = status;
    this.code = code;
    this.data = data;
  }
}

export class KapsoConfigurationError extends KapsoError {
  constructor(message) {
    super(message, { code: 'CONFIG_ERROR' });
    this.name = 'KapsoConfigurationError';
  }
}

export class KapsoAuthError extends KapsoError {
  constructor(message, status = 401) {
    super(message, { status, code: 'AUTH_ERROR' });
    this.name = 'KapsoAuthError';
  }
}

export class KapsoSandboxError extends KapsoError {
  constructor(message) {
    super(message, { status: 403, code: 'SANDBOX_EXPIRED' });
    this.name = 'KapsoSandboxError';
  }
}

export class KapsoRateLimitError extends KapsoError {
  constructor(message) {
    super(message, { status: 429, code: 'RATE_LIMIT' });
    this.name = 'KapsoRateLimitError';
  }
}

export class KapsoValidationError extends KapsoError {
  constructor(message, status = 400) {
    super(message, { status, code: 'VALIDATION_ERROR' });
    this.name = 'KapsoValidationError';
  }
}

/**
 * Clean phone number to E.164 without +, spaces, hyphens, or parentheses.
 */
export function normalizePhoneNumber(rawPhone) {
  if (!rawPhone || typeof rawPhone !== 'string') return null;
  const digits = rawPhone.replace(/\D/g, '');
  return digits.length >= 7 ? digits : null;
}

/**
 * Official Kapso WhatsApp sender following enterprise best practices:
 * - Uses `to` for valid E.164 phone numbers.
 * - Uses `recipient` exclusively for BSUIDs (e.g. CO.1552339023039755).
 * - Implements exponential backoff retry for temporary errors (429, 500, 502, 503, 504).
 * - Guard against legacy sandbox ID 597907523413541.
 *
 * @param {object} params
 * @param {string} [params.phoneNumberId]
 * @param {string|null} [params.phoneNumber]
 * @param {string|null} [params.bsuid]
 * @param {string} params.text
 * @returns {Promise<{success: boolean, messageId: string, recipientType: 'phone'|'bsuid', data: any}>}
 */
export async function sendWhatsAppText({
  phoneNumberId = null,
  phoneNumber = null,
  bsuid = null,
  text,
}) {
  const apiKey = process.env.KAPSO_API_KEY;
  if (!apiKey) {
    throw new KapsoConfigurationError('KAPSO_API_KEY is not configured in environment.');
  }

  let activePhoneId = String(phoneNumberId || process.env.KAPSO_PHONE_NUMBER_ID || PRODUCTION_PHONE_NUMBER_ID).trim();

  // Guard: Auto-route legacy sandbox ID to production phone ID
  if (activePhoneId === DEPRECATED_SANDBOX_ID) {
    console.warn(`[kapso] Notice: Detected legacy sandbox ID ${DEPRECATED_SANDBOX_ID}. Automatically routing to production phone ID ${PRODUCTION_PHONE_NUMBER_ID}.`);
    activePhoneId = PRODUCTION_PHONE_NUMBER_ID;
  }

  if (!text || typeof text !== 'string' || text.trim().length === 0) {
    throw new KapsoValidationError('Cannot send empty text message.');
  }

  const cleanPhone = normalizePhoneNumber(phoneNumber);
  const cleanBsuid = bsuid && typeof bsuid === 'string' && bsuid.trim().length > 0 ? bsuid.trim() : null;

  if (!cleanPhone && !cleanBsuid) {
    throw new KapsoValidationError('Incomplete recipient data: either phoneNumber or bsuid must be provided.');
  }

  // Build body strictly adhering to Kapso / Meta spec
  let payload;
  let recipientType;
  let targetDisplay;

  if (cleanPhone) {
    recipientType = 'phone';
    targetDisplay = cleanPhone;
    payload = {
      messaging_product: 'whatsapp',
      to: cleanPhone,
      type: 'text',
      text: { body: text },
    };
  } else {
    recipientType = 'bsuid';
    targetDisplay = cleanBsuid;
    payload = {
      messaging_product: 'whatsapp',
      recipient: cleanBsuid,
      type: 'text',
      text: { body: text },
    };
  }

  const endpoint = `${KAPSO_API_BASE}/${activePhoneId}/messages`;
  const maxRetries = 3;
  let attempt = 0;

  while (attempt <= maxRetries) {
    try {
      console.log(`[kapso] sending (${recipientType}) to ${targetDisplay}: "${text.slice(0, 50)}${text.length > 50 ? '...' : ''}" (attempt ${attempt + 1})`);

      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'X-API-Key': apiKey,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(15000),
      });

      if (response.ok) {
        const data = await response.json();
        const messageId = data.messages?.[0]?.id || 'unknown';

        if (messageId && messageId !== 'unknown') {
          markAsProcessed(messageId);
        }

        console.log(`[kapso] sent ok to=${targetDisplay} (${recipientType}) messageId=${messageId}`);
        return {
          success: true,
          messageId,
          recipientType,
          data,
        };
      }

      const errText = await response.text();
      const status = response.status;

      // Handle 403 Sandbox session expired
      if (status === 403 && errText.includes('Active sandbox session required')) {
        throw new KapsoSandboxError('Active sandbox session required to send messages. Please ensure you are using production phone_number_id.');
      }

      if (status === 401) {
        throw new KapsoAuthError('Invalid or unauthorized KAPSO_API_KEY.', status);
      }

      if (status === 400 || status === 404) {
        throw new KapsoValidationError(`Kapso API rejected request (HTTP ${status}): ${errText.slice(0, 150)}`, status);
      }

      // Retryable errors: 429, 500, 502, 503, 504
      const isRetryable = status === 429 || status >= 500;
      if (isRetryable && attempt < maxRetries) {
        attempt++;
        const delayMs = Math.pow(2, attempt) * 500;
        console.warn(`[kapso] temporary error HTTP ${status}. Retrying in ${delayMs}ms... (attempt ${attempt}/${maxRetries})`);
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        continue;
      }

      throw new KapsoError(`Kapso API failed with HTTP ${status}: ${errText.slice(0, 150)}`, {
        status,
        data: errText,
      });

    } catch (err) {
      if (err instanceof KapsoError) {
        throw err;
      }

      if (attempt < maxRetries) {
        attempt++;
        const delayMs = Math.pow(2, attempt) * 500;
        console.warn(`[kapso] network error "${err.message}". Retrying in ${delayMs}ms...`);
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        continue;
      }

      throw new KapsoError(`Failed to send message: ${err.message}`);
    }
  }
}

/**
 * Backward compatibility helper for routers and scheduler.
 */
export async function sendReminderConfirmation(recipient, message) {
  if (!recipient) return { success: false, reason: 'no_recipient' };

  const str = String(recipient).trim();
  const isBsuid = str.includes('.') || str.startsWith('CO.') || str.startsWith('US.') || str.startsWith('AR.');

  try {
    return await sendWhatsAppText({
      phoneNumber: isBsuid ? null : str,
      bsuid: isBsuid ? str : null,
      text: message,
    });
  } catch (err) {
    console.error('[kapso] sendReminderConfirmation failed:', err.message);
    return { success: false, error: err.message };
  }
}

/**
 * Strip existing reminder prefixes (e.g. "⏰ *Recordatorio:*", "⏰ Recordatorio:", "Recordatorio:") idempotently.
 */
export function stripReminderPrefix(text) {
  if (!text || typeof text !== 'string') return '';
  let s = text.trim();
  const pattern = /^(\s*⏰\s*)?(\*?Recordatorio:\*?|\*?Recordatorio\*?:?)\s*/i;
  while (pattern.test(s)) {
    const match = pattern.exec(s);
    if (!match || match[0].length === 0) break;
    s = s.slice(match[0].length).trim();
  }
  return s;
}

export async function sendReminderMessage(recipient, content) {
  const cleanContent = stripReminderPrefix(content);
  const reminderText = `⏰ Recordatorio: ${cleanContent}`;
  return sendReminderConfirmation(recipient, reminderText);
}

/**
 * Mark an inbound message as read and show a typing indicator.
 */
export async function sendTypingIndicator(messageId, phoneNumberId = null) {
  if (!messageId || messageId.startsWith('wamid.TEST_') || !process.env.KAPSO_API_KEY) {
    return null;
  }

  const phoneId = phoneNumberId || process.env.KAPSO_PHONE_NUMBER_ID || PRODUCTION_PHONE_NUMBER_ID;

  try {
    const t0 = Date.now();
    const response = await fetch(
      `${KAPSO_API_BASE}/${phoneId}/messages`,
      {
        method: 'POST',
        headers: {
          'X-API-Key': process.env.KAPSO_API_KEY,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          status: 'read',
          message_id: messageId,
          typing_indicator: { type: 'text' },
        }),
        signal: AbortSignal.timeout(6000),
      }
    );

    if (!response.ok) {
      const errText = await response.text();
      console.warn(`[kapso] typing indicator returned ${response.status}:`, errText.slice(0, 120));
      return null;
    }
    const data = await response.json();
    console.log(`[kapso] typing indicator active for ${messageId} in ${Date.now() - t0}ms`);
    return data;
  } catch (err) {
    console.warn('[kapso] sendTypingIndicator error:', err.message);
    return null;
  }
}

/**
 * Download media (audio, voice notes, documents) from Kapso / Meta Cloud API.
 */
export async function downloadMedia(mediaId, phoneNumberId = null, directUrl = null) {
  if ((!mediaId && !directUrl) || !process.env.KAPSO_API_KEY) return null;
  const phoneId = phoneNumberId || process.env.KAPSO_PHONE_NUMBER_ID || PRODUCTION_PHONE_NUMBER_ID;

  const tStart = Date.now();
  try {
    let downloadUrl = directUrl;
    let tMeta = 0;

    if (!downloadUrl && mediaId) {
      const metaRes = await fetch(
        `${KAPSO_API_BASE}/${mediaId}?phone_number_id=${phoneId}`,
        {
          headers: {
            'X-API-Key': process.env.KAPSO_API_KEY,
          },
          signal: AbortSignal.timeout(10000),
        }
      );

      if (!metaRes.ok) {
        console.error('[kapso] get media metadata failed:', await metaRes.text());
        return null;
      }

      const metaData = await metaRes.json();
      tMeta = Date.now() - tStart;
      downloadUrl = metaData.download_url || metaData.url;
      if (!downloadUrl) {
        console.error('[kapso] No download URL returned for mediaId:', mediaId);
        return null;
      }
    }

    const tBinStart = Date.now();
    const binHeaders = downloadUrl.includes('kapso.ai')
      ? { 'X-API-Key': process.env.KAPSO_API_KEY }
      : {};

    const binRes = await fetch(downloadUrl, {
      headers: binHeaders,
      signal: AbortSignal.timeout(15000),
    });

    if (!binRes.ok) {
      console.error('[kapso] download binary failed:', binRes.status);
      return null;
    }

    const buffer = await binRes.arrayBuffer();
    const tBin = Date.now() - tBinStart;
    console.log(`[kapso] Downloaded media ${mediaId || 'direct'} (${buffer.byteLength} bytes) in ${Date.now() - tStart}ms (meta: ${tMeta}ms, bin: ${tBin}ms)`);
    return buffer;
  } catch (err) {
    console.error('[kapso] downloadMedia error:', err.message);
    return null;
  }
}