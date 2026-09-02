import { supabase } from './index.js';
import { cancelPreapproval } from '../services/mercadopago.js';

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
export function hasProAccess(subscription, user = null) {
  if (user?.is_admin === true) {
    return true;
  }

  // Explicit free subscription record or missing subscription denies Pro access
  if (!subscription || subscription.plan === 'free' || subscription.plan !== 'pro') {
    return false;
  }

  // Active / authorized subscription
  if (subscription.status === 'authorized' || subscription.status === 'active') {
    if (subscription.next_payment_date) {
      const expiry = new Date(subscription.next_payment_date).getTime();
      // Allow a 2-day grace period for renewal webhooks processing
      const gracePeriodMs = 2 * 24 * 60 * 60 * 1000;
      return expiry + gracePeriodMs > Date.now();
    }
    return true;
  }

  // Cancelled or paused subscription but still within the paid period
  if ((subscription.status === 'cancelled' || subscription.status === 'paused') && subscription.next_payment_date) {
    const expiry = new Date(subscription.next_payment_date).getTime();
    return expiry > Date.now();
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
export function shouldEnforceBillingForUser(user) {
  if (!user) return false;
  const rawPhone = user.phone_number || '';
  const digits = String(rawPhone).replace(/\D/g, '');
  return digits.includes('19164158325') || rawPhone.includes('19164158325');
}

/**
 * Get latest subscription for a given user.
 *
 * @param {string} userId
 * @returns {Promise<object|null>}
 */
export async function getUserSubscription(userId) {
  if (!userId) return null;

  try {
    const { data, error } = await supabase
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
    console.error('[db/subscriptions] Unexpected error in getUserSubscription:', err.message);
    return null;
  }
}

/**
 * Get subscription by MercadoPago preapproval ID with associated user.
 *
 * @param {string} mpPreapprovalId
 * @returns {Promise<{subscription: object, user: object}|null>}
 */
export async function getSubscriptionByMpId(mpPreapprovalId) {
  if (!mpPreapprovalId) return null;

  try {
    const { data: sub, error: subErr } = await supabase
      .from('subscriptions')
      .select('*')
      .eq('mp_preapproval_id', mpPreapprovalId)
      .maybeSingle();

    if (subErr || !sub) {
      return null;
    }

    let user = null;
    if (sub.user_id) {
      const { data: userData } = await supabase
        .from('users')
        .select('*')
        .eq('id', sub.user_id)
        .maybeSingle();
      user = userData || null;
    }

    return { subscription: sub, user };
  } catch (err) {
    console.error('[db/subscriptions] getSubscriptionByMpId error:', err.message);
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
export async function createPendingSubscription(userId, { mpPreapprovalId, amount = 49900, plan = 'pro' }) {
  const payload = {
    user_id: userId,
    mp_preapproval_id: mpPreapprovalId,
    plan,
    status: 'pending',
    amount,
    updated_at: new Date().toISOString(),
  };

  const { data, error } = await supabase
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
 * Update subscription record from MercadoPago webhook event data.
 *
 * @param {object} params
 * @param {string} params.mpPreapprovalId
 * @param {string} params.status - 'authorized' | 'paused' | 'cancelled' | 'pending'
 * @param {string|null} [params.nextPaymentDate] - ISO date string
 * @param {string|null} [params.canceledAt] - ISO date string
 * @param {string} [params.plan='pro']
 * @returns {Promise<object|null>}
 */
export async function updateSubscriptionFromWebhook({
  mpPreapprovalId,
  preapprovalPlanId = null,
  status,
  nextPaymentDate = null,
  canceledAt = null,
  plan = 'pro',
}) {
  if (!mpPreapprovalId && !preapprovalPlanId) return null;

  const updateData = {
    mp_preapproval_id: mpPreapprovalId,
    status,
    plan,
    updated_at: new Date().toISOString(),
  };

  if (nextPaymentDate) {
    updateData.next_payment_date = nextPaymentDate;
  }

  if (canceledAt) {
    updateData.canceled_at = canceledAt;
  } else if (status === 'cancelled') {
    updateData.canceled_at = new Date().toISOString();
  }

  // 1. Try matching by direct mp_preapproval_id
  let { data, error } = await supabase
    .from('subscriptions')
    .update(updateData)
    .eq('mp_preapproval_id', mpPreapprovalId)
    .select()
    .maybeSingle();

  // 2. If not found and preapprovalPlanId exists, match by plan ID and link preapproval ID
  if (!data && preapprovalPlanId) {
    const res = await supabase
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
 * Cancel user subscription locally and remotely on MercadoPago.
 *
 * @param {string} userId
 * @returns {Promise<{success: boolean, subscription?: object, alreadyCancelled?: boolean, error?: string}>}
 */
export async function cancelUserSubscription(userId) {
  if (!userId) return { success: false, error: 'User ID is required' };

  try {
    const sub = await getUserSubscription(userId);
    if (!sub) {
      return { success: false, error: 'No subscription found for user' };
    }

    if (sub.status === 'cancelled') {
      return { success: true, subscription: sub, alreadyCancelled: true };
    }

    // Cancel in MercadoPago if valid preapproval ID
    if (sub.mp_preapproval_id) {
      try {
        await cancelPreapproval(sub.mp_preapproval_id);
        console.log(`[db/subscriptions] Cancelled MercadoPago preapproval: ${sub.mp_preapproval_id}`);
      } catch (mpErr) {
        console.warn(`[db/subscriptions] cancelPreapproval warning: ${mpErr.message}`);
      }
    }

    const nowIso = new Date().toISOString();
    const { data: updated, error: updErr } = await supabase
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
    console.error('[db/subscriptions] cancelUserSubscription error:', err.message);
    throw err;
  }
}

