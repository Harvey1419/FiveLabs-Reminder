import { normalizePhoneNumber } from './phone-number.js';
import { createAdminPolicy } from './admin-policy.js';

export const { isAdminUser } = createAdminPolicy({
  normalizePhoneNumber,
  getAdminPhoneNumbers: () => process.env.ADMIN_PHONE_NUMBERS,
});


