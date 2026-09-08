import {
  claimNextDueReminder,
  getNextPendingReminder,
  markReminderAsDispatched,
  markReminderAsFailed,
  markReminderAsMissed,
  saveReminder,
  getRemindersDueForNudge,
  incrementReminderNudge,
  getLatestInboundPhoneNumberId,
  supabase,
} from '../infrastructure/database/index.js';
import { sendReminderMessage, stripReminderPrefix } from '../integrations/whatsapp/kapso-client.js';
import { saveWorkingMemory } from '../agent/core/working-memory.js';
import { computeNextRecurringSendAt } from '../shared/reminder-recurrence.js';

const CHECK_INTERVAL_MS = 15 * 1000;
const MAX_STALE_MS = 2 * 60 * 60 * 1000; // 2 hours: reminders older than 2h after downtime are marked missed
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

const WORKER_ID = process.env.WORKER_ID || `worker-${process.pid}-${Math.random().toString(36).slice(2, 7)}`;

function usesStableRecurringIdentity(reminder) {
  return Boolean(reminder?.recurrence_rule) && reminder?.requires_confirmation !== true;
}

async function advanceRecurringReminderInPlace(reminder, { dispatchedAt = null } = {}) {
  const reference = dispatchedAt || new Date();
  const nextSendAt = computeNextRecurringSendAt(reminder.send_at, reminder.recurrence_rule, reference);
  if (!nextSendAt) {
    throw new Error(`Could not compute next recurrence for reminder ${reminder.id}`);
  }

  const updates = {
    send_at: nextSendAt.toISOString(),
    status: 'pending',
    claimed_by: null,
    claimed_at: null,
    lock_until: null,
    delivery_id: null,
  };
  if (dispatchedAt) {
    updates.sent_at = dispatchedAt.toISOString();
  }

  const { data, error } = await supabase
    .from('reminders')
    .update(updates)
    .eq('id', reminder.id)
    .select('id, send_at, recurrence_rule, status')
    .maybeSingle();

  if (error || !data) {
    throw error || new Error(`Recurring reminder ${reminder.id} could not be advanced.`);
  }

  console.log(
    `[scheduler worker=${WORKER_ID}] recurring reminder advanced in-place id=${reminder.id} next=${data.send_at} rule=${data.recurrence_rule}`,
  );
  return data;
}

export async function startScheduler() {
  console.log(`[scheduler] started worker=${WORKER_ID} (check interval: ${CHECK_INTERVAL_MS / 1000}s with atomic locking & persistent nudges)`);

  while (true) {
    try {
      // 1. Atomically claim and process all currently due reminders
      let claimed = await claimNextDueReminder(WORKER_ID);
      while (claimed) {
        await processReminder(claimed);
        claimed = await claimNextDueReminder(WORKER_ID);
      }

      // 2. Check and dispatch pending persistent escalation nudges
      await checkAndDispatchNudges();

      // 3. Peek at next future reminder for intelligent sleep
      const nextReminder = await getNextPendingReminder();
      if (!nextReminder) {
        await sleep(CHECK_INTERVAL_MS);
        continue;
      }

      const sendAtMs = new Date(nextReminder.send_at).getTime();
      const now = Date.now();

      if (sendAtMs <= now) {
        continue; // Immediately loop to claim
      }

      const delay = sendAtMs - now;
      const chunkMs = Math.min(delay, CHECK_INTERVAL_MS);
      await sleep(chunkMs);

    } catch (error) {
      console.error(`[scheduler worker=${WORKER_ID}] error in cycle:`, error);
      await sleep(15000);
    }
  }
}

/**
 * Dispatch escalation nudges for unacknowledged critical reminders.
 */
export async function checkAndDispatchNudges() {
  try {
    const dueForNudge = await getRemindersDueForNudge();
    for (const reminder of dueForNudge) {
      const nextCount = (reminder.nudge_count || 0) + 1;
      const cleanText = stripReminderPrefix(reminder.content);
      const isTask = Boolean(reminder.task_id);
      const nudgeMessage = isTask
        ? `🔔 ¿Pudiste completar la tarea: *${cleanText}*? (Aviso #${nextCount}). Escribe 'Listo' o 'OK' cuando termines.`
        : `🔔 *Recordatorio pendiente:* ${cleanText} (Aviso #${nextCount}). Escribe 'Listo' o 'OK' cuando lo hayas completado.`;

      const phoneNumberId = await getLatestInboundPhoneNumberId(
        reminder.phone_number,
        reminder.created_at || null,
      );
      const sendResult = await sendReminderMessage(reminder.phone_number, nudgeMessage, { phoneNumberId });
      if (!sendResult?.success || !sendResult?.messageId) {
        throw new Error(sendResult?.error || 'Kapso did not accept the reminder nudge.');
      }
      await incrementReminderNudge(reminder.id, nextCount);

      const wmPayload = {
        source: 'reminder',
        scope: 'today',
        lastAction: 'nudge',
        notificationReminderId: reminder.id,
        notificationContent: cleanText,
        items: [{
          position: 1,
          type: 'reminder',
          internalId: reminder.id,
          summary: cleanText,
          raw: reminder,
        }],
      };
      if (reminder.phone_number) saveWorkingMemory(reminder.phone_number, wmPayload);
      if (reminder.user_id) saveWorkingMemory(reminder.user_id, wmPayload);

      console.log(`[scheduler worker=${WORKER_ID}] Nudge #${nextCount} sent for reminder ${reminder.id} ("${reminder.content}") to ${reminder.phone_number}`);
    }
  } catch (err) {
    console.error(`[scheduler worker=${WORKER_ID}] checkAndDispatchNudges error:`, err);
  }
}

