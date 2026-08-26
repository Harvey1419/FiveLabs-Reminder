import {
  claimNextDueReminder,
  getNextPendingReminder,
  markReminderAsSent,
  markReminderAsFailed,
  markReminderAsMissed,
  saveReminder,
  getRemindersDueForNudge,
  incrementReminderNudge,
  supabase,
} from './db/index.js';
import { sendReminderMessage, sendReminderConfirmation, stripReminderPrefix } from './utils/kapso.js';

const CHECK_INTERVAL_MS = 15 * 1000;
const MAX_STALE_MS = 2 * 60 * 60 * 1000; // 2 hours: reminders older than 2h after downtime are marked missed
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

export async function startScheduler() {
  console.log(`[scheduler] started (check interval: ${CHECK_INTERVAL_MS / 1000}s with atomic locking & persistent nudges)`);

  while (true) {
    try {
      // 1. Atomically claim and process all currently due reminders
      let claimed = await claimNextDueReminder();
      while (claimed) {
        await processReminder(claimed);
        claimed = await claimNextDueReminder();
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
      console.error('[scheduler] error in cycle:', error);
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

      await sendReminderMessage(reminder.phone_number, nudgeMessage);
      await incrementReminderNudge(reminder.id, nextCount);
      console.log(`[scheduler] Nudge #${nextCount} sent for reminder ${reminder.id} ("${reminder.content}") to ${reminder.phone_number}`);
    }
  } catch (err) {
    console.error('[scheduler] checkAndDispatchNudges error:', err);
  }
}

async function processReminder(reminder) {
  const sendAtMs = new Date(reminder.send_at).getTime();
  const now = Date.now();

  // Downtime Recovery: If reminder is stale by > 2 hours, mark as missed
  if (now - sendAtMs > MAX_STALE_MS) {
    console.warn(`[scheduler] reminder ${reminder.id} missed (expired ${Math.round((now - sendAtMs) / 60000)}m ago)`);
    await markReminderAsMissed(reminder.id);
    await handleRecurrence(reminder);
    return;
  }

  try {
    // Send clean reminder without duplicating prefix
    await sendReminderMessage(reminder.phone_number, reminder.content);

    if (reminder.requires_confirmation) {
      const nowIso = new Date().toISOString();
      await supabase
        .from('reminders')
        .update({
          status: 'sent',
          sent_at: nowIso,
          last_nudged_at: nowIso,
          nudge_count: 0,
        })
        .eq('id', reminder.id);
    } else {
      await markReminderAsSent(reminder.id);
    }

    console.log(`[scheduler] reminder sent ok: ${reminder.id} ("${reminder.content}")`);

    // Schedule next recurrence if configured
    await handleRecurrence(reminder);

  } catch (error) {
    console.error(`[scheduler] failed to send reminder ${reminder.id}:`, error);
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

    // Advance until nextSendAt is strictly in the future (avoids day-by-day cascade of stale reminders)
    while (nextSendAt.getTime() <= Date.now()) {
      if (rule === 'daily') {
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
