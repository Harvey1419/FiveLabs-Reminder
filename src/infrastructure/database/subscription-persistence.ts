export interface SubscriptionRow extends Record<string, unknown> { id?: unknown; user_id?: unknown; mp_preapproval_id?: unknown; status?: unknown }
export interface SubscriptionUserRow extends Record<string, unknown> {}
export interface SubscriptionStorageError { code?: string; message?: string }
export interface SubscriptionQueryResult<Row> { data: Row | null; error: SubscriptionStorageError | null }
export interface SubscriptionQuery<Row> {
  select(columns?: string): SubscriptionQuery<Row>;
  eq(column: string, value: unknown): SubscriptionQuery<Row>;
  order(column: string, options: { ascending: boolean }): SubscriptionQuery<Row>;
  limit(count: number): SubscriptionQuery<Row>;
  insert(payload: Record<string, unknown>): SubscriptionQuery<Row>;
  update(payload: Record<string, unknown>): SubscriptionQuery<Row>;
  maybeSingle(): PromiseLike<SubscriptionQueryResult<Row>>;
  single(): PromiseLike<SubscriptionQueryResult<Row>>;
}
export interface SubscriptionPersistenceClient {
  from(table: 'subscriptions'): SubscriptionQuery<SubscriptionRow>;
  from(table: 'users'): SubscriptionQuery<SubscriptionUserRow>;
}
export interface SubscriptionPersistenceDependencies {
  getClient(): SubscriptionPersistenceClient;
  cancelSubscription(id: unknown): Promise<unknown>;
  now(): Date;
  logger: Pick<Console, 'error' | 'warn' | 'log'>;
}
export interface PendingSubscriptionInput { mpPreapprovalId?: unknown; amount?: unknown; plan?: unknown }
export interface SubscriptionWebhookInput { mpPreapprovalId?: unknown; preapprovalPlanId?: unknown; status?: unknown;
  nextPaymentDate?: unknown; canceledAt?: unknown; plan?: unknown }
export type SubscriptionCancellation = { success: false; error: string } | { success: true; subscription: SubscriptionRow | null; alreadyCancelled?: true };

