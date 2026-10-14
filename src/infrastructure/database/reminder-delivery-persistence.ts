import type { ReminderDependencies, ReminderStorageError } from './reminder-persistence-client.js';

export function createReminderDeliveryPersistence({ getClient, getNow, getNowMs, logger }: Pick<ReminderDependencies, 'getClient' | 'getNow' | 'getNowMs' | 'logger'>) {
  async function getRemindersDueForNudge() {
    const { data, error } = await getClient()
      .from('reminders')
      .select('id, user_id, phone_number, content, task_id, status, requires_confirmation, nudge_interval_minutes, max_nudges, nudge_count, last_nudged_at, sent_at, locale')
      .eq('status', 'sent')
      .eq('requires_confirmation', true)
      .is('acknowledged_at', null);

    if (error || !data) return [];

    const now = getNowMs();
    return data.filter(r => {
      const maxNudges = r.max_nudges ?? 5;
      const nudgeCount = r.nudge_count ?? 0;
      if (nudgeCount >= maxNudges) return false;

      const lastNudgeMs = r.last_nudged_at
        ? new Date(r.last_nudged_at).getTime()
        : (r.sent_at ? new Date(r.sent_at).getTime() : 0);

      if (!lastNudgeMs) return false;

      const intervalMs = (r.nudge_interval_minutes || 15) * 60 * 1000;
      return now >= (lastNudgeMs + intervalMs);
    });
  }

  async function incrementReminderNudge(id: string, newCount: number) {
    try {
      const { data, error } = await getClient()
        .from('reminders')
        .update({
          nudge_count: newCount,
          last_nudged_at: getNow().toISOString(),
        })
        .eq('id', id)
        .select()
        .single();

      if (error) {
        if (error.message?.includes('column') && error.message?.includes('schema cache')) {
          return { id, nudge_count: newCount, last_nudged_at: getNow().toISOString() };
        }
        throw error;
      }
      return data;
    } catch (err) {
      return { id, nudge_count: newCount, last_nudged_at: getNow().toISOString() };
    }
  }

  async function getDueReminders() {
    const { data, error } = await getClient()
      .from('reminders')
      .select('*')
      .eq('status', 'pending')
      .lte('send_at', getNow().toISOString());

    if (error) throw error;
    return data || [];
  }

  async function markReminderAsSent(id: string) {
    const { error } = await getClient()
      .from('reminders')
      .update({ status: 'sent', sent_at: getNow().toISOString() })
      .eq('id', id);

    if (error) throw error;
  }

  async function markReminderAsDispatched(id: string, { deliveryId }: { deliveryId?: string | null } = {}) {
    const { error } = await getClient()
      .from('reminders')
      .update({
        status: 'sent',
        sent_at: getNow().toISOString(),
        delivery_id: deliveryId || null,
      })
      .eq('id', id);

    if (error) throw error;
  }

  async function markReminderAsFailed(id: string) {
    const { error } = await getClient()
      .from('reminders')
      .update({ status: 'failed' })
      .eq('id', id);

    if (error) throw error;
  }

  async function updateReminderDeliveryStatus({ deliveryId, deliveryStatus }: { deliveryId?: string | null; deliveryStatus?: unknown }) {
    if (!deliveryId || !deliveryStatus) return null;
    const normalizedStatus = String(deliveryStatus).toLowerCase();
    const allowed = new Set(['submitted', 'sent', 'delivered', 'read', 'failed']);
    if (!allowed.has(normalizedStatus)) return null;

    const updates = { status: normalizedStatus === 'failed' ? 'failed' : 'sent' };

    const { data, error } = await getClient()
      .from('reminders')
      .update(updates)
      .eq('delivery_id', deliveryId)
      .select('id, status')
      .maybeSingle();
    // A database failure must not be indistinguishable from an unmatched callback.
    if (error) throw error;
    return data || null;
  }

  async function markReminderAsMissed(id: string) {
    const { error } = await getClient()
      .from('reminders')
      .update({ status: 'missed' })
      .eq('id', id);

    if (error) throw error;
  }

  async function claimNextDueReminder(workerId = 'worker-1', lockDurationSec = 120) {
    const nowIso = getNow().toISOString();
    const lockUntilIso = new Date(getNowMs() + lockDurationSec * 1000).toISOString();

    // 1. Try native Postgres RPC function with FOR UPDATE SKIP LOCKED
    try {
      const { data, error } = await getClient().rpc('claim_next_pending_reminder', {
        p_worker_id: workerId,
        p_lock_duration_sec: lockDurationSec,
      });

      if (!error && data && data.length > 0) {
        return data[0];
      }
    } catch (rpcErr) {
      // Continue to atomic client fallback
    }

    // 2. Client-side Atomic Conditional Claim Fallback with Lease Recovery:
    // Select candidate due reminders (either pending or processing with expired lock_until)
    try {
      const { data: candidates, error: candErr } = await getClient()
        .from('reminders')
        .select('*')
        .or(`status.eq.pending,and(status.eq.processing,lock_until.not.is.null,lock_until.lte.${nowIso})`)
        .lte('send_at', nowIso)
        .order('send_at', { ascending: true })
        .limit(10);

      if (candErr || !candidates || candidates.length === 0) {
        return null;
      }

      for (const candidate of candidates) {
        // Execute atomic conditional UPDATE:
        // If pending: match status = 'pending'
        // If processing: match status = 'processing' AND lock_until <= nowIso
        let updQuery = getClient()
          .from('reminders')
          .update({
            status: 'processing',
            claimed_by: workerId,
            claimed_at: nowIso,
            lock_until: lockUntilIso,
          })
          .eq('id', candidate.id);

        if (candidate.status === 'pending') {
          updQuery = updQuery.eq('status', 'pending');
        } else {
          updQuery = updQuery.eq('status', 'processing').lte('lock_until', nowIso);
        }

        const { data: claimed, error: updErr } = await updQuery.select();

        // If update succeeded and returned the row, this worker won the atomic claim!
        if (!updErr && claimed && claimed.length > 0) {
          return claimed[0];
        }
      }
    } catch (fbErr) {
      logger.error('[db] claimNextDueReminder fallback error:', (fbErr as ReminderStorageError).message);
    }

    return null;
  }

  async function getNextPendingReminder() {
    const { data, error } = await getClient()
      .from('reminders')
      .select('id, content, send_at, recurrence_rule, phone_number, status')
      .eq('status', 'pending')
      .order('send_at', { ascending: true })
      .limit(1)
      .maybeSingle();

    if (error && error.code !== 'PGRST116') throw error;
    return data || null;
  }

  return { getRemindersDueForNudge, incrementReminderNudge, getDueReminders, markReminderAsSent, markReminderAsDispatched, markReminderAsFailed, updateReminderDeliveryStatus, markReminderAsMissed, claimNextDueReminder, getNextPendingReminder };
}
