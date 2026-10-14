export interface AdminPolicyDependencies {
  normalizePhoneNumber(value: unknown): string | null;
  getAdminPhoneNumbers(): string | undefined;
}

/** The host owns phone normalization and live administrator configuration. */
export function createAdminPolicy({ normalizePhoneNumber, getAdminPhoneNumbers }: AdminPolicyDependencies) {

  /**
   * Check if a user has administrative privileges.
   *
   * An admin is authorized if:
   * 1. `user.is_admin === true` in their database record, OR
   * 2. Their phone number matches any entry in `getAdminPhoneNumbers()`
   *    (defaults to '573046154163').
   *
   * @param {object} user - User profile object { id, phone_number, is_admin, ... }
   * @returns {boolean}
   */
  function isAdminUser(value: unknown): boolean {
    if (!value) return false;
    const user = value as { is_admin?: unknown; phone_number?: unknown };
    if (user.is_admin === true) return true;

    const rawAdminPhones = getAdminPhoneNumbers() || '573046154163';
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

  return { isAdminUser };
}
