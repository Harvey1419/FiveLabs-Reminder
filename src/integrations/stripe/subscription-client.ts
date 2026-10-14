export interface StripeCancellation extends Record<string, unknown> { id: string; status: 'canceled' }
export interface StripeSubscriptionDependencies {
  getEnvironment(): Readonly<Record<string, string | undefined>>;
  fetch: typeof fetch;
  assertTurnLease(): Promise<void>;
  currentTurnSignal(): AbortSignal | undefined;
}
/** Cancel once; local persistence is allowed only after Stripe confirms this exact identity. */
export function createStripeSubscriptionClient({ getEnvironment, fetch, assertTurnLease, currentTurnSignal }: StripeSubscriptionDependencies) {
  async function cancelStripeSubscription(id: unknown): Promise<StripeCancellation> {
    await assertTurnLease();
    if (typeof id !== 'string' || !/^sub_[a-zA-Z0-9_]+$/.test(id)) throw Error('Unsupported Stripe subscription identity');
    const key = getEnvironment().STRIPE_SECRET_KEY;
    if (!key) throw Error('Stripe cancellation requires STRIPE_SECRET_KEY');
    const signals = [AbortSignal.timeout(15000), currentTurnSignal()].filter((signal): signal is AbortSignal => Boolean(signal));
    const response = await fetch(`https://api.stripe.com/v1/subscriptions/${id}`, {
      method: 'DELETE', headers: { Authorization: `Basic ${Buffer.from(`${key}:`).toString('base64')}` }, signal: AbortSignal.any(signals),
    });
    const data: unknown = await response.json();
    if (!response.ok) throw Error(`Stripe cancellation rejected (HTTP ${response.status})`);
    if (!data || typeof data !== 'object' || !('id' in data) || data.id !== id || !('status' in data) || data.status !== 'canceled') throw Error('Stripe cancellation could not be confirmed');
    return data as StripeCancellation;
  }
  return { cancelStripeSubscription };
}
