import { supabase, getUserIntegration } from '../../infrastructure/database/index.js';
import { hasUsableGoogleCredentials, isGoogleAuthError } from '../../integrations/google/auth.js';
import { resolveCalendarTemporalScope, formatLocalDateTime } from '../../shared/time.js';
import { normalizeAgendaScope, isAllPendingScope } from '../../shared/agenda-scopes.js';
import { listCalendarEvents, normalizeCalendarEvent } from '../../integrations/google/calendar.js';

const DEFAULT_TIMEZONE = 'America/Bogota';

/**
 * Read-only aggregate of Calendar + Reminders + Tasks.
 * This service owns inclusion/filter truth only. Human-facing presentation is
 * deliberately handled by the shared presentation layer after execution.
 */
export async function getUnifiedAgenda({
  userId,
  phoneNumber = null,
  timezone = DEFAULT_TIMEZONE,
  scope = 'tomorrow',
  date = null,
  dateFrom = null,
  dateTo = null,
  query = null,
  language = 'es',
}) {
  const tz = timezone || DEFAULT_TIMEZONE;
  const canonicalScope = normalizeAgendaScope(scope, 'upcoming');
  const temporal = resolveCalendarTemporalScope({ scope: canonicalScope, date, dateFrom, dateTo }, tz);
  const timeMin = temporal.timeMin;
  const timeMax = temporal.timeMax;
  const timeMinIso = timeMin instanceof Date ? timeMin.toISOString() : String(timeMin);
  const timeMaxIso = timeMax instanceof Date ? timeMax.toISOString() : String(timeMax);
  const allPending = isAllPendingScope(canonicalScope);
  const locale = language === 'en' ? 'en-US' : 'es-CO';

  const [calendarResult, remindersResult, tasksResult] = await Promise.allSettled([
    (async () => {
      if (!userId) return { state: 'DISCONNECTED', events: [] };
      const integration = await getUserIntegration(userId, 'google');
      if (!hasUsableGoogleCredentials(integration)) return { state: 'DISCONNECTED', events: [] };
      try {
        const rawEvents = await listCalendarEvents(userId, {
          timeMin,
          timeMax,
          timezone: tz,
          maxResults: temporal.maxResults || 50,
          q: query || undefined,
        });
        const events = rawEvents.map((event) => {
          const normalized = normalizeCalendarEvent(event, tz);
          return {
            ...normalized,
            eventType: normalized.type,
            type: 'calendar_event',
            domain: 'calendar',
          };
        });
        return { state: 'CONNECTED', events };
      } catch (error) {
        console.error(`[unifiedAgenda] Google Calendar read error for user ${userId}:`, error.message);
        return {
          state: isGoogleAuthError(error) ? 'AUTH_REQUIRED' : 'ERROR',
          error: error.message,
          events: [],
        };
      }
    })(),

    (async () => {
      let reminderQuery = supabase
        .from('reminders')
        .select('*')
        .eq('status', 'pending')
        .gte('send_at', timeMinIso)
        .lt('send_at', timeMaxIso);

      if (userId && phoneNumber) reminderQuery = reminderQuery.or(`user_id.eq.${userId},phone_number.eq.${phoneNumber}`);
      else if (userId) reminderQuery = reminderQuery.eq('user_id', userId);
      else if (phoneNumber) reminderQuery = reminderQuery.eq('phone_number', phoneNumber);
      else return [];

      reminderQuery = reminderQuery.order('send_at', { ascending: true });
      const { data, error } = await reminderQuery;
      if (error) {
        console.error('[unifiedAgenda] Reminders read error:', error.message);
        return [];
      }

      // With stable recurring UUIDs, acknowledged_at describes the most recent
      // execution. It must not hide the next scheduled occurrence of a recurring
      // reminder. One-time reminders still require acknowledged_at = null.
      return (data || [])
        .filter((reminder) => Boolean(reminder.recurrence_rule) || !reminder.acknowledged_at)
        .map((reminder) => {
          const dateObj = new Date(reminder.send_at);
          const timeFormatter = new Intl.DateTimeFormat(locale, {
            timeZone: tz,
            hour: 'numeric',
            minute: '2-digit',
            hour12: true,
          });
          return {
            type: 'reminder',
            id: reminder.id,
            content: reminder.content,
            title: reminder.content,
            sendAt: reminder.send_at,
            localTime: timeFormatter.format(dateObj),
            localFormatted: formatLocalDateTime(dateObj, tz, locale),
            recurrenceRule: reminder.recurrence_rule,
            requiresConfirmation: reminder.requires_confirmation,
          };
        });
    })(),

    (async () => {
      if (!userId) return [];
      let taskQuery = supabase
        .from('tasks')
        .select('*, entities:entity_id(id, name, category)')
        .eq('user_id', userId)
        .eq('status', 'pending');

      if (!allPending) {
        taskQuery = taskQuery
          .gte('due_date', timeMinIso)
          .lt('due_date', timeMaxIso);
      }

      taskQuery = taskQuery.order('due_date', { ascending: true, nullsFirst: false });
      const { data, error } = await taskQuery;
      if (error) {
        console.error('[unifiedAgenda] Tasks read error:', error.message);
        return [];
      }

      return (data || []).map((task) => {
        let localTime = null;
        if (task.due_date) {
          const dateObj = new Date(task.due_date);
          const timeFormatter = new Intl.DateTimeFormat(locale, {
            timeZone: tz,
            hour: 'numeric',
            minute: '2-digit',
            hour12: true,
          });
          localTime = timeFormatter.format(dateObj);
        }
        return {
          type: 'task',
          id: task.id,
          title: task.title || task.content,
          content: task.title || task.content,
          dueDate: task.due_date,
          localTime,
          entityName: task.entities?.name || null,
          priority: task.priority,
        };
      });
    })(),
  ]);

  const calendar = calendarResult.status === 'fulfilled'
    ? calendarResult.value
    : { state: 'ERROR', error: calendarResult.reason?.message, events: [] };
  const reminders = remindersResult.status === 'fulfilled' ? remindersResult.value : [];
  const tasks = tasksResult.status === 'fulfilled' ? tasksResult.value : [];

  const orderedItems = [];
  let position = 1;

  for (const event of calendar.events || []) {
    orderedItems.push({
      position: position++,
      type: 'calendar_event',
      internalId: event.id,
      summary: event.summary,
      time: event.localStartTime || (event.isAllDay ? (language === 'en' ? 'All day' : 'Todo el día') : null),
      source: 'calendar',
      raw: event,
    });
  }
  for (const reminder of reminders) {
    orderedItems.push({
      position: position++,
      type: 'reminder',
      internalId: reminder.id,
      summary: reminder.content || reminder.title,
      time: reminder.localTime || null,
      source: 'reminder',
      raw: reminder,
    });
  }
  for (const task of tasks) {
    orderedItems.push({
      position: position++,
      type: 'task',
      internalId: task.id,
      summary: task.title || task.content,
      time: task.localTime || null,
      source: 'task',
      entityName: task.entityName || null,
      raw: task,
    });
  }

  return {
    scope: canonicalScope,
    timezone: tz,
    locale,
    timeMin,
    timeMax,
    calendar,
    reminders,
    tasks,
    items: orderedItems,
  };
}
