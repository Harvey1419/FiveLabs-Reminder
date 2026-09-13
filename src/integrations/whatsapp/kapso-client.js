import { markAsProcessed } from '../../http/webhooks/whatsapp.js';
import { supabase } from '../../infrastructure/database/index.js';
import { userCache } from '../../infrastructure/database/users.js';

const KAPSO_API_BASE = 'https://api.kapso.ai/meta/whatsapp/v24.0';
const DEFAULT_PHONE_NUMBER_ID = '1248246475047194';

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
 * - Dynamically routes through the originating phoneNumberId (Sandbox or Production).
 * - Implements exponential backoff retry for temporary errors (429, 500, 502, 503, 504).
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

  const activePhoneId = String(
    phoneNumberId ||
    process.env.KAPSO_PHONE_NUMBER_ID ||
    process.env.KAPSO_PRODUCTION_PHONE_NUMBER_ID ||
    DEFAULT_PHONE_NUMBER_ID
  ).trim();

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
        const messageId = data.messages?.[0]?.id || null;

        if (!messageId) {
          console.error(`[kapso] HTTP ${response.status} response for ${targetDisplay} did not include a provider message id.`);
          return {
            success: false,
            recipientType,
            data,
            error: 'Kapso accepted the request without returning a provider message id.',
          };
        }
        markAsProcessed(messageId);

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
 * Send an interactive WhatsApp Call-to-Action (CTA) URL button.
 * Renders as a native interactive button card in WhatsApp chat.
 *
 * @param {object} params
 * @param {string|null} [params.phoneNumberId]
 * @param {string|null} [params.phoneNumber]
 * @param {string|null} [params.bsuid]
 * @param {string} [params.headerText]
 * @param {string} params.bodyText
 * @param {string} [params.footerText]
 * @param {string} [params.buttonText='Abrir enlace']
 * @param {string} params.url
 * @returns {Promise<{success: boolean, messageId?: string, data?: any}>}
 */
export async function sendWhatsAppCtaUrl({
  phoneNumberId = null,
  phoneNumber = null,
  bsuid = null,
  headerText = null,
  bodyText,
  footerText = 'Hermes TempleLabs',
  buttonText = 'Abrir enlace',
  url,
}) {
  const apiKey = process.env.KAPSO_API_KEY;
  if (!apiKey) {
    throw new KapsoConfigurationError('KAPSO_API_KEY is not configured in environment.');
  }

  const activePhoneId = String(
    phoneNumberId ||
    process.env.KAPSO_PHONE_NUMBER_ID ||
    process.env.KAPSO_PRODUCTION_PHONE_NUMBER_ID ||
    DEFAULT_PHONE_NUMBER_ID
  ).trim();

  const cleanPhone = normalizePhoneNumber(phoneNumber);
  const cleanBsuid = bsuid && typeof bsuid === 'string' && bsuid.trim().length > 0 ? bsuid.trim() : null;

  if (!cleanPhone && !cleanBsuid) {
    throw new KapsoValidationError('Incomplete recipient data: either phoneNumber or bsuid must be provided.');
  }

  const interactivePayload = {
    type: 'cta_url',
    body: { text: bodyText },
    action: {
      name: 'cta_url',
      parameters: {
        display_text: buttonText.slice(0, 20),
        url,
      },
    },
  };

  if (headerText) {
    interactivePayload.header = {
      type: 'text',
      text: headerText.slice(0, 60),
    };
  }

  if (footerText) {
    interactivePayload.footer = {
      text: footerText.slice(0, 60),
    };
  }

  const payload = {
    messaging_product: 'whatsapp',
    type: 'interactive',
    interactive: interactivePayload,
  };

  if (cleanPhone) {
    payload.to = cleanPhone;
  } else {
    payload.recipient = cleanBsuid;
  }

  const endpoint = `${KAPSO_API_BASE}/${activePhoneId}/messages`;

  try {
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
      console.log(`[kapso] sent CTA button ok to=${cleanPhone || cleanBsuid} messageId=${messageId}`);
      return { success: true, messageId, data };
    }

    const errText = await response.text();
    console.warn(`[kapso] CTA URL button rejected (HTTP ${response.status}): ${errText.slice(0, 150)}, falling back to text...`);
    return await sendWhatsAppText({
      phoneNumber: cleanPhone,
      bsuid: cleanBsuid,
      text: `${bodyText}\n\n👉 *${buttonText}:*\n${url}`,
    });
  } catch (err) {
    console.warn(`[kapso] CTA URL error: ${err.message}, falling back to text...`);
    return await sendWhatsAppText({
      phoneNumber: cleanPhone,
      bsuid: cleanBsuid,
      text: `${bodyText}\n\n👉 *${buttonText}:*\n${url}`,
    });
  }
}

