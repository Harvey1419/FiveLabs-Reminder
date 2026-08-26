import { normalizePhoneNumber } from './kapso.js';

/**
 * Check if a user has administrative privileges.
 * 
 * An admin is authorized if:
 * 1. `user.is_admin === true` in their database record, OR
 * 2. Their phone number matches any entry in `process.env.ADMIN_PHONE_NUMBERS`
 *    (defaults to '573046154163').
 *
 * @param {object} user - User profile object { id, phone_number, is_admin, ... }
 * @returns {boolean}
 */
export function isAdminUser(user) {
  if (!user) return false;
  if (user.is_admin === true) return true;

  const rawAdminPhones = process.env.ADMIN_PHONE_NUMBERS || '573046154163';
  const adminPhones = rawAdminPhones
    .split(',')
    .map(p => {
      const trimmed = p.trim();
      return normalizePhoneNumber(trimmed) || trimmed.replace(/\D/g, '');
    })
    .filter(Boolean);

  if (!user.phone_number) return false;

  const userPhone = normalizePhoneNumber(user.phone_number) || String(user.phone_number).replace(/\D/g, '').trim();

  return Boolean(userPhone && adminPhones.includes(userPhone));
}
