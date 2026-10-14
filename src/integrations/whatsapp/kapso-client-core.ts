import { normalizePhoneNumber } from '../../shared/phone-number.js';
import { stripReminderPrefix } from '../../shared/reminder-prefix.js';
import { boundWhatsAppText } from '../../shared/whatsapp-text-boundary.js';
import { KapsoConfigurationError, KapsoValidationError } from './kapso-errors.js';
import { createKapsoDispatch } from './kapso-dispatch.js';
import type { KapsoDispatchDependencies, KapsoPayload, KapsoDispatchResult } from './kapso-dispatch.js';
export interface KapsoRecipient { phoneNumberId?: string | null | undefined; phoneNumber?: string | null | undefined; bsuid?: string | null | undefined }
export interface KapsoButton { id?: unknown; title?: unknown; text?: unknown }
export interface KapsoListRow { id?: unknown; title?: unknown; description?: unknown }
export interface KapsoInteractiveInput extends KapsoRecipient {
  bodyText: string; headerText?: string | null; footerText?: string | null; buttonText?: string;
}
export interface KapsoFlowInput extends KapsoInteractiveInput { flowId?: string | null; flowToken?: string | null; flowAction?: string; screen?: string; flowData?: Record<string, unknown> | null; mode?: string | null }
export interface KapsoTemplateInput extends KapsoRecipient { templateName?: string; languageCode?: string; parameters?: unknown[] }
export interface KapsoReminderOptions { templateName?: string; forceTemplate?: boolean; phoneNumberId?: string | null; buttons?: KapsoButton[] | null; language?: string }
export interface KapsoFailure { success: false; reason?: string; error?: string | undefined; code?: string | undefined; status?: number | undefined; outcome?: string }
export interface KapsoInteractivePayload { type: string; body: { text: string }; action: Record<string, unknown>; header?: { type: string; text: string }; footer?: { text: string } }
export interface ActivityQuery extends PromiseLike<{ data: unknown[] | null; error: unknown }> {
  select(columns: string): ActivityQuery;
  in(column: string, values: string[]): ActivityQuery;
  or(expression: string): ActivityQuery;
  gt(column: string, value: string): ActivityQuery;
  limit(count: number): ActivityQuery;
}
export interface KapsoClientDependencies extends Omit<KapsoDispatchDependencies, 'sendWhatsAppText'> {
  getEnv(): NodeJS.ProcessEnv;
  getNowMs(): number;
  userCache: { get(phone: string): { user?: { last_user_message_at?: string | null } } | undefined };
  supabase: { from(table: 'messages'): ActivityQuery };
  logger: Pick<Console, 'log' | 'warn' | 'error'>;
}
const KAPSO_API_BASE = 'https://api.kapso.ai/meta/whatsapp/v24.0';
const DEFAULT_PHONE_NUMBER_ID = '1248246475047194';

