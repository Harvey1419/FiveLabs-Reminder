export interface SubscriptionPolicyDependencies {
  now(): number;
  getEnvironment(): { ENFORCE_BILLING_FOR_ALL?: string | undefined; ENFORCE_BILLING?: string | undefined };
}
/** Access policy consumes observations and live configuration; it has no persistence ports. */
export function createSubscriptionPolicy({ now, getEnvironment }: SubscriptionPolicyDependencies) {
  /**
   * Check if a subscription record or user object grants Pro access.
   *
   * Rules:
   * 1. Admin users always have Pro access.
   * 2. An 'authorized' pro subscription has Pro access.
   * 3. A 'cancelled' or 'paused' pro subscription still has Pro access until next_payment_date expires.
   *
   * @param {object|null} subscription - Subscription row or object { plan, status, next_payment_date }
   * @param {object|null} [user] - Optional user object to check admin status { is_admin }
   * @returns {boolean}
   */
  function hasProAccess(value: unknown, user: unknown = null): boolean {
    const subscription = value as { plan?: unknown; status?: unknown; next_payment_date?: unknown } | null | undefined;
    if ((user as { is_admin?: unknown } | null | undefined)?.is_admin === true) {
      return true;
    }

    // Explicit free subscription record or missing subscription denies Pro access
    if (!subscription || subscription.plan === 'free' || subscription.plan !== 'pro') {
      return false;
    }

    // Active / authorized subscription
    if (subscription.status === 'authorized' || subscription.status === 'active') {
      if (subscription.next_payment_date) {
        const expiry = new Date(subscription.next_payment_date as string | number).getTime();
        // Allow a 2-day grace period for renewal webhooks processing
        const gracePeriodMs = 2 * 24 * 60 * 60 * 1000;
        return expiry + gracePeriodMs > now();
      }
      return true;
    }

    // Cancelled or paused subscription but still within the paid period
    if ((subscription.status === 'cancelled' || subscription.status === 'paused') && subscription.next_payment_date) {
      const expiry = new Date(subscription.next_payment_date as string | number).getTime();
      return expiry > now();
    }

    return false;
  }

  /**
   * Check if the experimental billing enforcement applies to this user.
   * Currently, ONLY canonical test number 19164158325 is subject to the experimental Free/Pro billing gate.
   * All other existing, new, BSUID, and standard phone users are exempt from the experimental restriction.
   *
   * @param {object|null} user - Canonical user object { phone_number, id, ... }
   * @returns {boolean}
   */
  function shouldEnforceBillingForUser(value: unknown): boolean {
    const user = value as { is_admin?: unknown; phone_number?: unknown } | null | undefined;
    if (!user || user.is_admin === true) return false;
    if (getEnvironment().ENFORCE_BILLING_FOR_ALL === 'true' || getEnvironment().ENFORCE_BILLING === 'true') {
      return true;
    }
    const rawPhone = (user.phone_number || '') as string;
    const digits = String(rawPhone).replace(/\D/g, '');
    return digits.includes('19164158325') || rawPhone.includes('19164158325');
  }

  return { hasProAccess, shouldEnforceBillingForUser };
}
