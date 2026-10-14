import { createRequire } from 'node:module';
const express = createRequire(import.meta.url)('express') as { Router(): Parameters<typeof createGoogleAuthRouter>[0]['createRouter'] extends () => infer T ? T : never };
import { generateGoogleAuthUrl, exchangeGoogleCode } from '../../integrations/google/auth.js';
import { setupGoogleCalendarWatch } from '../../integrations/google/calendar.js';
import { saveUserIntegration } from '../../infrastructure/database/index.js';
import { saveMessage } from '../../infrastructure/database/messages.js';
import { sendReminderConfirmation } from '../../integrations/whatsapp/kapso-client.js';
import { getOrCreateUserByPhone } from '../../infrastructure/database/users.js';
import { renderGoogleSuccessPage, getWhatsAppReturnUrl } from '../views/landing.js';

import { createGoogleAuthRouter } from './google-auth-handlers.js';
export const googleAuthRouter = createGoogleAuthRouter({ createRouter: () => express.Router(),
  generateGoogleAuthUrl: ((...args: Parameters<typeof generateGoogleAuthUrl>) => generateGoogleAuthUrl(...args)) as unknown as Parameters<typeof createGoogleAuthRouter>[0]['generateGoogleAuthUrl'],
  exchangeGoogleCode: ((...args: Parameters<typeof exchangeGoogleCode>) => exchangeGoogleCode(...args)) as unknown as Parameters<typeof createGoogleAuthRouter>[0]['exchangeGoogleCode'],
  setupGoogleCalendarWatch: ((...args: Parameters<typeof setupGoogleCalendarWatch>) => setupGoogleCalendarWatch(...args)) as unknown as Parameters<typeof createGoogleAuthRouter>[0]['setupGoogleCalendarWatch'],
  saveUserIntegration: ((...args: Parameters<typeof saveUserIntegration>) => saveUserIntegration(...args)) as unknown as Parameters<typeof createGoogleAuthRouter>[0]['saveUserIntegration'],
  saveMessage: ((...args: Parameters<typeof saveMessage>) => saveMessage(...args)) as unknown as Parameters<typeof createGoogleAuthRouter>[0]['saveMessage'],
  sendReminderConfirmation: ((...args: Parameters<typeof sendReminderConfirmation>) => sendReminderConfirmation(...args)) as unknown as Parameters<typeof createGoogleAuthRouter>[0]['sendReminderConfirmation'],
  getOrCreateUserByPhone: ((...args: Parameters<typeof getOrCreateUserByPhone>) => getOrCreateUserByPhone(...args)) as unknown as Parameters<typeof createGoogleAuthRouter>[0]['getOrCreateUserByPhone'],
  renderGoogleSuccessPage: ((...args: Parameters<typeof renderGoogleSuccessPage>) => renderGoogleSuccessPage(...args)) as unknown as Parameters<typeof createGoogleAuthRouter>[0]['renderGoogleSuccessPage'],
  getWhatsAppReturnUrl: ((...args: Parameters<typeof getWhatsAppReturnUrl>) => getWhatsAppReturnUrl(...args)) as unknown as Parameters<typeof createGoogleAuthRouter>[0]['getWhatsAppReturnUrl'],
  logger: console,
});


