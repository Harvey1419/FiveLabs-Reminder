import {
  supabase,
  saveReminder,
  updateReminder,
  getUserIntegration,
  saveMessage,
} from '../../infrastructure/database/index.js';
import { getReminderConfirmationPreference } from '../../infrastructure/database/memories.js';
import { hasUsableGoogleCredentials } from '../../integrations/google/auth.js';
import { listCalendarEvents, normalizeCalendarEvent } from '../../integrations/google/calendar.js';
import { sendWhatsAppText } from '../../integrations/whatsapp/kapso-client.js';
import { formatHumanFriendlyDateTime } from '../../shared/time.js';

const DEFAULT_RECONCILIATION_HORIZON_HOURS = 48;
const DEFAULT_ADVANCE_MINUTES = 15;

/**
 * Reconcile external Google Calendar events with internal companion reminders Just-In-Time (JIT).
 *
 * Algorithm:
 * 1. Checks if user has an active, authenticated Google Calendar integration.
 * 2. Fetches upcoming events for the next 48 hours from Google Calendar.
 * 3. Fetches active companion reminders in the database (delivery_id LIKE 'gcal:%').
 * 4. Inserts missing companion reminders for new external Google Calendar events.
 * 5. Updates reminders if event start time was rescheduled in Google Calendar.
 * 6. Cancels pending companion reminders if the event was deleted or cancelled in Google Calendar.
 *
 * @param {object} params
 * @param {string} params.userId
 * @param {string} [params.phoneNumber]
 * @param {string} [params.timezone='America/Bogota']
 * @param {number} [params.defaultAdvanceMinutes=15]
 * @param {number} [params.horizonHours=48]
 * @returns {Promise<{synced: boolean, createdCount: number, updatedCount: number, cancelledCount: number, error?: string, reason?: string}>}
 */
