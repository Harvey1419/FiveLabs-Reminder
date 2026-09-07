import { supabase, getUserIntegration } from '../../infrastructure/database/index.js';
import { hasUsableGoogleCredentials, isGoogleAuthError } from '../../integrations/google/auth.js';
import {
  resolveCalendarTemporalScope,
  formatLocalDateTime,
  formatHumanFriendlyDateTime,
} from '../../shared/time.js';
import { listCalendarEvents, normalizeCalendarEvent } from '../../integrations/google/calendar.js';

const DEFAULT_TIMEZONE = 'America/Bogota';

function isAllPendingScope(scope) {
  return new Set(['all', 'all_pending', 'todos', 'pendientes', 'todos_los_pendientes']).has(
    String(scope || '').toLowerCase().trim(),
  );
}

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
  const temporal = resolveCalendarTemporalScope({ scope, date, dateFrom, dateTo }, tz);
  const timeMin = temporal.timeMin;
  const timeMax = temporal.timeMax;
  const timeMinIso = timeMin instanceof Date ? timeMin.toISOString() : String(timeMin);
  const timeMaxIso = timeMax instanceof Date ? timeMax.toISOString() : String(timeMax);
  const allPending = isAllPendingScope(scope);

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
        .is('acknowledged_at', null)
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

      return (data || []).map((reminder) => {
        const dateObj = new Date(reminder.send_at);
        const timeFormatter = new Intl.DateTimeFormat('es-CO', {
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
          localFormatted: formatLocalDateTime(dateObj, tz, language === 'en' ? 'en-US' : 'es-CO'),
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
          const timeFormatter = new Intl.DateTimeFormat('es-CO', {
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

  const formattedCard = formatUnifiedAgendaCard({ calendar, reminders, tasks, scope, timezone: tz, language });
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
      raw: task,
    });
  }

  return { scope, timeMin, timeMax, calendar, reminders, tasks, items: orderedItems, formattedCard };
}

function scopeLabelFor(scope, isEn) {
  const weekdaysEs = {
    monday: 'el lunes', tuesday: 'el martes', wednesday: 'el miércoles', thursday: 'el jueves',
    friday: 'el viernes', saturday: 'el sábado', sunday: 'el domingo', day_after_tomorrow: 'pasado mañana',
  };
  const weekdaysEn = {
    monday: 'Monday', tuesday: 'Tuesday', wednesday: 'Wednesday', thursday: 'Thursday',
    friday: 'Friday', saturday: 'Saturday', sunday: 'Sunday', day_after_tomorrow: 'the day after tomorrow',
  };
  if (scope === 'today') return isEn ? 'today' : 'hoy';
  if (scope === 'tomorrow') return isEn ? 'tomorrow' : 'mañana';
  if (weekdaysEs[scope]) return isEn ? weekdaysEn[scope] : weekdaysEs[scope];
  if (scope === 'this_week') return isEn ? 'this week' : 'esta semana';
  if (scope === 'next_week') return isEn ? 'next week' : 'la próxima semana';
  if (scope === 'this_weekend') return isEn ? 'this weekend' : 'este fin de semana';
  if (isAllPendingScope(scope)) return isEn ? 'current pending items' : 'tus pendientes actuales';
  if (scope === 'upcoming') return isEn ? 'upcoming schedule' : 'los próximos días';
  if (scope === 'explicit_date') return isEn ? 'that date' : 'esa fecha';
  return isEn ? 'this period' : 'este período';
}

function groupTasksByProject(tasks, language) {
  const fallback = language === 'en' ? 'No project' : 'Sin proyecto';
  const groups = new Map();
  for (const task of tasks) {
    const project = String(task.entityName || fallback).trim() || fallback;
    if (!groups.has(project)) groups.set(project, []);
    groups.get(project).push(task);
  }
  return groups;
}

function formatTaskGroups(tasks, { isMultiDay, timezone, language }) {
  return [...groupTasksByProject(tasks, language).entries()]
    .map(([project, projectTasks]) => {
      const lines = projectTasks.map((task) => {
        const time = isMultiDay
          ? (task.dueDate ? formatHumanFriendlyDateTime(task.dueDate, timezone, language) : task.localTime)
          : task.localTime;
        const timeDisplay = time ? ` — ${time}` : '';
        return `• ${task.title || task.content}${timeDisplay}`;
      });
      const projectIcon = project === (language === 'en' ? 'No project' : 'Sin proyecto') ? '📌' : '📁';
      return `${projectIcon} *${project}*\n${lines.join('\n')}`;
    })
    .join('\n\n');
}

/** Build a compact WhatsApp-first agenda card without exposing internal IDs. */
export function formatUnifiedAgendaCard({
  calendar = { state: 'DISCONNECTED', events: [] },
  reminders = [],
  tasks = [],
  scope = 'tomorrow',
  timezone = DEFAULT_TIMEZONE,
  language = 'es',
}) {
  const isEn = language === 'en';
  const calendarEvents = calendar.events || [];
  const allPending = isAllPendingScope(scope);
  const scopeLabel = scopeLabelFor(scope, isEn);
  const totalCount = calendarEvents.length + reminders.length + tasks.length;
  const isMultiDay = scope !== 'today' && scope !== 'tomorrow';

  if (totalCount === 0 && allPending) {
    const base = isEn
      ? '✅ *You are all caught up*\n\nYou have no pending reminders or tasks right now.'
      : '✅ *Estás al día*\n\nNo tienes recordatorios ni tareas pendientes en este momento.';
    if (calendar.state === 'AUTH_REQUIRED' || calendar.state === 'DISCONNECTED') {
      return `${base}\n\n📅 *Google Calendar*\n🔒 ${isEn ? 'Not connected' : 'No conectado'}`;
    }
    return base;
  }

  if (totalCount === 0) {
    if (calendar.state === 'ERROR') {
      return isEn
        ? `📅 *Your schedule for ${scopeLabel}*\n\nNo reminders or tasks scheduled.\n\n⚠️ Google Calendar is temporarily unavailable.`
        : `📅 *Tu agenda para ${scopeLabel}*\n\nNo tienes recordatorios ni tareas programadas.\n\n⚠️ Google Calendar no está disponible temporalmente.`;
    }
    if (calendar.state === 'AUTH_REQUIRED' || calendar.state === 'DISCONNECTED') {
      return isEn
        ? `📅 *Your schedule for ${scopeLabel}*\n\nNo reminders or tasks scheduled.\n\n📅 *Google Calendar*\n🔒 Not connected`
        : `📅 *Tu agenda para ${scopeLabel}*\n\nNo tienes recordatorios ni tareas programadas.\n\n📅 *Google Calendar*\n🔒 No conectado`;
    }
    return isEn
      ? `✅ Nothing scheduled for ${scopeLabel}.`
      : `✅ No tienes nada programado para ${scopeLabel}.`;
  }

  const sections = [allPending
    ? (isEn ? '📋 *Current pending items*' : '📋 *Pendientes actuales*')
    : (isEn ? `📅 *Your schedule for ${scopeLabel}*` : `📅 *Tu agenda para ${scopeLabel}*`)];

  if (calendar.state === 'CONNECTED' && calendarEvents.length > 0) {
    const lines = calendarEvents.map((event) => {
      const time = event.isAllDay
        ? (isEn ? 'All day' : 'Todo el día')
        : (isMultiDay ? (event.displayDate || event.localStartTime || '') : (event.localStartTime || ''));
      return `• ${event.summary || (isEn ? 'Event' : 'Evento')}${time ? ` — ${time}` : ''}`;
    });
    sections.push(`📅 *Google Calendar · ${calendarEvents.length}*\n${lines.join('\n')}`);
  } else if (calendar.state === 'CONNECTED') {
    sections.push(`📅 *Google Calendar*\n✅ ${isEn ? 'No events in this period' : 'Sin eventos en este período'}`);
  } else if (calendar.state === 'ERROR') {
    sections.push(`📅 *Google Calendar*\n⚠️ ${isEn ? 'Temporarily unavailable' : 'No disponible temporalmente'}`);
  } else {
    sections.push(`📅 *Google Calendar*\n🔒 ${isEn ? 'Not connected' : 'No conectado'}\n_${isEn ? 'Connect it to include your events in the agenda.' : 'Conéctalo para incluir tus eventos en la agenda.'}_`);
  }

  if (reminders.length > 0) {
    const lines = reminders.map((reminder, index) => {
      const time = isMultiDay
        ? (reminder.sendAt ? formatHumanFriendlyDateTime(reminder.sendAt, timezone, language) : reminder.localTime)
        : reminder.localTime;
      const recurrent = reminder.recurrenceRule ? (isEn ? ' · recurring' : ' · recurrente') : '';
      return `${index + 1}. ${reminder.content || reminder.title || (isEn ? 'Reminder' : 'Recordatorio')}${recurrent}${time ? `\n   🕒 ${time}` : ''}`;
    });
    sections.push(`🔔 *${isEn ? 'Reminders' : 'Recordatorios'} · ${reminders.length}*\n${lines.join('\n')}`);
  }

  if (tasks.length > 0) {
    sections.push(`☑️ *${isEn ? 'Tasks' : 'Tareas'} · ${tasks.length}*\n\n${formatTaskGroups(tasks, { isMultiDay, timezone, language })}`);
  }

  return sections.join('\n\n');
}
