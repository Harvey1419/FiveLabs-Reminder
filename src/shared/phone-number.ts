/** Pure normalization used by domain ownership and messaging transport. */
export function normalizePhoneNumber(rawPhone: unknown) {
  if (!rawPhone || typeof rawPhone !== 'string') return null;
  const digits = rawPhone.replace(/\D/g, '');
  return digits.length >= 7 ? digits : null;
}