export async function reconcileCalendarCompanionReminders({
  userId,
  phoneNumber = null,
  timezone = 'America/Bogota',
  defaultAdvanceMinutes = DEFAULT_ADVANCE_MINUTES,
  horizonHours = DEFAULT_RECONCILIATION_HORIZON_HOURS,
  notifyOnDiscovery = false,
  language = null,
}) {
  if (!userId) {
    return { synced: false, createdCount: 0, updatedCount: 0, cancelledCount: 0, reason: 'missing_user_id' };
  }

  try {
    const integration = await getUserIntegration(userId, 'google');
    if (!hasUsableGoogleCredentials(integration)) {
      return { synced: false, createdCount: 0, updatedCount: 0, cancelledCount: 0, reason: 'unauthenticated' };
    }

    let targetPhone = phoneNumber;
    let userLocale = null;
    try {
      const { data: userRec } = await supabase
        .from('users')
        .select('phone_number, locale')
        .eq('id', userId)
        .maybeSingle();
      if (userRec?.phone_number && !targetPhone) {
        targetPhone = userRec.phone_number;
      }
      if (userRec?.locale) {
        userLocale = userRec.locale;
      }
    } catch {
      // Fallback without phone
    }
    const userLang = language || (userLocale?.startsWith('en') ? 'en' : 'es');

    // Check user confirmation memory preference
    let requiresConfirmation = true;
    let nudgeIntervalMinutes = 15;
    let maxNudges = 5;
    try {
      const memoryPref = await getReminderConfirmationPreference(userId);
      if (memoryPref) {
        requiresConfirmation = memoryPref.requiresConfirmation;
        nudgeIntervalMinutes = memoryPref.intervalMinutes || 15;
        maxNudges = memoryPref.maxNudges || 5;
      }
    } catch {
      // Fall back to defaults
    }

    const now = new Date();
    const futureLimit = new Date(now.getTime() + horizonHours * 60 * 60 * 1000);

    // 1. Fetch upcoming events from Google Calendar
    let rawEvents = [];
    try {
      rawEvents = await listCalendarEvents(userId, {
        timeMin: now,
        timeMax: futureLimit,
        timezone,
        maxResults: 50,
      });
    } catch (fetchErr) {
      console.warn(`[calendarReconciliation] Failed to list Google events for user ${userId}:`, fetchErr.message);
      return { synced: false, createdCount: 0, updatedCount: 0, cancelledCount: 0, error: fetchErr.message };
    }

    const events = (rawEvents || []).map((ev) => normalizeCalendarEvent(ev, timezone));

    // 2. Fetch existing companion reminders from Supabase
    const { data: existingReminders, error: dbErr } = await supabase
      .from('reminders')
      .select('id, delivery_id, send_at, status, content')
      .eq('user_id', userId)
      .like('delivery_id', 'gcal:%')
      .in('status', ['pending', 'sent']);

    if (dbErr) {
      console.warn(`[calendarReconciliation] Failed to fetch existing reminders for user ${userId}:`, dbErr.message);
      return { synced: false, createdCount: 0, updatedCount: 0, cancelledCount: 0, error: dbErr.message };
    }

    const reminderMap = new Map();
    (existingReminders || []).forEach((r) => {
      if (r.delivery_id) reminderMap.set(r.delivery_id, r);
    });

    let createdCount = 0;
    let updatedCount = 0;
    let cancelledCount = 0;

    // 3. Reconcile Google events -> Reminders
    for (const event of events) {
      const eventStart =
        event.startIso ||
        (typeof event.start === 'object' ? event.start?.dateTime || event.start?.date : event.start) ||
        (event.sortTimestamp ? new Date(event.sortTimestamp).toISOString() : null);

      if (event.isAllDay || !eventStart) continue;

      const eventStartMs = new Date(eventStart).getTime();
      if (Number.isNaN(eventStartMs)) continue;

      const triggerMs = eventStartMs - defaultAdvanceMinutes * 60 * 1000;
      if (triggerMs <= Date.now()) {
        // Event notification window has already passed
        continue;
      }

      const sendAtIso = new Date(triggerMs).toISOString();
      const deliveryId = `gcal:${event.id}`;
      const existing = reminderMap.get(deliveryId);

      if (!existing) {
        // Missing companion reminder: JIT Insert
        try {
          const content = `🔔 [Google Calendar] ${event.summary} en ${defaultAdvanceMinutes} minutos`;
          await saveReminder({
            userId,
            phoneNumber: targetPhone,
            content,
            sendAt: sendAtIso,
            deliveryId,
            requiresConfirmation,
            nudgeIntervalMinutes,
            maxNudges,
          });
          createdCount += 1;

          if (notifyOnDiscovery && targetPhone) {
            const friendlyTime = formatHumanFriendlyDateTime(eventStart, timezone, userLang);
            const noticeText = userLang === 'en'
              ? `📅 *New meeting scheduled on Google Calendar*\n\n• *${event.summary}*\n⏰ ${friendlyTime}\n\n🔔 I've scheduled a reminder ${defaultAdvanceMinutes} minutes before.`
              : `📅 *Nueva reunión agendada en Google Calendar*\n\n• *${event.summary}*\n⏰ ${friendlyTime}\n\n🔔 Te programé un recordatorio ${defaultAdvanceMinutes} minutos antes.`;

            await sendWhatsAppText({
              phoneNumber: targetPhone,
              text: noticeText,
            }).catch((err) => {
              console.warn(`[calendarReconciliation] Proactive WhatsApp notice failed for ${targetPhone}:`, err.message);
            });

            await saveMessage({
              userId,
              phoneNumber: targetPhone,
              role: 'assistant',
              content: noticeText,
              intent: 'calendar',
              entities: { action: 'proactive_meeting_notification', eventId: event.id, summary: event.summary },
            }).catch(() => {});
          }
        } catch (insertErr) {
          console.warn(`[calendarReconciliation] Failed to insert reminder for event ${event.id}:`, insertErr.message);
        }
      } else {
        // Existing reminder: Check if rescheduled
        if (existing.status === 'pending' && existing.send_at !== sendAtIso) {
          try {
            await updateReminder(existing.id, { send_at: sendAtIso }, userId);
            updatedCount += 1;
          } catch (updateErr) {
            console.warn(`[calendarReconciliation] Failed to reschedule reminder ${existing.id}:`, updateErr.message);
          }
        }
        // Mark as matched
        reminderMap.delete(deliveryId);
      }
    }

    // 4. Cancel orphaned companion reminders (events deleted or cancelled externally in Google)
    for (const [deliveryId, orphanReminder] of reminderMap.entries()) {
      if (orphanReminder.status === 'pending') {
        const orphanSendAtMs = new Date(orphanReminder.send_at).getTime();
        // Only cancel if the scheduled notification is in the future within the horizon window
        if (orphanSendAtMs > Date.now() && orphanSendAtMs <= futureLimit.getTime()) {
          try {
            await updateReminder(orphanReminder.id, { status: 'cancelled' }, userId);
            cancelledCount += 1;
          } catch (cancelErr) {
            console.warn(`[calendarReconciliation] Failed to cancel orphaned reminder ${orphanReminder.id}:`, cancelErr.message);
          }
        }
      }
    }

    console.log(
      `[calendarReconciliation] JIT sync completed for user ${userId}: created=${createdCount}, updated=${updatedCount}, cancelled=${cancelledCount}`,
    );

    return {
      synced: true,
      createdCount,
      updatedCount,
      cancelledCount,
    };
  } catch (err) {
    console.error(`[calendarReconciliation] Unexpected error for user ${userId}:`, err);
    return { synced: false, createdCount: 0, updatedCount: 0, cancelledCount: 0, error: err.message };
  }
}