/** Live environment and fetch bindings preserve runtime configuration and test isolation. */
export function createKapsoClient(dependencies: KapsoClientDependencies) {
  const { assertTurnLease, fetch, supabase, userCache, getEnv, getNowMs, logger } = dependencies;
  const dispatch = createKapsoDispatch({ ...dependencies, sendWhatsAppText });
  const postMessage = dispatch.postMessage;
  /**
   * Official Kapso WhatsApp sender following enterprise best practices:
   * - Uses `to` for valid E.164 phone numbers.
   * - Uses `recipient` exclusively for BSUIDs (e.g. CO.1552339023039755).
   * - Dynamically routes through the originating phoneNumberId (Sandbox or Production).
   * - Retries explicit rate-limit rejections; uncertain delivery is never replayed.
   *
   * @param {object} params
   * @param {string} [params.phoneNumberId]
   * @param {string|null} [params.phoneNumber]
   * @param {string|null} [params.bsuid]
   * @param {string} params.text
   * @returns {Promise<{success: boolean, messageId: string, recipientType: 'phone'|'bsuid', data: any}>}
   */
  async function sendWhatsAppText({
    phoneNumberId = null,
    phoneNumber = null,
    bsuid = null,
    text,
  }: KapsoRecipient & { text: string }) {
    await assertTurnLease();
    const apiKey = getEnv().KAPSO_API_KEY;
    if (!apiKey) {
      throw new KapsoConfigurationError('KAPSO_API_KEY is not configured in environment.');
    }

    const activePhoneId = String(
      phoneNumberId ||
      getEnv().KAPSO_PHONE_NUMBER_ID ||
      getEnv().KAPSO_PRODUCTION_PHONE_NUMBER_ID ||
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

    if (cleanPhone) {
      payload = {
        messaging_product: 'whatsapp',
        to: cleanPhone,
        type: 'text',
        text: { body: boundWhatsAppText(text) },
      };
    } else {
      payload = {
        messaging_product: 'whatsapp',
        recipient: cleanBsuid,
        type: 'text',
        text: { body: boundWhatsAppText(text) },
      };
    }

    return postMessage({ activePhoneId, apiKey, payload });
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
  async function sendWhatsAppCtaUrl({
    phoneNumberId = null,
    phoneNumber = null,
    bsuid = null,
    headerText = null,
    bodyText,
    footerText = 'Hermes TempleLabs',
    buttonText = 'Abrir enlace',
    url,
  }: KapsoInteractiveInput & { url: string }) {
    await assertTurnLease();
    const apiKey = getEnv().KAPSO_API_KEY;
    if (!apiKey) {
      throw new KapsoConfigurationError('KAPSO_API_KEY is not configured in environment.');
    }

    const activePhoneId = String(
      phoneNumberId ||
      getEnv().KAPSO_PHONE_NUMBER_ID ||
      getEnv().KAPSO_PRODUCTION_PHONE_NUMBER_ID ||
      DEFAULT_PHONE_NUMBER_ID
    ).trim();

    const cleanPhone = normalizePhoneNumber(phoneNumber);
    const cleanBsuid = bsuid && typeof bsuid === 'string' && bsuid.trim().length > 0 ? bsuid.trim() : null;

    if (!cleanPhone && !cleanBsuid) {
      throw new KapsoValidationError('Incomplete recipient data: either phoneNumber or bsuid must be provided.');
    }

    const interactivePayload: KapsoInteractivePayload = {
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

    const payload: KapsoPayload = {
      messaging_product: 'whatsapp',
      type: 'interactive',
      interactive: interactivePayload,
    };

    if (cleanPhone) {
      payload.to = cleanPhone;
    } else {
      payload.recipient = cleanBsuid;
    }

    return postMessage({ activePhoneId, apiKey, payload, fallbackText: `${bodyText}\n\n👉 *${buttonText}:*\n${url}` });
  }

  /**
   * Send an interactive WhatsApp Flow message.
   * Launches a native Flow screen (e.g. task selection) when tapped.
   *
   * @param {object} params
   * @param {string} [params.phoneNumberId]
   * @param {string|null} [params.phoneNumber]
   * @param {string|null} [params.bsuid]
   * @param {string|null} [params.headerText]
   * @param {string} params.bodyText
   * @param {string|null} [params.footerText]
   * @param {string} [params.buttonText]
   * @param {string} [params.flowId]
   * @param {string} [params.flowToken]
   * @param {string} [params.flowAction]
   * @param {string} [params.screen]
   * @param {object} [params.flowData]
   * @param {'draft'|'published'} [params.mode]
   * @returns {Promise<{success: boolean, messageId: string, data: any}>}
   */
  async function sendWhatsAppFlow({
    phoneNumberId = null,
    phoneNumber = null,
    bsuid = null,
    headerText = null,
    bodyText,
    footerText = 'Hermes TempleLabs',
    buttonText = 'Completar tareas',
    flowId = null,
    flowToken = null,
    flowAction = 'navigate',
    screen = 'TASK_SELECTION',
    flowData = {},
    mode = null,
  }: KapsoFlowInput) {
    await assertTurnLease();
    const apiKey = getEnv().KAPSO_API_KEY;
    if (!apiKey) {
      throw new KapsoConfigurationError('KAPSO_API_KEY is not configured in environment.');
    }

    const activePhoneId = String(
      phoneNumberId ||
      getEnv().KAPSO_PHONE_NUMBER_ID ||
      getEnv().KAPSO_PRODUCTION_PHONE_NUMBER_ID ||
      DEFAULT_PHONE_NUMBER_ID
    ).trim();

    const cleanPhone = normalizePhoneNumber(phoneNumber);
    const cleanBsuid = bsuid && typeof bsuid === 'string' && bsuid.trim().length > 0 ? bsuid.trim() : null;

    if (!cleanPhone && !cleanBsuid) {
      throw new KapsoValidationError('Incomplete recipient data: either phoneNumber or bsuid must be provided.');
    }

    const targetFlowId = String(
      flowId || getEnv().KAPSO_TASK_COMPLETION_FLOW_ID || '1599560168243520'
    ).trim();
    const targetMode = String(mode || getEnv().KAPSO_FLOW_MODE || 'draft').trim();

    const interactivePayload: KapsoInteractivePayload = {
      type: 'flow',
      body: { text: bodyText },
      action: {
        name: 'flow',
        parameters: {
          flow_message_version: '3',
          flow_token: flowToken || `flow_${getNowMs()}`,
          flow_id: targetFlowId,
          flow_cta: (buttonText || 'Completar tareas').slice(0, 20),
          flow_action: flowAction,
          flow_action_payload: {
            screen,
            data: flowData || {},
          },
          mode: targetMode,
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

    const payload: KapsoPayload = {
      messaging_product: 'whatsapp',
      type: 'interactive',
      interactive: interactivePayload,
    };

    if (cleanPhone) {
      payload.to = cleanPhone;
    } else {
      payload.recipient = cleanBsuid;
    }

    return postMessage({ activePhoneId, apiKey, payload, fallbackText: bodyText });
  }


  /**
   * Send WhatsApp Interactive Quick Reply Buttons (up to 3 buttons).
   */
  async function sendWhatsAppQuickReplyButtons({
    phoneNumberId = null,
    phoneNumber = null,
    bsuid = null,
    headerText = null,
    bodyText,
    footerText = 'Hermes TempleLabs',
    buttons = [],
  }: KapsoInteractiveInput & { buttons?: KapsoButton[] }) {
    await assertTurnLease();
    const apiKey = getEnv().KAPSO_API_KEY;
    if (!apiKey) {
      throw new KapsoConfigurationError('KAPSO_API_KEY is not configured in environment.');
    }

    const activePhoneId = String(
      phoneNumberId ||
      getEnv().KAPSO_PHONE_NUMBER_ID ||
      getEnv().KAPSO_PRODUCTION_PHONE_NUMBER_ID ||
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

    const interactivePayload: KapsoInteractivePayload = {
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

    const payload: KapsoPayload = {
      messaging_product: 'whatsapp',
      type: 'interactive',
      interactive: interactivePayload,
    };

    if (cleanPhone) {
      payload.to = cleanPhone;
    } else {
      payload.recipient = cleanBsuid;
    }

    return postMessage({ activePhoneId, apiKey, payload, fallbackText: bodyText });
  }

  /**
   * Send WhatsApp Interactive List Message (up to 10 rows total, up to 10 sections).
   * Follows official Meta Cloud API constraints:
   * - action.button: max 20 chars
   * - sections: max 10 sections
   * - sections[].title: max 24 chars
   * - rows: max 10 rows total across all sections
   * - rows[].id: max 200 chars
   * - rows[].title: max 24 chars
   * - rows[].description: max 72 chars
   * - body.text: max 4096 chars
   * - header.text: max 60 chars
   * - footer.text: max 60 chars
   *
   * @param {object} params
   * @param {string|null} [params.phoneNumberId]
   * @param {string|null} [params.phoneNumber]
   * @param {string|null} [params.bsuid]
   * @param {string|null} [params.headerText]
   * @param {string} params.bodyText
   * @param {string|null} [params.footerText]
   * @param {string} [params.buttonText='Ver opciones']
   * @param {Array<{title: string, rows: Array<{id: string, title: string, description?: string}>}>} params.sections
   * @returns {Promise<{success: boolean, messageId?: string, data?: any, error?: string}>}
   */
  async function sendWhatsAppListMessage({
    phoneNumberId = null,
    phoneNumber = null,
    bsuid = null,
    headerText = null,
    bodyText,
    footerText = 'Hermes TempleLabs',
    buttonText = 'Ver opciones',
    sections = [],
  }: KapsoInteractiveInput & { sections?: { title?: unknown; rows?: KapsoListRow[] }[] }) {
    await assertTurnLease();
    const apiKey = getEnv().KAPSO_API_KEY;
    if (!apiKey) {
      throw new KapsoConfigurationError('KAPSO_API_KEY is not configured in environment.');
    }

    const activePhoneId = String(
      phoneNumberId ||
      getEnv().KAPSO_PHONE_NUMBER_ID ||
      getEnv().KAPSO_PRODUCTION_PHONE_NUMBER_ID ||
      DEFAULT_PHONE_NUMBER_ID
    ).trim();

    const cleanPhone = normalizePhoneNumber(phoneNumber);
    const cleanBsuid = bsuid && typeof bsuid === 'string' && bsuid.trim().length > 0 ? bsuid.trim() : null;

    if (!cleanPhone && !cleanBsuid) {
      throw new KapsoValidationError('Incomplete recipient data: either phoneNumber or bsuid must be provided.');
    }

    // Enforce Meta constraints: max 10 rows total across all sections, max 10 sections
    let totalRows = 0;
    const formattedSections = [];

    for (const section of (Array.isArray(sections) ? sections : []).slice(0, 10)) {
      if (totalRows >= 10) break;
      const remainingBudget = 10 - totalRows;
      const sectionRows = (Array.isArray(section.rows) ? section.rows : []).slice(0, remainingBudget).map((row, idx) => ({
        id: String(row.id || `row_${totalRows + idx + 1}`).slice(0, 200),
        title: String(row.title || 'Opción').slice(0, 24),
        ...(row.description ? { description: String(row.description).slice(0, 72) } : {}),
      }));

      if (sectionRows.length > 0) {
        formattedSections.push({
          title: String(section.title || 'Opciones').slice(0, 24),
          rows: sectionRows,
        });
        totalRows += sectionRows.length;
      }
    }

    // If no sections or rows, fall back directly to text
    if (formattedSections.length === 0 || totalRows === 0) {
      return await sendWhatsAppText({
        phoneNumberId,
        phoneNumber: cleanPhone,
        bsuid: cleanBsuid,
        text: bodyText,
      });
    }

    const interactivePayload: KapsoInteractivePayload = {
      type: 'list',
      body: { text: boundWhatsAppText(String(bodyText || '')) },
      action: {
        button: String(buttonText || 'Ver opciones').slice(0, 20),
        sections: formattedSections,
      },
    };

    if (headerText) {
      interactivePayload.header = {
        type: 'text',
        text: String(headerText).slice(0, 60),
      };
    }

    if (footerText) {
      interactivePayload.footer = {
        text: String(footerText).slice(0, 60),
      };
    }

    const payload: KapsoPayload = {
      messaging_product: 'whatsapp',
      type: 'interactive',
      interactive: interactivePayload,
    };

    if (cleanPhone) {
      payload.to = cleanPhone;
    } else {
      payload.recipient = cleanBsuid;
    }

    return postMessage({ activePhoneId, apiKey, payload, fallbackText: bodyText });
  }

  /**
   * Backward compatibility helper for routers and scheduler.
   */
  async function sendReminderConfirmation(recipient: unknown, message: string, { phoneNumberId = null }: { phoneNumberId?: string | null } = {}): Promise<KapsoDispatchResult | KapsoFailure> {
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
      logger.error('[kapso] sendReminderConfirmation failed:', (err as { message: string; code: string | undefined; status: number }).message);
      return { success: false, error: (err as { message: string; code: string | undefined; status: number }).message, code: (err as { message: string; code: string | undefined; status: number }).code, status: (err as { message: string; code: string | undefined; status: number }).status, outcome: (err as { message: string; code: string | undefined; status: number }).code === 'DELIVERY_OUTCOME_UNKNOWN' ? 'unknown' : 'failure' };
    }
  }

  /**
   * Check if the recipient has sent an inbound message or interacted within the 24-hour window.
   * Meta WhatsApp Cloud API rules:
   * - Window opens when the customer sends any message (text, media, button reply, flow submit).
   * - Window stays open for exactly 24 hours (86,400 seconds) from the last inbound interaction.
   *
   * @param {string} phoneNumber
   * @returns {Promise<boolean>}
   */
  async function isWithin24HourWindow(phoneNumber: unknown) {
    if (!phoneNumber) return false;
    const rawStr = String(phoneNumber).trim();
    const isBsuid = rawStr.includes('.') || rawStr.startsWith('CO.') || rawStr.startsWith('US.') || rawStr.startsWith('AR.');
    const cleanDigits = rawStr.replace(/\D/g, '');
    const phoneCandidates = isBsuid
      ? [rawStr]
      : Array.from(new Set([rawStr, cleanDigits, `+${cleanDigits}`].filter(Boolean)));

    // 1. Ultra-fast RAM lookup: Check in-memory userCache (0ms CPU operation)
    for (const candidate of phoneCandidates) {
      const cached = userCache.get(candidate);
      if (cached?.user?.last_user_message_at) {
        const lastActiveMs = new Date(cached.user.last_user_message_at).getTime();
        if (!isNaN(lastActiveMs)) {
          const elapsed = getNowMs() - lastActiveMs;
          if (elapsed <= 24 * 60 * 60 * 1000) {
            return true; // Window is OPEN
          }
        }
      }
    }

    // 2. Database verification fallback:
    // Check for any inbound user message OR user-initiated interactive button response (ack/snooze/flow)
    // in the last 24 hours.
    try {
      const threshold = new Date(getNowMs() - 24 * 60 * 60 * 1000).toISOString();
      const { data, error } = await supabase
        .from('messages')
        .select('id')
        .in('phone_number', phoneCandidates)
        .or('role.eq.user,intent.in.(reminder_ack,reminder_snooze,task_complete_flow,reminder_ack_click,reminder_snooze_click,task_complete_flow_submit)')
        .gt('created_at', threshold)
        .limit(1);

      if (!error && data && data.length > 0) {
        return true;
      }
      return false;
    } catch (err) {
      logger.warn('[kapso] isWithin24HourWindow check failed:', (err as { message: string; code: string | undefined; status: number }).message);
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
  async function sendWhatsAppTemplate({
    phoneNumberId = null,
    phoneNumber = null,
    bsuid = null,
    templateName = 'reminder_task_one_reminder',
    languageCode = 'es',
    parameters = [],
  }: KapsoTemplateInput): Promise<KapsoDispatchResult> {
    const apiKey = getEnv().KAPSO_API_KEY;
    if (!apiKey) {
      throw new KapsoConfigurationError('KAPSO_API_KEY is not configured in environment.');
    }

    const activePhoneId = String(
      phoneNumberId ||
      getEnv().KAPSO_PHONE_NUMBER_ID ||
      getEnv().KAPSO_PRODUCTION_PHONE_NUMBER_ID ||
      DEFAULT_PHONE_NUMBER_ID
    ).trim();

    const cleanPhone = normalizePhoneNumber(phoneNumber);
    const cleanBsuid = bsuid && typeof bsuid === 'string' && bsuid.trim().length > 0 ? bsuid.trim() : null;

    if (!cleanPhone && !cleanBsuid) {
      throw new KapsoValidationError('Incomplete recipient data: either phoneNumber or bsuid must be provided.');
    }

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
      payload = {
        messaging_product: 'whatsapp',
        to: cleanPhone,
        type: 'template',
        template: templateObj,
      };
    } else {
      payload = {
        messaging_product: 'whatsapp',
        recipient: cleanBsuid,
        type: 'template',
        template: templateObj,
      };
    }

    try {
      return await postMessage({ activePhoneId, apiKey, payload });
    } catch (error) {
      if ([400, 404].includes((error as { message: string; code: string | undefined; status: number }).status) && languageCode !== 'es'
          && ((error as { message: string; code: string | undefined; status: number }).message.includes('132001') || (error as { message: string; code: string | undefined; status: number }).message.includes('does not exist in'))) {
        return sendWhatsAppTemplate({ phoneNumberId: activePhoneId, phoneNumber: cleanPhone, bsuid: cleanBsuid,
          templateName: 'reminder_task_one_reminder', languageCode: 'es', parameters });
      }
      throw error;
    }
  }

  /**
   * Send a scheduled reminder to a recipient.
   * Intelligently checks 24-hour window:
   * - Inside 24h: sends freeform text.
   * - Outside 24h (or fallback on error): sends approved template (reminder_task_one_reminder).
   */
  async function sendReminderMessage(recipient: unknown, content: string, {
    templateName = getEnv().REMINDER_TEMPLATE_NAME || 'reminder_task_one_reminder',
    forceTemplate = false,
    phoneNumberId = null,
    buttons = null,
    language = 'es',
  }: KapsoReminderOptions = {}) {
    const cleanContent = stripReminderPrefix(content);
    const str = String(recipient).trim();
    const isBsuid = str.includes('.') || str.startsWith('CO.') || str.startsWith('US.') || str.startsWith('AR.');

    // 1. Check if recipient is within 24h window
    const isInsideWindow = forceTemplate ? false : await isWithin24HourWindow(str);

    const isEnglish = language === 'en' || (typeof language === 'string' && language.startsWith('en'));
    const reminderPrefix = isEnglish ? '⏰ Reminder: ' : '⏰ Recordatorio: ';

    if (isInsideWindow) {
      const reminderText = `${reminderPrefix}${cleanContent}`;
      let textRes: KapsoDispatchResult | KapsoFailure;
      try {
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
      } catch (sendErr) {
        textRes = { success: false, error: (sendErr as { message: string; code: string | undefined; status: number }).message, code: (sendErr as { message: string; code: string | undefined; status: number }).code, status: (sendErr as { message: string; code: string | undefined; status: number }).status, outcome: (sendErr as { message: string; code: string | undefined; status: number }).code === 'DELIVERY_OUTCOME_UNKNOWN' ? 'unknown' : 'failure' };
      }

      // If freeform text or interactive buttons succeeded, return immediately
      if (textRes?.success) return textRes;
      if (![400, 404, 422].includes(textRes?.status as number)) return textRes;

      logger.log(`[kapso] Freeform/interactive message failed (${textRes?.error || 'window closed'}). Auto-recovering via template "${templateName}"...`);
    } else {
      logger.log(`[kapso] Recipient ${str} is outside 24h window. Dispatching via approved template "${templateName}"...`);
    }

    const effectiveTemplate = isEnglish
      ? (getEnv().REMINDER_TEMPLATE_NAME_EN || 'reminder_task_one_reminder_english')
      : templateName;

    // 2. Dispatch via pre-approved Meta Template (e.g. reminder_task_one_reminder)
    return await sendWhatsAppTemplate({
      phoneNumberId,
      phoneNumber: isBsuid ? null : str,
      bsuid: isBsuid ? str : null,
      templateName: effectiveTemplate,
      languageCode: isEnglish ? 'en_US' : 'es',
      parameters: [cleanContent],
    });
  }

  /**
   * Mark an inbound message as read and show a typing indicator.
   */
  async function sendTypingIndicator(messageId: string | null | undefined, phoneNumberId: string | null = null) {
    if (!messageId || messageId.startsWith('wamid.TEST_') || !getEnv().KAPSO_API_KEY) {
      return null;
    }

    const phoneId = String(
      phoneNumberId ||
      getEnv().KAPSO_PHONE_NUMBER_ID ||
      getEnv().KAPSO_PRODUCTION_PHONE_NUMBER_ID ||
      DEFAULT_PHONE_NUMBER_ID
    ).trim();

    try {
      const t0 = getNowMs();
      const response = await fetch(
        `${KAPSO_API_BASE}/${phoneId}/messages`,
        {
          method: 'POST',
          headers: {
            'X-API-Key': getEnv().KAPSO_API_KEY as string,
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
        logger.warn(`[kapso] typing indicator returned ${response.status}:`, errText.slice(0, 120));
        return null;
      }
      const data = await response.json();
      logger.log(`[kapso] typing indicator active for ${messageId} in ${getNowMs() - t0}ms`);
      return data;
    } catch (err) {
      logger.warn('[kapso] sendTypingIndicator error:', (err as { message: string; code: string | undefined; status: number }).message);
      return null;
    }
  }

  /**
   * Download media (audio, voice notes, documents) from Kapso / Meta Cloud API.
   * Uses direct stream download to Blob, skipping metadata lookup if directUrl is present.
   */
  async function downloadMedia(mediaId: string | null | undefined, phoneNumberId: string | null = null, directUrl: string | null = null) {
    if ((!mediaId && !directUrl) || !getEnv().KAPSO_API_KEY) return null;
    const phoneId = String(
      phoneNumberId ||
      getEnv().KAPSO_PHONE_NUMBER_ID ||
      getEnv().KAPSO_PRODUCTION_PHONE_NUMBER_ID ||
      DEFAULT_PHONE_NUMBER_ID
    ).trim();

    const tStart = getNowMs();
    try {
      // Only use directUrl directly if it is a Kapso-hosted URL (api.kapso.ai). Raw Meta CDN (lookaside.fbsbx.com) requires Kapso proxy metadata.
      let downloadUrl: string | null | undefined = (directUrl && directUrl.includes('kapso.ai')) ? directUrl : null;
      let tMeta = 0;

      // If directUrl is not a Kapso URL, fetch download_url metadata from Kapso API proxy
      if (!downloadUrl && mediaId) {
        const metaStart = getNowMs();
        const metaRes = await fetch(
          `${KAPSO_API_BASE}/${mediaId}?phone_number_id=${phoneId}`,
          {
            headers: {
              'X-API-Key': getEnv().KAPSO_API_KEY as string,
            },
            signal: AbortSignal.timeout(6000),
          }
        );

        if (!metaRes.ok) {
          logger.error('[kapso] get media metadata failed:', await metaRes.text());
          return null;
        }

        const metaData = await metaRes.json() as { download_url?: string; url?: string; link?: string };
        tMeta = getNowMs() - metaStart;
        downloadUrl = metaData.download_url || metaData.url || metaData.link;
        if (!downloadUrl) {
          logger.error('[kapso] No download URL returned for mediaId:', mediaId);
          return null;
        }
      }

      const tBinStart = getNowMs();
      const binRes = await fetch(downloadUrl as string, {
        headers: {
          'X-API-Key': getEnv().KAPSO_API_KEY as string,
        },
        signal: AbortSignal.timeout(8000),
      });

      if (!binRes.ok) {
        const errText = await binRes.text().catch(() => '');
        logger.error('[kapso] download binary failed:', binRes.status, errText.slice(0, 80));
        return null;
      }

      // Direct stream to Blob with zero intermediate byte copies
      const blob = await binRes.blob();
      const tBin = getNowMs() - tBinStart;
      logger.log(`[kapso] Downloaded media ${mediaId || 'direct'} (${blob.size} bytes) in ${getNowMs() - tStart}ms (meta: ${tMeta}ms, stream: ${tBin}ms)`);
      return blob;
    } catch (err) {
      logger.error('[kapso] downloadMedia error:', (err as { message: string; code: string | undefined; status: number }).message);
      return null;
    }
  }

  return { normalizePhoneNumber, sendWhatsAppText, sendWhatsAppCtaUrl, sendWhatsAppFlow, sendWhatsAppQuickReplyButtons, sendWhatsAppListMessage, sendReminderConfirmation, stripReminderPrefix, isWithin24HourWindow, sendWhatsAppTemplate, sendReminderMessage, sendTypingIndicator, downloadMedia };
}