export async function processReminder(reminder) {
  const sendAtMs = new Date(reminder.send_at).getTime();
  const now = Date.now();
  const stableRecurring = usesStableRecurringIdentity(reminder);

  // Downtime Recovery: stale one-time reminders are marked missed. A normal
  // recurrence keeps its UUID and simply advances to its next future run.
  if (now - sendAtMs > MAX_STALE_MS) {
    console.warn(`[scheduler worker=${WORKER_ID}] reminder ${reminder.id} missed (expired ${Math.round((now - sendAtMs) / 60000)}m ago)`);
    if (stableRecurring) {
      await advanceRecurringReminderInPlace(reminder);
    } else {
      await markReminderAsMissed(reminder.id);
      await handleOccurrenceBasedRecurrence(reminder);
    }
    return;
  }

  try {
    // Send clean reminder without duplicating prefix
    const phoneNumberId = await getLatestInboundPhoneNumberId(
      reminder.phone_number,
      reminder.created_at || null,
    );
    const sendResult = await sendReminderMessage(reminder.phone_number, reminder.content, { phoneNumberId });
    if (!sendResult?.success || !sendResult?.messageId) {
      throw new Error(sendResult?.error || 'Kapso did not accept the scheduled reminder.');
    }
    const deliveryId = sendResult.messageId;
    const dispatchedAt = new Date();

    if (stableRecurring) {
      // The row itself is the recurring reminder. Do not persist the transient
      // delivery id because a later delivery callback must never flip the next
      // occurrence from pending back to sent.
      await advanceRecurringReminderInPlace(reminder, { dispatchedAt });
    } else {
      await markReminderAsDispatched(reminder.id, { deliveryId });
      if (reminder.requires_confirmation) {
        const nowIso = dispatchedAt.toISOString();
        const { error: nudgeStateError } = await supabase.from('reminders').update({
          last_nudged_at: nowIso,
          nudge_count: 0,
        }).eq('id', reminder.id);
        if (nudgeStateError) throw nudgeStateError;
      }
    }

    const cleanSummary = stripReminderPrefix(reminder.content);
    const wmPayload = {
      source: 'reminder',
      scope: 'today',
      lastAction: 'reminder_dispatched',
      notificationReminderId: reminder.id,
      notificationContent: cleanSummary,
      items: [{
        position: 1,
        type: 'reminder',
        internalId: reminder.id,
        summary: cleanSummary,
        raw: reminder,
      }],
    };
    if (reminder.phone_number) saveWorkingMemory(reminder.phone_number, wmPayload);
    if (reminder.user_id) saveWorkingMemory(reminder.user_id, wmPayload);

    console.log(`[scheduler worker=${WORKER_ID}] reminder sent ok: ${reminder.id} ("${reminder.content}") deliveryId=${deliveryId} stableRecurring=${stableRecurring}`);

    // Persistent-confirmation recurrence still needs a separate occurrence so
    // today's acknowledgement state and tomorrow's schedule can coexist.
    if (!stableRecurring) {
      await handleOccurrenceBasedRecurrence(reminder);
    }

  } catch (error) {
    console.error(`[scheduler worker=${WORKER_ID}] failed to send reminder ${reminder.id}:`, error);
    await markReminderAsFailed(reminder.id);
  }
}

/**
 * Compatibility path for recurrence that requires persistent confirmation.
 * Those reminders need two simultaneous states (current occurrence awaiting an
 * acknowledgement + next occurrence scheduled), which one DB row cannot model.
 */
async function handleOccurrenceBasedRecurrence(reminder) {
  if (!reminder.recurrence_rule) return;

  try {
    const nextSendAt = computeNextRecurringSendAt(reminder.send_at, reminder.recurrence_rule, new Date());
    if (!nextSendAt) {
      throw new Error(`Could not compute next recurrence for reminder ${reminder.id}`);
    }

    // Deduplication check: Do not insert if an identical pending recurrence is already scheduled
    const { data: existing } = await supabase
      .from('reminders')
      .select('id')
      .eq('phone_number', reminder.phone_number)
      .eq('status', 'pending')
      .eq('content', reminder.content)
      .eq('send_at', nextSendAt.toISOString())
      .maybeSingle();

    if (existing) {
      console.log(`[scheduler] recurring reminder already scheduled (${existing.id}), skipping duplicate.`);
      return;
    }

    await saveReminder({
      userId: reminder.user_id,
      phoneNumber: reminder.phone_number,
      content: reminder.content,
      sendAt: nextSendAt.toISOString(),
      recurrenceRule: reminder.recurrence_rule,
      requiresConfirmation: reminder.requires_confirmation,
      nudgeIntervalMinutes: reminder.nudge_interval_minutes,
      maxNudges: reminder.max_nudges,
    });

    console.log(`[scheduler] scheduled next confirmation-based recurrence ("${reminder.content}") for ${nextSendAt.toISOString()}`);
  } catch (err) {
    console.error('[scheduler] handleOccurrenceBasedRecurrence failed:', err);
  }
}