/**
 * Send WhatsApp Interactive Quick Reply Buttons (up to 3 buttons).
 */
export async function sendWhatsAppQuickReplyButtons({
  phoneNumberId = null,
  phoneNumber = null,
  bsuid = null,
  headerText = null,
  bodyText,
  footerText = 'Hermes TempleLabs',
  buttons = [],
}) {
  const apiKey = process.env.KAPSO_API_KEY;
  if (!apiKey) {
    throw new KapsoConfigurationError('KAPSO_API_KEY is not configured in environment.');
  }

  const activePhoneId = String(
    phoneNumberId ||
    process.env.KAPSO_PHONE_NUMBER_ID ||
    process.env.KAPSO_PRODUCTION_PHONE_NUMBER_ID ||
    DEFAULT_PHONE_NUMBER_ID
  ).trim();

  const cleanPhone = normalizePhoneNumber(phoneNumber);
  const cleanBsuid = bsuid && typeof bsuid === 'string' && bsuid.trim().length > 0 ? bsuid.trim() : null;

  if (!cleanPhone && !cleanBsuid) {
    throw new KapsoValidationError('Incomplete recipient data: either phoneNumber or bsuid must be provided.');
  }

  const formattedButtons = (Array.isArray(buttons) ? buttons : []).slice(0, 3).map((btn, idx) => ({
    type: 'reply',
    reply: {
      id: String(btn.id || `btn_${idx}`).slice(0, 256),
      title: String(btn.title || btn.text || 'Opción').slice(0, 20),
    },
  }));

  const interactivePayload = {
    type: 'button',
    body: { text: bodyText },
    action: {
      buttons: formattedButtons,
    },
  };

  if (headerText) {
    interactivePayload.header = {
      type: 'text',
      text: headerText.slice(0, 60),
    };
  }

  if (footerText) {
    interactivePayload.footer = {
      text: footerText.slice(0, 60),
    };
  }

  const payload = {
    messaging_product: 'whatsapp',
    type: 'interactive',
    interactive: interactivePayload,
  };

  if (cleanPhone) {
    payload.to = cleanPhone;
  } else {
    payload.recipient = cleanBsuid;
  }

  const endpoint = `${KAPSO_API_BASE}/${activePhoneId}/messages`;

  try {
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
      console.log(`[kapso] sent interactive buttons ok to=${cleanPhone || cleanBsuid} messageId=${messageId}`);
      return { success: true, messageId, data };
    }

    const errText = await response.text();
    console.warn(`[kapso] Interactive buttons rejected (HTTP ${response.status}): ${errText.slice(0, 150)}, falling back to text...`);
    return await sendWhatsAppText({
      phoneNumberId,
      phoneNumber: cleanPhone,
      bsuid: cleanBsuid,
      text: bodyText,
    });
  } catch (err) {
    console.warn(`[kapso] Interactive buttons error: ${err.message}, falling back to text...`);
    return await sendWhatsAppText({
      phoneNumberId,
      phoneNumber: cleanPhone,
      bsuid: cleanBsuid,
      text: bodyText,
    });
  }
}

/**
 * Backward compatibility helper for routers and scheduler.
 */
