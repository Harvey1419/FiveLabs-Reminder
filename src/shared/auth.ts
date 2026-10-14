import { normalizePhoneNumber } from '../integrations/whatsapp/kapso-client.js';
import { createAdminPolicy } from './admin-policy.js';

export const { isAdminUser } = createAdminPolicy({
  normalizePhoneNumber: ((...args: Parameters<typeof normalizePhoneNumber>) => normalizePhoneNumber(...args)) as unknown as Parameters<typeof createAdminPolicy>[0]['normalizePhoneNumber'],
  getAdminPhoneNumbers: () => process.env.ADMIN_PHONE_NUMBERS,
});


