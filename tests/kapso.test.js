import 'dotenv/config';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  normalizePhoneNumber,
  sendWhatsAppText,
  KapsoConfigurationError,
  KapsoValidationError,
  KapsoAuthError,
  KapsoSandboxError,
} from '../src/utils/kapso.js';
import { extractContactInfo, extractPhoneNumberId, isOutboundMessage, isDuplicate, markAsProcessed } from '../src/webhook.js';

describe('Kapso WhatsApp Integration - Enterprise Test Suite', () => {

  describe('1. Phone Number Normalization', () => {
    it('normalizes Colombian phone number +57 311 8588249 to 573118588249', () => {
      const normalized = normalizePhoneNumber('+57 311 8588249');
      expect(normalized).toBe('573118588249');
    });

    it('normalizes phone number with hyphens and parentheses', () => {
      const normalized = normalizePhoneNumber('+1 (208) 441-6502');
      expect(normalized).toBe('12084416502');
    });

    it('returns null for empty or invalid numbers', () => {
      expect(normalizePhoneNumber(null)).toBeNull();
      expect(normalizePhoneNumber('')).toBeNull();
      expect(normalizePhoneNumber('123')).toBeNull(); // Less than 7 digits
    });
  });

  describe('2. Contact Info & Channel ID Extraction', () => {
    it('extracts sandbox and production phone_number_id dynamically', () => {
      expect(extractPhoneNumberId({ phone_number_id: '597907523413541' })).toBe('597907523413541');
      expect(extractPhoneNumberId({ phone_number_id: '1248246475047194' })).toBe('1248246475047194');
      expect(extractPhoneNumberId({
        entry: [{ changes: [{ value: { metadata: { phone_number_id: '597907523413541' } } }] }]
      })).toBe('597907523413541');
    });

    it('correctly extracts contact with phone number', () => {
      const payload = {
        message: { from: '573118588249', text: { body: 'Hola' } },
        conversation: { contact_name: 'Carlos' },
      };
      const info = extractContactInfo(payload);
      expect(info.phoneNumber).toBe('573118588249');
      expect(info.displayName).toBe('Carlos');
    });

    it('correctly extracts contact with null phone number and BSUID (from_user_id)', () => {
      const payload = {
        message: {
          from: null,
          from_user_id: 'CO.1552339023039755',
          text: { body: 'Mucho gusto' },
          username: 'lopezyuranis',
        },
        conversation: {
          phone_number: null,
          business_scoped_user_id: 'CO.1552339023039755',
          contact_name: 'Yuranis Lopez',
        },
      };
      const info = extractContactInfo(payload);
      expect(info.phoneNumber).toBeNull();
      expect(info.bsuid).toBe('CO.1552339023039755');
      expect(info.displayName).toBe('Yuranis Lopez');
    });

    it('handles payload with conversation.business_scoped_user_id when message fields are empty', () => {
      const payload = {
        message: { text: { body: 'Hola' } },
        conversation: { business_scoped_user_id: 'CO.99887766' },
      };
      const info = extractContactInfo(payload);
      expect(info.phoneNumber).toBeNull();
      expect(info.bsuid).toBe('CO.99887766');
    });

    it('returns null for both when neither phone nor BSUID is present', () => {
      const payload = { message: { text: { body: 'Hola' } } };
      const info = extractContactInfo(payload);
      expect(info.phoneNumber).toBeNull();
      expect(info.bsuid).toBeNull();
    });
  });

  describe('3. Webhook Loop & Idempotency Guards', () => {
    it('detects outbound messages from Kapso to prevent echo loops', () => {
      expect(isOutboundMessage({ message: { kapso: { direction: 'outbound' } } })).toBe(true);
      expect(isOutboundMessage({ message: { direction: 'outbound' } })).toBe(true);
      expect(isOutboundMessage({ direction: 'outbound' })).toBe(true);
      expect(isOutboundMessage({ message: { from_me: true } })).toBe(true);
      expect(isOutboundMessage({ message: { kapso: { direction: 'inbound' } } })).toBe(false);
    });

    it('enforces idempotency for duplicate message IDs', () => {
      const testId = `msg_test_${Date.now()}`;
      expect(isDuplicate(testId)).toBe(false); // First time: not duplicate
      expect(isDuplicate(testId)).toBe(true);  // Second time: duplicate!
    });
  });

  describe('4. Kapso WhatsApp Sender Function (sendWhatsAppText)', () => {
    it('routes dynamically to exact phoneNumberId (sandbox vs production)', async () => {
      const originalFetch = global.fetch;
      const requestedUrls = [];
      global.fetch = async (url) => {
        requestedUrls.push(url);
        return {
          ok: true,
          status: 200,
          json: async () => ({ messages: [{ id: 'wamid.TEST' }] }),
        };
      };

      try {
        await sendWhatsAppText({
          phoneNumberId: '597907523413541',
          phoneNumber: '573118588249',
          text: 'Prueba sandbox',
        });
        await sendWhatsAppText({
          phoneNumberId: '1248246475047194',
          phoneNumber: '573118588249',
          text: 'Prueba producción',
        });

        expect(requestedUrls[0]).toContain('597907523413541/messages');
        expect(requestedUrls[1]).toContain('1248246475047194/messages');
      } finally {
        global.fetch = originalFetch;
      }
    });

    it('throws KapsoValidationError if text is empty', async () => {
      await expect(
        sendWhatsAppText({
          phoneNumberId: '1248246475047194',
          phoneNumber: '573118588249',
          text: '',
        })
      ).rejects.toThrow(KapsoValidationError);
    });

    it('throws KapsoValidationError if neither phoneNumber nor bsuid is provided', async () => {
      await expect(
        sendWhatsAppText({
          phoneNumberId: '1248246475047194',
          phoneNumber: null,
          bsuid: null,
          text: 'Hola',
        })
      ).rejects.toThrow(KapsoValidationError);
    });

    it('correctly uses to for phone numbers and recipient exclusively for BSUIDs', async () => {
      const originalFetch = global.fetch;
      const capturedPayloads = [];

      global.fetch = async (url, options) => {
        const body = JSON.parse(options.body);
        capturedPayloads.push({ url, body });
        return {
          ok: true,
          status: 200,
          json: async () => ({
            messages: [{ id: 'wamid.MOCK_TEST_123' }],
          }),
        };
      };

      try {
        // Test with BSUID (recipient field)
        const resBsuid = await sendWhatsAppText({
          phoneNumberId: '1248246475047194',
          phoneNumber: null,
          bsuid: 'CO.1552339023039755',
          text: 'Verificación mock entrega BSUID.',
        });

        expect(resBsuid.success).toBe(true);
        expect(resBsuid.recipientType).toBe('bsuid');
        expect(capturedPayloads[0].body.recipient).toBe('CO.1552339023039755');
        expect(capturedPayloads[0].body.to).toBeUndefined();

        // Test with Phone number (to field)
        const resPhone = await sendWhatsAppText({
          phoneNumberId: '1248246475047194',
          phoneNumber: '573046154163',
          bsuid: null,
          text: 'Verificación mock entrega Phone.',
        });

        expect(resPhone.success).toBe(true);
        expect(resPhone.recipientType).toBe('phone');
        expect(capturedPayloads[1].body.to).toBe('573046154163');
        expect(capturedPayloads[1].body.recipient).toBeUndefined();
      } finally {
        global.fetch = originalFetch;
      }
    });
  });

  describe('5. Reminder Prefix Idempotency & Stripping', () => {
    it('strips single and nested reminder prefixes properly', async () => {
      const { stripReminderPrefix } = await import('../src/utils/kapso.js');
      expect(stripReminderPrefix('⏰ *Recordatorio:* Comprar leche')).toBe('Comprar leche');
      expect(stripReminderPrefix('⏰ Recordatorio: Comprar leche')).toBe('Comprar leche');
      expect(stripReminderPrefix('*Recordatorio:* Comprar leche')).toBe('Comprar leche');
      expect(stripReminderPrefix('Recordatorio: Comprar leche')).toBe('Comprar leche');
      expect(stripReminderPrefix('⏰ Recordatorio: ⏰ *Recordatorio:* Comprar leche')).toBe('Comprar leche');
      expect(stripReminderPrefix('Comprar leche')).toBe('Comprar leche');
      expect(stripReminderPrefix('')).toBe('');
      expect(stripReminderPrefix(null)).toBe('');
    });
  });

  describe('6. WhatsApp Template Sending & 24h Window Fallback', () => {
    it('structures template payload with components and parameters correctly', async () => {
      const { sendWhatsAppTemplate } = await import('../src/utils/kapso.js');
      const originalFetch = global.fetch;
      let capturedPayload = null;

      global.fetch = async (url, options) => {
        capturedPayload = JSON.parse(options.body);
        return {
          ok: true,
          status: 200,
          json: async () => ({ messages: [{ id: 'wamid.TEMPLATE_TEST_123' }] }),
        };
      };

      try {
        const res = await sendWhatsAppTemplate({
          phoneNumber: '573046154163',
          templateName: 'reminder_task_one_reminder',
          languageCode: 'es',
          parameters: ['Preguntar si todavía está lloviendo 🌧️'],
        });

        expect(res.success).toBe(true);
        expect(capturedPayload.type).toBe('template');
        expect(capturedPayload.template.name).toBe('reminder_task_one_reminder');
        expect(capturedPayload.template.language.code).toBe('es');
        expect(capturedPayload.template.components[0].parameters).toHaveLength(1);
        expect(capturedPayload.template.components[0].parameters[0].text).toBe('Preguntar si todavía está lloviendo 🌧️');
      } finally {
        global.fetch = originalFetch;
      }
    });

    it('falls back to template when sendReminderMessage forces template or window is closed', async () => {
      const { sendReminderMessage } = await import('../src/utils/kapso.js');
      const originalFetch = global.fetch;
      let capturedPayload = null;

      global.fetch = async (url, options) => {
        capturedPayload = JSON.parse(options.body);
        return {
          ok: true,
          status: 200,
          json: async () => ({ messages: [{ id: 'wamid.REMINDER_TEMPLATE_DISPATCH' }] }),
        };
      };

      try {
        const res = await sendReminderMessage('573046154163', '⏰ Recordatorio: Tomar agüita 💧', {
          forceTemplate: true,
          templateName: 'reminder_task_one_reminder',
        });

        expect(res.success).toBe(true);
        expect(capturedPayload.type).toBe('template');
        expect(capturedPayload.template.components[0].parameters[0].text).toBe('Tomar agüita 💧');
      } finally {
        global.fetch = originalFetch;
      }
    });
  });
});