/** The shared SDK client and remote cancellation remain lazy host capabilities. */
export function createSubscriptionPersistence({ getClient, cancelSubscription, now, logger: console }: SubscriptionPersistenceDependencies) {
  /**
   * Get latest subscription for a given user.
   *
   * @param {string} userId
   * @returns {Promise<object|null>}
   */
  async function getUserSubscription(userId: string | null | undefined): Promise<SubscriptionRow | null> {
    if (!userId) return null;

    try {
      const { data, error } = await getClient()
        .from('subscriptions')
        .select('*')
        .eq('user_id', userId)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();

      if (error && error.code !== 'PGRST116') {
        console.error('[db/subscriptions] getUserSubscription error:', error.message);
        return null;
      }

      return data || null;
    } catch (err) {
      console.error('[db/subscriptions] Unexpected error in getUserSubscription:', (err as { message?: unknown }).message);
      return null;
    }
  }

  /**
   * Get subscription by the legacy provider-identity column with associated user.
   *
   * @param {string} mpPreapprovalId
   * @returns {Promise<{subscription: object, user: object}|null>}
   */
  async function getSubscriptionByMpId(mpPreapprovalId: unknown): Promise<{ subscription: SubscriptionRow; user: SubscriptionUserRow | null } | null> {
    if (!mpPreapprovalId) return null;

    try {
      const { data: sub, error: subErr } = await getClient()
        .from('subscriptions')
        .select('*')
        .eq('mp_preapproval_id', mpPreapprovalId)
        .maybeSingle();

      if (subErr || !sub) {
        return null;
      }

      let user: SubscriptionUserRow | null = null;
      if (sub.user_id) {
        const { data: userData } = await getClient()
          .from('users')
          .select('*')
          .eq('id', sub.user_id)
          .maybeSingle();
        user = userData || null;
      }

      return { subscription: sub, user };
    } catch (err) {
      console.error('[db/subscriptions] getSubscriptionByMpId error:', (err as { message?: unknown }).message);
      return null;
    }
  }

  /**
   * Create a new pending subscription record when checkout is generated.
   *
   * @param {string} userId
   * @param {object} params
   * @param {string} params.mpPreapprovalId
   * @param {number} [params.amount=49900]
   * @param {string} [params.plan='pro']
   * @returns {Promise<object>}
   */
  async function createPendingSubscription(userId: unknown, { mpPreapprovalId, amount = 49900, plan = 'pro' }: PendingSubscriptionInput): Promise<SubscriptionRow | null> {
    const payload = {
      user_id: userId,
      mp_preapproval_id: mpPreapprovalId,
      plan,
      status: 'pending',
      amount,
      updated_at: now().toISOString(),
    };

    const { data, error } = await getClient()
      .from('subscriptions')
      .insert(payload)
      .select()
      .single();

    if (error) {
      console.error('[db/subscriptions] createPendingSubscription error:', error.message);
      throw error;
    }

    return data;
  }

  /**
   * Update subscription record using its persisted provider identity.
   *
   * @param {object} params
   * @param {string} params.mpPreapprovalId
   * @param {string} params.status - 'authorized' | 'paused' | 'cancelled' | 'pending'
   * @param {string|null} [params.nextPaymentDate] - ISO date string
   * @param {string|null} [params.canceledAt] - ISO date string
   * @param {string} [params.plan='pro']
   * @returns {Promise<object|null>}
   */
  async function updateSubscriptionFromWebhook({
    mpPreapprovalId,
    preapprovalPlanId = null,
    status,
    nextPaymentDate = null,
    canceledAt = null,
    plan = 'pro',
  }: SubscriptionWebhookInput) {
    if (!mpPreapprovalId && !preapprovalPlanId) return null;

    const updateData: Record<string, unknown> = {
      mp_preapproval_id: mpPreapprovalId,
      status,
      plan,
      updated_at: now().toISOString(),
    };

    if (nextPaymentDate) {
      updateData.next_payment_date = nextPaymentDate;
    }

    if (canceledAt) {
      updateData.canceled_at = canceledAt;
    } else if (status === 'cancelled') {
      updateData.canceled_at = now().toISOString();
    }

    // 1. Try matching by direct mp_preapproval_id
    let { data, error } = await getClient()
      .from('subscriptions')
      .update(updateData)
      .eq('mp_preapproval_id', mpPreapprovalId)
      .select()
      .maybeSingle();

    // 2. If not found and preapprovalPlanId exists, match by plan ID and link preapproval ID
    if (!data && preapprovalPlanId) {
      const res = await getClient()
        .from('subscriptions')
        .update(updateData)
        .eq('mp_preapproval_id', preapprovalPlanId)
        .select()
        .maybeSingle();
      data = res.data;
      error = res.error;
    }

    if (error) {
      console.error('[db/subscriptions] updateSubscriptionFromWebhook error:', error.message);
      throw error;
    }

    return data || null;
  }

  /**
   * Cancel user subscription locally after confirmed Stripe cancellation.
   *
   * @param {string} userId
   * @returns {Promise<{success: boolean, subscription?: object, alreadyCancelled?: boolean, error?: string}>}
   */
  async function cancelUserSubscription(userId: string | null | undefined): Promise<SubscriptionCancellation> {
    if (!userId) return { success: false, error: 'User ID is required' };

    try {
      const sub = await getUserSubscription(userId);
      if (!sub) {
        return { success: false, error: 'No subscription found for user' };
      }

      if (sub.status === 'cancelled') {
        return { success: true, subscription: sub, alreadyCancelled: true };
      }

      if (!sub.mp_preapproval_id) return { success: false, error: 'Stripe subscription identity is missing' };
      await cancelSubscription(sub.mp_preapproval_id);

      const nowIso = now().toISOString();
      const { data: updated, error: updErr } = await getClient()
        .from('subscriptions')
        .update({
          status: 'cancelled',
          canceled_at: nowIso,
          updated_at: nowIso,
        })
        .eq('id', sub.id)
        .select()
        .single();

      if (updErr) throw updErr;

      return {
        success: true,
        subscription: updated,
      };
    } catch (err) {
      console.error('[db/subscriptions] cancelUserSubscription error:', (err as { message?: unknown }).message);
      throw err;
    }
  }


  return { getUserSubscription, getSubscriptionByMpId, createPendingSubscription, updateSubscriptionFromWebhook, cancelUserSubscription };
}
