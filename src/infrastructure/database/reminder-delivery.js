import { supabase } from './index.js';

const ALLOWED_DELIVERY_STATUSES = new Set(['submitted', 'sent', 'delivered', 'read', 'failed']);

/**
 * Reconcile provider delivery state without letting a callback for the previous
 * occurrence overwrite the lifecycle of a recurring reminder's next run.
 */
export async function updateReminderDeliveryStatusStable({ deliveryId, deliveryStatus }) {
  if (!deliveryId || !deliveryStatus) return null;
  const normalizedStatus = String(deliveryStatus).toLowerCase();
  if (!ALLOWED_DELIVERY_STATUSES.has(normalizedStatus)) return null;

  const { data: reminder, error: readError } = await supabase
    .from('reminders')
    .select('id,status,send_at,recurrence_rule,delivery_id')
    .eq('delivery_id', deliveryId)
    .maybeSingle();

  if (readError) {
    console.warn('[reminders] delivery status lookup failed:', readError.message || readError);
    return null;
  }
  if (!reminder) return null;

  const recurring = Boolean(reminder.recurrence_rule);
  const sendAtMs = reminder.send_at ? new Date(reminder.send_at).getTime() : 0;
  const nextOccurrenceIsFuture = recurring && Number.isFinite(sendAtMs) && sendAtMs > Date.now();

  if (nextOccurrenceIsFuture) {
    // The provider status belongs to the execution that just happened. The row
    // already represents the next execution, so its scheduling state must stay
    // pending even for a late `failed`, `delivered` or `read` callback.
    const { data, error } = await supabase
      .from('reminders')
      .update({ status: 'pending' })
      .eq('id', reminder.id)
      .eq('delivery_id', deliveryId)
      .select('id,status')
      .maybeSingle();

    if (error) {
      console.warn('[reminders] recurring delivery reconciliation failed:', error.message || error);
      return null;
    }

    console.log(`[reminders] recurring delivery callback matched id=${reminder.id} providerStatus=${normalizedStatus}; next occurrence remains pending`);
    return data || { id: reminder.id, status: 'pending' };
  }

  const updates = { status: normalizedStatus === 'failed' ? 'failed' : 'sent' };
  const { data, error } = await supabase
    .from('reminders')
    .update(updates)
    .eq('id', reminder.id)
    .eq('delivery_id', deliveryId)
    .select('id,status')
    .maybeSingle();

  if (error) {
    console.warn('[reminders] delivery status reconciliation failed:', error.message || error);
    return null;
  }
  return data || null;
}
