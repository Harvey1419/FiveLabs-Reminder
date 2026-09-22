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
function formatTimeOnly(isoString, timezone, userLang) {
  if (!isoString) return '';
  const d = new Date(isoString);
  if (Number.isNaN(d.getTime())) return '';
  const locale = userLang === 'en' ? 'en-US' : 'es-CO';
  return d.toLocaleTimeString(locale, {
    timeZone: timezone,
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });
}

function buildNotificationLines(items, timezone, userLang) {
  const groups = new Map();

  for (const item of items) {
    const key = item.recurringEventId || item.summary || item.title || item.id;
    if (!groups.has(key)) {
      groups.set(key, {
        summary: item.summary || item.title || (userLang === 'en' ? 'Meeting' : 'Reunión'),
        recurringEventId: item.recurringEventId || null,
        instances: [],
      });
    }
    groups.get(key).instances.push(item);
  }

  const lines = [];
  for (const group of groups.values()) {
    const count = group.instances.length;
    const firstInstance = group.instances[0];
    const isRecurring = Boolean(group.recurringEventId || count > 1);

    if (isRecurring) {
      const timeStr = formatTimeOnly(firstInstance.eventStart || firstInstance.startIso, timezone, userLang);
      const recurringLabel = userLang === 'en' ? 'recurring series' : 'serie recurrente';
      const timePart = timeStr ? ` — ${timeStr}` : '';
      lines.push(`• *${group.summary}* (${recurringLabel}${timePart})`);
    } else {
      const friendlyTime = formatHumanFriendlyDateTime(firstInstance.eventStart || firstInstance.startIso, timezone, userLang);
      lines.push(`• *${group.summary}* — ${friendlyTime}`);
    }
  }

  return lines;
}

