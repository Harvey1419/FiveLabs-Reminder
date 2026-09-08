import { normalizePhoneNumber } from '../../integrations/whatsapp/kapso-client.js';

/**
 * Canonical tenant identity for the reminder domain.
 * Historical rows may store the same WhatsApp number with or without `+`, so
 * ownership is always evaluated against the same normalized variants.
 */
export function buildReminderOwnerContext(user = null) {
  const userId = user?.id || null;
  const phoneNumber = user?.phone_number || null;
  const cleanPhone = phoneNumber ? (normalizePhoneNumber(phoneNumber) || phoneNumber) : null;
  const phoneVariants = Array.from(new Set([
    phoneNumber,
    cleanPhone,
    cleanPhone ? `+${cleanPhone}` : null,
  ].filter(Boolean)));

  return {
    userId,
    phoneNumber,
    phoneVariants,
    hasOwner: Boolean(userId || phoneVariants.length > 0),
  };
}

export function isReminderOwned(reminder, ownerContext) {
  const { userId, phoneVariants = [] } = ownerContext || {};
  return Boolean(
    (userId && reminder?.user_id === userId)
    || (reminder?.phone_number && phoneVariants.includes(reminder.phone_number)),
  );
}

/** Apply the canonical owner boundary to a Supabase reminder query. */
export function scopeReminderQueryToOwner(query, ownerContext) {
  const { userId, phoneVariants = [] } = ownerContext || {};

  if (userId && phoneVariants.length > 0) {
    const phoneConditions = phoneVariants.map((phone) => `phone_number.eq.${phone}`).join(',');
    return query.or(`user_id.eq.${userId},${phoneConditions}`);
  }
  if (userId) return query.eq('user_id', userId);
  if (phoneVariants.length > 0) return query.in('phone_number', phoneVariants);
  return null;
}
