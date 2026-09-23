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
function formatRecurringTime(friendlyTime, userLang) {
  if (!friendlyTime) return '';
  const isEs = userLang !== 'en';
  const lower = friendlyTime.charAt(0).toLowerCase() + friendlyTime.slice(1);
  if (isEs) {
    const prefix = (lower.startsWith('hoy') || lower.startsWith('mañana')) ? 'desde ' : 'desde el ';
    return `${prefix}${lower}`;
  }
  return `starting ${lower}`;
}

function buildNotificationLines(items, timezone, userLang) {
  const groups = new Map();

  for (const item of items) {
    const summary = item.summary || item.title || (userLang === 'en' ? 'Meeting' : 'Reunión');
    const normalizedKey = summary.trim().toLowerCase();
    const key = normalizedKey || item.recurringEventId || item.id;

    if (!groups.has(key)) {
      groups.set(key, {
        summary,
        recurringEventId: item.recurringEventId || null,
        instances: [],
      });
    }
    const group = groups.get(key);
    if (!group.recurringEventId && item.recurringEventId) {
      group.recurringEventId = item.recurringEventId;
    }
    group.instances.push(item);
  }

  const lines = [];
  for (const group of groups.values()) {
    group.instances.sort((a, b) => {
      const timeA = new Date(a.eventStart || a.startIso || 0).getTime();
      const timeB = new Date(b.eventStart || b.startIso || 0).getTime();
      return timeA - timeB;
    });

    const count = group.instances.length;
    const firstInstance = group.instances[0];
    const isRecurring = Boolean(group.recurringEventId || count > 1);

    if (isRecurring) {
      const friendlyTime = formatHumanFriendlyDateTime(firstInstance.eventStart || firstInstance.startIso, timezone, userLang);
      const recurringLabel = userLang === 'en' ? 'recurring series' : 'serie recurrente';
      const timeStr = formatRecurringTime(friendlyTime, userLang);
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
    // Scope query to the active horizon window to avoid PostgREST max-rows (1000) silent truncation
    const windowStartIso = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
    const windowEndIso = new Date(futureLimit.getTime() + 24 * 60 * 60 * 1000).toISOString();

    let query = supabase
      .from('reminders')
      .select('id, delivery_id, send_at, status, content')
      .eq('user_id', userId)
      .like('delivery_id', 'gcal:%')
      .in('status', ['pending', 'sent']);

    if (typeof query.gte === 'function') {
      query = query.gte('send_at', windowStartIso);
    }
    if (typeof query.lte === 'function') {
      query = query.lte('send_at', windowEndIso);
    }
    if (typeof query.order === 'function') {
      query = query.order('send_at', { ascending: true });
    }

    const { data: existingReminders, error: dbErr } = await query;

    if (dbErr) {
      console.warn(`[calendarReconciliation] Failed to fetch existing reminders for user ${userId}:`, dbErr.message);
      return { synced: false, createdCount: 0, updatedCount: 0, cancelledCount: 0, error: dbErr.message };
    }

    // Also fetch specific delivery IDs that fall outside the horizon window (e.g. from extraEvents or cancelledEventIds)
    const extraDeliveryIds = [];
    if (Array.isArray(extraEvents)) {
      for (const ev of extraEvents) {
        if (ev?.id) extraDeliveryIds.push(`gcal:${ev.id}`);
      }
    }
    if (Array.isArray(cancelledEventIds)) {
      for (const id of cancelledEventIds) {
        if (id) extraDeliveryIds.push(`gcal:${id}`);
      }
    }

    let outsideReminders = [];
    if (extraDeliveryIds.length > 0) {
      const alreadyFetchedIds = new Set((existingReminders || []).map((r) => r.delivery_id).filter(Boolean));
      const missingDeliveryIds = extraDeliveryIds.filter((id) => !alreadyFetchedIds.has(id));
      if (missingDeliveryIds.length > 0) {
        try {
          let outsideQuery = supabase
            .from('reminders')
            .select('id, delivery_id, send_at, status, content')
            .eq('user_id', userId)
            .in('delivery_id', missingDeliveryIds)
            .in('status', ['pending', 'sent']);

          const { data: outsideData } = await outsideQuery;
          if (Array.isArray(outsideData)) {
            outsideReminders = outsideData;
          }
        } catch (outsideErr) {
          console.warn(`[calendarReconciliation] Warning fetching outside companion reminders:`, outsideErr.message);
        }
      }
    }

    const combinedReminders = [...(existingReminders || []), ...outsideReminders];
    const reminderMap = new Map();
    combinedReminders.forEach((r) => {
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
          const savedReminder = await saveReminder({
            userId,
            phoneNumber: targetPhone,
            content,
            sendAt: sendAtIso,
            deliveryId,
            requiresConfirmation,
            nudgeIntervalMinutes,
            maxNudges,
          });

          if (savedReminder?.isExisting) {
            reminderMap.set(deliveryId, savedReminder);
            continue;
          }

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
      // Notification Idempotency Guard:
      // Filter out events that were already notified in a proactive meeting message within the last 24 hours
      let unannouncedEvents = newEventsToNotify;
      try {
        let msgQ = supabase
          .from('messages')
          .select('entities')
          .eq('role', 'assistant')
          .eq('intent', 'calendar');

        if (userId) msgQ = msgQ.eq('user_id', userId);
        else if (targetPhone) msgQ = msgQ.eq('phone_number', targetPhone);

        if (typeof msgQ.gte === 'function') {
          msgQ = msgQ.gte('created_at', new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString());
        }

        const { data: recentNoticeMessages } = await msgQ;

        if (Array.isArray(recentNoticeMessages) && recentNoticeMessages.length > 0) {
          const alreadyNotifiedEventIds = new Set();
          for (const msg of recentNoticeMessages) {
            const ent = msg?.entities;
            if (ent?.action === 'proactive_meeting_notification' && ent?.eventId) {
              alreadyNotifiedEventIds.add(ent.eventId);
            } else if (ent?.action === 'proactive_meeting_notification_batch' && Array.isArray(ent?.eventIds)) {
              for (const id of ent.eventIds) {
                alreadyNotifiedEventIds.add(id);
              }
            }
          }

          unannouncedEvents = newEventsToNotify.filter((e) => !alreadyNotifiedEventIds.has(e.id));
        }
      } catch (dedupErr) {
        console.warn(`[calendarReconciliation] Failed to check recent notification messages:`, dedupErr.message);
      }

      if (unannouncedEvents.length > 0) {
        const lines = buildNotificationLines(unannouncedEvents, timezone, userLang);

        let noticeText = '';
        if (lines.length === 1 && unannouncedEvents.length === 1 && !unannouncedEvents[0].recurringEventId) {
          const single = unannouncedEvents[0];
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
          entities: unannouncedEvents.length === 1
            ? { action: 'proactive_meeting_notification', eventId: unannouncedEvents[0].id, summary: unannouncedEvents[0].summary }
            : {
                action: 'proactive_meeting_notification_batch',
                count: unannouncedEvents.length,
                eventIds: unannouncedEvents.map((e) => e.id),
              },
        }).catch(() => {});
      }
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
      // Cancellation Notification Idempotency Guard:
      // Filter out cancellations that were already notified in a proactive cancellation message within the last 24 hours
      let unannouncedCancellations = cancelledRemindersToNotify;
      try {
        let cancelQ = supabase
          .from('messages')
          .select('entities')
          .eq('role', 'assistant')
          .eq('intent', 'calendar');

        if (userId) cancelQ = cancelQ.eq('user_id', userId);
        else if (targetPhone) cancelQ = cancelQ.eq('phone_number', targetPhone);

        if (typeof cancelQ.gte === 'function') {
          cancelQ = cancelQ.gte('created_at', new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString());
        }

        const { data: recentCancelMessages } = await cancelQ;

        if (Array.isArray(recentCancelMessages) && recentCancelMessages.length > 0) {
          const alreadyCancelledReminderIds = new Set();
          for (const msg of recentCancelMessages) {
            const ent = msg?.entities;
            if (ent?.action === 'proactive_meeting_cancellation' && ent?.reminderId) {
              alreadyCancelledReminderIds.add(ent.reminderId);
            } else if (ent?.action === 'proactive_meeting_cancellation_batch' && Array.isArray(ent?.reminderIds)) {
              for (const id of ent.reminderIds) {
                alreadyCancelledReminderIds.add(id);
              }
            }
          }

          unannouncedCancellations = cancelledRemindersToNotify.filter(
            (c) => !alreadyCancelledReminderIds.has(c.reminderId),
          );
        }
      } catch (dedupErr) {
        console.warn(`[calendarReconciliation] Failed to check recent cancellation messages:`, dedupErr.message);
      }

      if (unannouncedCancellations.length > 0) {
        const lines = buildNotificationLines(unannouncedCancellations, timezone, userLang);

        let cancelNoticeText = '';
        if (lines.length === 1 && unannouncedCancellations.length === 1) {
          const single = unannouncedCancellations[0];
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
          entities: unannouncedCancellations.length === 1
            ? {
                action: 'proactive_meeting_cancellation',
                reminderId: unannouncedCancellations[0].reminderId,
                deliveryId: unannouncedCancellations[0].deliveryId,
                title: unannouncedCancellations[0].title,
              }
            : {
                action: 'proactive_meeting_cancellation_batch',
                count: unannouncedCancellations.length,
                reminderIds: unannouncedCancellations.map((r) => r.reminderId),
              },
        }).catch(() => {});
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