export async function reconcileCalendarCompanionReminders({
  userId,
  phoneNumber = null,
  timezone = 'America/Bogota',
  defaultAdvanceMinutes = DEFAULT_ADVANCE_MINUTES,
  horizonHours = DEFAULT_RECONCILIATION_HORIZON_HOURS,
  notifyOnDiscovery = false,
  notifyEventIds = null,
  cancelledEventIds = null,
  extraEvents = null,
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
    const proactiveEventIds = Array.isArray(notifyEventIds)
      ? new Set(notifyEventIds.filter(Boolean))
      : null;

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

    if (Array.isArray(extraEvents) && extraEvents.length > 0) {
      const existingRawIds = new Set((rawEvents || []).map((ev) => ev?.id).filter(Boolean));
      for (const extra of extraEvents) {
        if (extra?.id && !existingRawIds.has(extra.id)) {
          rawEvents.push(extra);
        }
      }
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
    const newEventsToNotify = [];

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

          const shouldNotifyNewEvent = notifyOnDiscovery
            && targetPhone
            && (!proactiveEventIds || proactiveEventIds.has(event.id));

          if (shouldNotifyNewEvent) {
            newEventsToNotify.push({
              id: event.id,
              summary: event.summary,
              eventStart,
              recurringEventId: event.recurringEventId || null,
            });
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

    // Proactive new meeting notification dispatch (individual or grouped recurring batch)
    if (newEventsToNotify.length > 0) {
      const lines = buildNotificationLines(newEventsToNotify, timezone, userLang);

      let noticeText = '';
      if (lines.length === 1 && newEventsToNotify.length === 1 && !newEventsToNotify[0].recurringEventId) {
        const single = newEventsToNotify[0];
        const friendlyTime = formatHumanFriendlyDateTime(single.eventStart, timezone, userLang);
        noticeText = userLang === 'en'
          ? `📅 *New meeting scheduled on Google Calendar*\n\n• *${single.summary}*\n⏰ ${friendlyTime}\n\n🔔 I've scheduled a reminder ${defaultAdvanceMinutes} minutes before.`
          : `📅 *Nueva reunión agendada en Google Calendar*\n\n• *${single.summary}*\n⏰ ${friendlyTime}\n\n🔔 Te programé un recordatorio ${defaultAdvanceMinutes} minutos antes.`;
      } else {
        const header = userLang === 'en'
          ? (lines.length === 1 ? `📅 *New meeting scheduled on Google Calendar*` : `📅 *New meetings scheduled on Google Calendar*`)
          : (lines.length === 1 ? `📅 *Nueva reunión agendada en Google Calendar*` : `📅 *Nuevas reuniones agendadas en Google Calendar*`);
        const reminderNote = userLang === 'en'
          ? `🔔 I've scheduled reminders ${defaultAdvanceMinutes} minutes before.`
          : `🔔 Te programé recordatorios ${defaultAdvanceMinutes} minutos antes.`;

        noticeText = `${header}\n\n${lines.join('\n')}\n\n${reminderNote}`;
      }

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
        entities: newEventsToNotify.length === 1
          ? { action: 'proactive_meeting_notification', eventId: newEventsToNotify[0].id, summary: newEventsToNotify[0].summary }
          : {
              action: 'proactive_meeting_notification_batch',
              count: newEventsToNotify.length,
              eventIds: newEventsToNotify.map((e) => e.id),
            },
      }).catch(() => {});
    }

    const cancelledIdSet = Array.isArray(cancelledEventIds)
      ? new Set(cancelledEventIds.filter(Boolean))
      : (cancelledEventIds instanceof Set ? cancelledEventIds : null);
    const cancelledRemindersToNotify = [];

    // 4. Cancel orphaned companion reminders (events deleted or cancelled externally in Google)
    for (const [deliveryId, orphanReminder] of reminderMap.entries()) {
      if (orphanReminder.status === 'pending') {
        const orphanSendAtMs = new Date(orphanReminder.send_at).getTime();
        const eventId = deliveryId.startsWith('gcal:') ? deliveryId.slice(5) : null;
        const isExplicitlyCancelled = Boolean(eventId && cancelledIdSet?.has(eventId));

        // Cancel if the scheduled notification is in the future within the horizon window,
        // or if explicitly identified as cancelled in the incremental delta.
        if (orphanSendAtMs > Date.now() && (isExplicitlyCancelled || orphanSendAtMs <= futureLimit.getTime())) {
          try {
            await updateReminder(orphanReminder.id, { status: 'cancelled' }, userId);
            cancelledCount += 1;

            if (notifyOnDiscovery && targetPhone) {
              let title = (orphanReminder.content || '').replace(/^🔔\s*/, '');
              const match = title.match(/\[Google Calendar\]\s*(.*?)(?:\s+en\s+\d+\s+minutos)?$/i);
              if (match && match[1]) {
                title = match[1].trim();
              } else {
                title = title.replace(/^\[Google Calendar\]\s*/i, '').trim();
              }
              if (!title) {
                title = userLang === 'en' ? 'Meeting' : 'Reunión';
              }

              const estimatedEventStartMs = orphanSendAtMs + defaultAdvanceMinutes * 60 * 1000;
              cancelledRemindersToNotify.push({
                reminderId: orphanReminder.id,
                deliveryId,
                title,
                startIso: new Date(estimatedEventStartMs).toISOString(),
              });
            }
          } catch (cancelErr) {
            console.warn(`[calendarReconciliation] Failed to cancel orphaned reminder ${orphanReminder.id}:`, cancelErr.message);
          }
        }
      }
    }

    // Proactive cancellation notification dispatch (individual or grouped recurring batch)
    if (cancelledRemindersToNotify.length > 0) {
      const lines = buildNotificationLines(cancelledRemindersToNotify, timezone, userLang);

      let cancelNoticeText = '';
      if (lines.length === 1 && cancelledRemindersToNotify.length === 1) {
        const single = cancelledRemindersToNotify[0];
        const friendlyTime = formatHumanFriendlyDateTime(single.startIso, timezone, userLang);
        cancelNoticeText = userLang === 'en'
          ? `❌ *Meeting cancelled on Google Calendar*\n\n• *${single.title}*\n⏰ ${friendlyTime}\n\n🗑️ The companion reminder was cancelled automatically.`
          : `❌ *Reunión cancelada en Google Calendar*\n\n• *${single.title}*\n⏰ ${friendlyTime}\n\n🗑️ El recordatorio programado fue cancelado automáticamente.`;
      } else {
        const header = userLang === 'en'
          ? (lines.length === 1 ? `❌ *Meeting cancelled on Google Calendar*` : `❌ *Meetings cancelled on Google Calendar*`)
          : (lines.length === 1 ? `❌ *Reunión cancelada en Google Calendar*` : `❌ *Reuniones canceladas en Google Calendar*`);
        const cleanupNote = userLang === 'en'
          ? `🗑️ Companion reminders were cancelled automatically.`
          : `🗑️ Los recordatorios programados fueron cancelados automáticamente.`;

        cancelNoticeText = `${header}\n\n${lines.join('\n')}\n\n${cleanupNote}`;
      }

      await sendWhatsAppText({
        phoneNumber: targetPhone,
        text: cancelNoticeText,
      }).catch((err) => {
        console.warn(`[calendarReconciliation] Cancellation WhatsApp notice failed for ${targetPhone}:`, err.message);
      });

      await saveMessage({
        userId,
        phoneNumber: targetPhone,
        role: 'assistant',
        content: cancelNoticeText,
        intent: 'calendar',
        entities: cancelledRemindersToNotify.length === 1
          ? {
              action: 'proactive_meeting_cancellation',
              reminderId: cancelledRemindersToNotify[0].reminderId,
              deliveryId: cancelledRemindersToNotify[0].deliveryId,
              title: cancelledRemindersToNotify[0].title,
            }
          : {
              action: 'proactive_meeting_cancellation_batch',
              count: cancelledRemindersToNotify.length,
              reminderIds: cancelledRemindersToNotify.map((r) => r.reminderId),
            },
      }).catch(() => {});
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