export async function sendReminderConfirmation(recipient, message, { phoneNumberId = null } = {}) {
  if (!recipient) return { success: false, reason: 'no_recipient' };

  const str = String(recipient).trim();
  const isBsuid = str.includes('.') || str.startsWith('CO.') || str.startsWith('US.') || str.startsWith('AR.');

  try {
    return await sendWhatsAppText({
      phoneNumberId,
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

/**
 * Check if the recipient has sent an inbound message in the last 23.5 hours.
 * @param {string} phoneNumber
 * @returns {Promise<boolean>}
 */
export async function isWithin24HourWindow(phoneNumber) {
  if (!phoneNumber) return false;
  const str = String(phoneNumber).trim();
  const isBsuid = str.includes('.') || str.startsWith('CO.') || str.startsWith('US.') || str.startsWith('AR.');
  const identifier = isBsuid ? str : (normalizePhoneNumber(str) || str);

  // 1. Ultra-fast RAM lookup: Check in-memory userCache (0ms CPU operation)
  const cached = userCache.get(identifier) || (isBsuid ? null : userCache.get(normalizePhoneNumber(str)));
  if (cached?.user?.last_user_message_at) {
    const lastActiveMs = new Date(cached.user.last_user_message_at).getTime();
    if (!isNaN(lastActiveMs)) {
      const elapsed = Date.now() - lastActiveMs;
      if (elapsed < 23.5 * 60 * 60 * 1000) {
        return true; // Window is definitely OPEN
      }
      if (elapsed > 24.5 * 60 * 60 * 1000) {
        return false; // Window is definitely CLOSED
      }
    }
  }

  // 2. Database verification fallback
  try {
    const threshold = new Date(Date.now() - 23.5 * 60 * 60 * 1000).toISOString();
    const { data, error } = await supabase
      .from('messages')
      .select('created_at')
      .eq('phone_number', identifier)
      .eq('role', 'user')
      .gt('created_at', threshold)
      .limit(1);

    if (error || !data || data.length === 0) {
      return false;
    }
    return true;
  } catch (err) {
    console.warn('[kapso] isWithin24HourWindow check failed:', err.message);
    return false;
  }
}

/**
 * Send a pre-approved Meta WhatsApp Template message (for business-initiated messages outside the 24h window).
 * Supports any number of positional parameters (parameters: ['param1', 'param2', ...]).
 *
 * @param {Object} params
 * @param {string|null} [params.phoneNumberId]
 * @param {string|null} [params.phoneNumber]
 * @param {string|null} [params.bsuid]
 * @param {string} [params.templateName='reminder_task_one_reminder']
 * @param {string} [params.languageCode='es']
 * @param {Array<string>} [params.parameters=[]]
 * @returns {Promise<{success: boolean, messageId?: string, recipientType?: 'phone'|'bsuid', data?: any, error?: string}>}
 */
export async function sendWhatsAppTemplate({
  phoneNumberId = null,
  phoneNumber = null,
  bsuid = null,
  templateName = 'reminder_task_one_reminder',
  languageCode = 'es',
  parameters = [],
}) {
  const apiKey = process.env.KAPSO_API_KEY;
  if (!apiKey) {
    throw new KapsoConfigurationError('KAPSO_API_KEY is not configured in environment.');
  }

  const activePhoneId = String(
    phoneNumberId ||
    process.env.KAPSO_PHONE_NUMBER_ID ||
    process.env.KAPSO_PRODUCTION_PHONE_NUMBER_ID ||
    DEFAULT_PHONE_NUMBER_ID
  ).trim();

  const cleanPhone = normalizePhoneNumber(phoneNumber);
  const cleanBsuid = bsuid && typeof bsuid === 'string' && bsuid.trim().length > 0 ? bsuid.trim() : null;

  if (!cleanPhone && !cleanBsuid) {
    throw new KapsoValidationError('Incomplete recipient data: either phoneNumber or bsuid must be provided.');
  }

  let recipientType;
  let targetDisplay;
  let payload;

  const templateObj = {
    name: templateName,
    language: { code: languageCode },
    components: parameters.length > 0 ? [
      {
        type: 'body',
        parameters: parameters.map(p => ({
          type: 'text',
          text: String(p ?? ''),
        })),
      },
    ] : [],
  };

  if (cleanPhone) {
    recipientType = 'phone';
    targetDisplay = cleanPhone;
    payload = {
      messaging_product: 'whatsapp',
      to: cleanPhone,
      type: 'template',
      template: templateObj,
    };
  } else {
    recipientType = 'bsuid';
    targetDisplay = cleanBsuid;
    payload = {
      messaging_product: 'whatsapp',
      recipient: cleanBsuid,
      type: 'template',
      template: templateObj,
    };
  }

  const endpoint = `${KAPSO_API_BASE}/${activePhoneId}/messages`;
  const maxRetries = 2;
  let attempt = 0;

  while (attempt <= maxRetries) {
    try {
      console.log(`[kapso] sending template "${templateName}" (${recipientType}) to ${targetDisplay} (attempt ${attempt + 1})`);

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
        const messageId = data.messages?.[0]?.id || null;
        if (!messageId) {
          console.error(`[kapso] HTTP ${response.status} template response for ${targetDisplay} did not include a provider message id.`);
          return {
            success: false,
            recipientType,
            data,
            error: 'Kapso accepted the template request without returning a provider message id.',
          };
        }
        markAsProcessed(messageId);
        console.log(`[kapso] template sent ok to=${targetDisplay} (${recipientType}) messageId=${messageId}`);
        return {
          success: true,
          messageId,
          recipientType,
          data,
        };
      }

      const errText = await response.text();
      const status = response.status;

      if (status === 401) {
        throw new KapsoAuthError('Invalid or unauthorized KAPSO_API_KEY.', status);
      }

      console.warn(`[kapso] template dispatch HTTP ${status}:`, errText.slice(0, 150));
      return { success: false, status, error: errText };

    } catch (err) {
      if (err instanceof KapsoError) throw err;
      if (attempt < maxRetries) {
        attempt++;
        await new Promise((res) => setTimeout(res, 1000));
        continue;
      }
      console.error('[kapso] sendWhatsAppTemplate error:', err.message);
      return { success: false, error: err.message };
    }
  }
}

/**
 * Send a scheduled reminder to a recipient.
 * Intelligently checks 24-hour window:
 * - Inside 24h: sends freeform text.
 * - Outside 24h (or fallback on error): sends approved template (reminder_task_one_reminder).
 */
export async function sendReminderMessage(recipient, content, {
  templateName = process.env.REMINDER_TEMPLATE_NAME || 'reminder_task_one_reminder',
  forceTemplate = false,
  phoneNumberId = null,
  buttons = null,
  language = 'es',
} = {}) {
  const cleanContent = stripReminderPrefix(content);
  const str = String(recipient).trim();
  const isBsuid = str.includes('.') || str.startsWith('CO.') || str.startsWith('US.') || str.startsWith('AR.');

  // 1. Check if recipient is within 24h window
  const isInsideWindow = forceTemplate ? false : await isWithin24HourWindow(str);

  const isEnglish = language === 'en' || (typeof language === 'string' && language.startsWith('en'));
  const reminderPrefix = isEnglish ? '⏰ Reminder: ' : '⏰ Recordatorio: ';

  if (isInsideWindow) {
    const reminderText = `${reminderPrefix}${cleanContent}`;
    let textRes;
    if (Array.isArray(buttons) && buttons.length > 0) {
      textRes = await sendWhatsAppQuickReplyButtons({
        phoneNumberId,
        phoneNumber: isBsuid ? null : str,
        bsuid: isBsuid ? str : null,
        bodyText: reminderText,
        buttons,
      });
    } else {
      textRes = await sendReminderConfirmation(recipient, reminderText, { phoneNumberId });
    }

    // If freeform text or interactive buttons succeeded, return immediately
    if (textRes?.success) return textRes;

    console.log(`[kapso] Freeform/interactive message failed (${textRes?.error || 'window closed'}). Auto-recovering via template "${templateName}"...`);
  } else {
    console.log(`[kapso] Recipient ${str} is outside 24h window. Dispatching via approved template "${templateName}"...`);
  }

  // 2. Dispatch via pre-approved Meta Template (e.g. reminder_task_one_reminder)
  return await sendWhatsAppTemplate({
    phoneNumberId,
    phoneNumber: isBsuid ? null : str,
    bsuid: isBsuid ? str : null,
    templateName,
    languageCode: isEnglish ? 'en_US' : 'es',
    parameters: [cleanContent],
  });
}

/**
 * Mark an inbound message as read and show a typing indicator.
 */
export async function sendTypingIndicator(messageId, phoneNumberId = null) {
  if (!messageId || messageId.startsWith('wamid.TEST_') || !process.env.KAPSO_API_KEY) {
    return null;
  }

  const phoneId = String(
    phoneNumberId ||
    process.env.KAPSO_PHONE_NUMBER_ID ||
    process.env.KAPSO_PRODUCTION_PHONE_NUMBER_ID ||
    DEFAULT_PHONE_NUMBER_ID
  ).trim();

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
 * Uses direct stream download to Blob, skipping metadata lookup if directUrl is present.
 */
export async function downloadMedia(mediaId, phoneNumberId = null, directUrl = null) {
  if ((!mediaId && !directUrl) || !process.env.KAPSO_API_KEY) return null;
  const phoneId = String(
    phoneNumberId ||
    process.env.KAPSO_PHONE_NUMBER_ID ||
    process.env.KAPSO_PRODUCTION_PHONE_NUMBER_ID ||
    DEFAULT_PHONE_NUMBER_ID
  ).trim();

  const tStart = Date.now();
  try {
    // Only use directUrl directly if it is a Kapso-hosted URL (api.kapso.ai). Raw Meta CDN (lookaside.fbsbx.com) requires Kapso proxy metadata.
    let downloadUrl = (directUrl && directUrl.includes('kapso.ai')) ? directUrl : null;
    let tMeta = 0;

    // If directUrl is not a Kapso URL, fetch download_url metadata from Kapso API proxy
    if (!downloadUrl && mediaId) {
      const metaStart = Date.now();
      const metaRes = await fetch(
        `${KAPSO_API_BASE}/${mediaId}?phone_number_id=${phoneId}`,
        {
          headers: {
            'X-API-Key': process.env.KAPSO_API_KEY,
          },
          signal: AbortSignal.timeout(6000),
        }
      );

      if (!metaRes.ok) {
        console.error('[kapso] get media metadata failed:', await metaRes.text());
        return null;
      }

      const metaData = await metaRes.json();
      tMeta = Date.now() - metaStart;
      downloadUrl = metaData.download_url || metaData.url || metaData.link;
      if (!downloadUrl) {
        console.error('[kapso] No download URL returned for mediaId:', mediaId);
        return null;
      }
    }

    const tBinStart = Date.now();
    const binRes = await fetch(downloadUrl, {
      headers: {
        'X-API-Key': process.env.KAPSO_API_KEY,
      },
      signal: AbortSignal.timeout(8000),
    });

    if (!binRes.ok) {
      const errText = await binRes.text().catch(() => '');
      console.error('[kapso] download binary failed:', binRes.status, errText.slice(0, 80));
      return null;
    }

    // Direct stream to Blob with zero intermediate byte copies
    const blob = await binRes.blob();
    const tBin = Date.now() - tBinStart;
    console.log(`[kapso] Downloaded media ${mediaId || 'direct'} (${blob.size} bytes) in ${Date.now() - tStart}ms (meta: ${tMeta}ms, stream: ${tBin}ms)`);
    return blob;
  } catch (err) {
    console.error('[kapso] downloadMedia error:', err.message);
    return null;
  }
}
