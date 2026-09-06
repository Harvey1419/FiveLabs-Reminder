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
import { sendReminderMessage, sendReminderConfirmation, stripReminderPrefix } from '../integrations/whatsapp/kapso-client.js';
import { saveWorkingMemory } from '../agent/core/working-memory.js';

const CHECK_INTERVAL_MS = 15 * 1000;
const MAX_STALE_MS = 2 * 60 * 60 * 1000; // 2 hours: reminders older than 2h after downtime are marked missed
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

const WORKER_ID = process.env.WORKER_ID || `worker-${process.pid}-${Math.random().toString(36).slice(2, 7)}`;

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

  // Downtime Recovery: If reminder is stale by > 2 hours, mark as missed
  if (now - sendAtMs > MAX_STALE_MS) {
    console.warn(`[scheduler worker=${WORKER_ID}] reminder ${reminder.id} missed (expired ${Math.round((now - sendAtMs) / 60000)}m ago)`);
    await markReminderAsMissed(reminder.id);
    await handleRecurrence(reminder);
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

    await markReminderAsDispatched(reminder.id, { deliveryId });
    if (reminder.requires_confirmation) {
      const nowIso = new Date().toISOString();
      const { error: nudgeStateError } = await supabase.from('reminders').update({
        last_nudged_at: nowIso,
        nudge_count: 0,
      }).eq('id', reminder.id);
      if (nudgeStateError) throw nudgeStateError;
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

    console.log(`[scheduler worker=${WORKER_ID}] reminder sent ok: ${reminder.id} ("${reminder.content}") deliveryId=${deliveryId}`);

    // Schedule next recurrence if configured
    await handleRecurrence(reminder);

  } catch (error) {
    console.error(`[scheduler worker=${WORKER_ID}] failed to send reminder ${reminder.id}:`, error);
    await markReminderAsFailed(reminder.id);
  }
}

/**
 * Compute next occurrence and insert the next recurrence into DB.
 */
async function handleRecurrence(reminder) {
  if (!reminder.recurrence_rule) return;

  try {
    const currentSendAt = new Date(reminder.send_at);
    let nextSendAt = new Date(currentSendAt);
    const rule = reminder.recurrence_rule.toLowerCase().trim();

    // Advance until nextSendAt is strictly in the future (avoids cascade of stale reminders)
    while (nextSendAt.getTime() <= Date.now()) {
      if (rule === 'hourly') {
        nextSendAt.setHours(nextSendAt.getHours() + 1);
      } else if (rule.startsWith('hourly:')) {
        const hours = parseInt(rule.split(':')[1], 10) || 1;
        nextSendAt.setHours(nextSendAt.getHours() + hours);
      } else if (rule.startsWith('interval:') && rule.endsWith('m')) {
        const mins = parseInt(rule.slice(9, -1), 10) || 30;
        nextSendAt.setMinutes(nextSendAt.getMinutes() + mins);
      } else if (rule.startsWith('interval:') && rule.endsWith('h')) {
        const hours = parseInt(rule.slice(9, -1), 10) || 1;
        nextSendAt.setHours(nextSendAt.getHours() + hours);
      } else if (rule === 'daily') {
        nextSendAt.setDate(nextSendAt.getDate() + 1);
      } else if (rule === 'weekly' || rule.startsWith('weekly:')) {
        nextSendAt.setDate(nextSendAt.getDate() + 7);
      } else if (rule === 'monthly') {
        nextSendAt.setMonth(nextSendAt.getMonth() + 1);
      } else if (rule === 'weekdays') {
        nextSendAt.setDate(nextSendAt.getDate() + 1);
        if (nextSendAt.getDay() === 6) nextSendAt.setDate(nextSendAt.getDate() + 2);
        else if (nextSendAt.getDay() === 0) nextSendAt.setDate(nextSendAt.getDate() + 1);
      } else {
        nextSendAt.setDate(nextSendAt.getDate() + 1);
      }
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

    console.log(`[scheduler] scheduled next recurring reminder ("${reminder.content}") for ${nextSendAt.toISOString()}`);
  } catch (err) {
    console.error('[scheduler] handleRecurrence failed:', err);
  }
}
