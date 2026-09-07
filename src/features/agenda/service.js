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

/**
 * Pure aggregation reader for Unified Agenda.
 * Queries Calendar, Reminders, and Tasks independently in parallel without converting entities
 * or creating cross-domain ownership coupling.
 *
 * @param {object} params
 * @param {string} params.userId
 * @param {string} [params.phoneNumber]
 * @param {string} [params.timezone='America/Bogota']
 * @param {string} [params.scope='tomorrow']
 * @param {string} [params.date]
 * @param {string} [params.dateFrom]
 * @param {string} [params.dateTo]
 * @param {string} [params.query]
 * @param {string} [params.language='es']
 * @returns {Promise<object>}
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
  const temporal = resolveCalendarTemporalScope({ scope, date, dateFrom, dateTo }, tz);
  const timeMin = temporal.timeMin;
  const timeMax = temporal.timeMax;
  const timeMinIso = timeMin instanceof Date ? timeMin.toISOString() : String(timeMin);
  const timeMaxIso = timeMax instanceof Date ? timeMax.toISOString() : String(timeMax);
  const allPending = isAllPendingScope(scope);

  // 1. Parallel independent fetch across the 3 domains
  const [calendarResult, remindersResult, tasksResult] = await Promise.allSettled([
    // A. Calendar Reader Branch
    (async () => {
      if (!userId) return { state: 'DISCONNECTED', events: [] };
      const integration = await getUserIntegration(userId, 'google');
      if (!hasUsableGoogleCredentials(integration)) {
        return { state: 'DISCONNECTED', events: [] };
      }
      try {
        const rawEvents = await listCalendarEvents(userId, {
          timeMin,
          timeMax,
          timezone: tz,
          maxResults: temporal.maxResults || 50,
          q: query || undefined,
        });
        const events = rawEvents.map(ev => {
          const norm = normalizeCalendarEvent(ev, tz);
          return {
            ...norm,
            eventType: norm.type,
            type: 'calendar_event',
            domain: 'calendar',
          };
        });
        return { state: 'CONNECTED', events };
      } catch (err) {
        console.error(`[unifiedAgenda] Google Calendar read error for user ${userId}:`, err.message);
        return {
          state: isGoogleAuthError(err) ? 'AUTH_REQUIRED' : 'ERROR',
          error: err.message,
          events: [],
        };
      }
    })(),

    // B. Reminder Reader Branch
    (async () => {
      // "Pending" is a lifecycle concept, not "anything not cancelled".
      // Sent/missed/failed/elapsed rows are history and must never leak into a
      // current agenda simply because acknowledged_at is null.
      let q = supabase
        .from('reminders')
        .select('*')
        .eq('status', 'pending')
        .is('acknowledged_at', null);

      if (allPending) {
        q = q
          .gte('send_at', timeMinIso)
          .lt('send_at', timeMaxIso);
      } else {
        q = q
          .gte('send_at', timeMinIso)
          .lt('send_at', timeMaxIso);
      }

      if (userId && phoneNumber) {
        q = q.or(`user_id.eq.${userId},phone_number.eq.${phoneNumber}`);
      } else if (userId) {
        q = q.eq('user_id', userId);
      } else if (phoneNumber) {
        q = q.eq('phone_number', phoneNumber);
      } else {
        return [];
      }

      q = q.order('send_at', { ascending: true });
      const { data, error } = await q;
      if (error) {
        console.error('[unifiedAgenda] Reminders read error:', error.message);
        return [];
      }

      return (data || []).map(r => {
        const dateObj = new Date(r.send_at);
        const timeFormatter = new Intl.DateTimeFormat('es-CO', { timeZone: tz, hour: 'numeric', minute: '2-digit', hour12: true });
        return {
          type: 'reminder',
          id: r.id,
          content: r.content,
          title: r.content,
          sendAt: r.send_at,
          localTime: timeFormatter.format(dateObj),
          localFormatted: formatLocalDateTime(dateObj, tz, language === 'en' ? 'en-US' : 'es-CO'),
          recurrenceRule: r.recurrence_rule,
          requiresConfirmation: r.requires_confirmation,
        };
      });
    })(),

    // C. Task Reader Branch
    (async () => {
      if (!userId) return [];

      let q = supabase
        .from('tasks')
        .select('*, entities:entity_id(id, name, category)')
        .eq('user_id', userId)
        .eq('status', 'pending');

      // A broad pending read includes undated open tasks. A temporal agenda
      // (today/tomorrow/week/etc.) includes only tasks scheduled in that range.
      if (!allPending) {
        q = q
          .gte('due_date', timeMinIso)
          .lt('due_date', timeMaxIso);
      }

      q = q.order('due_date', { ascending: true, nullsFirst: false });
      const { data, error } = await q;

      if (error) {
        console.error('[unifiedAgenda] Tasks read error:', error.message);
        return [];
      }

      return (data || []).map(t => {
        let localTime = null;
        if (t.due_date) {
          const dateObj = new Date(t.due_date);
          const timeFormatter = new Intl.DateTimeFormat('es-CO', { timeZone: tz, hour: 'numeric', minute: '2-digit', hour12: true });
          localTime = timeFormatter.format(dateObj);
        }
        return {
          type: 'task',
          id: t.id,
          title: t.title || t.content,
          content: t.title || t.content,
          dueDate: t.due_date,
          localTime,
          entityName: t.entities?.name || null,
          priority: t.priority,
        };
      });
    })(),
  ]);

  const calendar = calendarResult.status === 'fulfilled'
    ? calendarResult.value
    : { state: 'ERROR', error: calendarResult.reason?.message, events: [] };

  const reminders = remindersResult.status === 'fulfilled'
    ? remindersResult.value
    : [];

  const tasks = tasksResult.status === 'fulfilled'
    ? tasksResult.value
    : [];

  const formattedCard = formatUnifiedAgendaCard({
    calendar,
    reminders,
    tasks,
    scope,
    timezone: tz,
    language,
  });

  const orderedItems = [];
  let pos = 1;
  for (const ev of (calendar.events || [])) {
    orderedItems.push({
      position: pos++,
      type: 'calendar_event',
      internalId: ev.id,
      summary: ev.summary,
      time: ev.localStartTime || (ev.isAllDay ? (language === 'en' ? 'All day' : 'Todo el día') : null),
      source: 'calendar',
      raw: ev,
    });
  }
  for (const r of reminders) {
    orderedItems.push({
      position: pos++,
      type: 'reminder',
      internalId: r.id,
      summary: r.content || r.title,
      time: r.localTime || null,
      source: 'reminder',
      raw: r,
    });
  }
  for (const t of tasks) {
    orderedItems.push({
      position: pos++,
      type: 'task',
      internalId: t.id,
      summary: t.title || t.content,
      time: t.localTime || null,
      source: 'task',
      raw: t,
    });
  }

  return {
    scope,
    timeMin,
    timeMax,
    calendar,
    reminders,
    tasks,
    items: orderedItems,
    formattedCard,
  };
}

/**
 * Build clean, executive Unified Agenda presentation without exposing internal IDs.
 */
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
  const totalCount = calendarEvents.length + reminders.length + tasks.length;
  const allPending = isAllPendingScope(scope);

  let scopeLabel = 'este período';
  const WEEKDAY_LABELS_ES = {
    monday: 'el lunes',
    tuesday: 'el martes',
    wednesday: 'el miércoles',
    thursday: 'el jueves',
    friday: 'el viernes',
    saturday: 'el sábado',
    sunday: 'el domingo',
    day_after_tomorrow: 'pasado mañana',
  };
  const WEEKDAY_LABELS_EN = {
    monday: 'Monday',
    tuesday: 'Tuesday',
    wednesday: 'Wednesday',
    thursday: 'Thursday',
    friday: 'Friday',
    saturday: 'Saturday',
    sunday: 'Sunday',
    day_after_tomorrow: 'the day after tomorrow',
  };

  if (scope === 'today') scopeLabel = isEn ? 'today' : 'hoy';
  else if (scope === 'tomorrow') scopeLabel = isEn ? 'tomorrow' : 'mañana';
  else if (WEEKDAY_LABELS_ES[scope]) scopeLabel = isEn ? WEEKDAY_LABELS_EN[scope] : WEEKDAY_LABELS_ES[scope];
  else if (scope === 'this_week') scopeLabel = isEn ? 'this week' : 'esta semana';
  else if (scope === 'next_week') scopeLabel = isEn ? 'next week' : 'la próxima semana';
  else if (scope === 'this_weekend') scopeLabel = isEn ? 'this weekend' : 'este fin de semana';
  else if (allPending) scopeLabel = isEn ? 'current pending items' : 'tus pendientes actuales';
  else if (scope === 'upcoming') scopeLabel = isEn ? 'upcoming schedule' : 'los próximos días';
  else if (scope === 'explicit_date') scopeLabel = isEn ? 'that date' : 'esa fecha';

  if (totalCount === 0) {
    if (allPending) {
      return isEn
        ? '✅ *You are all caught up*\n\nYou have no pending reminders or tasks right now.'
        : '✅ *Estás al día*\n\nNo tienes recordatorios ni tareas pendientes en este momento.';
    }
    if (calendar.state === 'ERROR') {
      return isEn
        ? `📅 *Your Schedule for ${scopeLabel}:*\n\n(No events found in Reminders or Tasks. Google Calendar is temporarily unavailable).`
        : `📅 *Tu agenda para ${scopeLabel}:*\n\nNo tienes eventos, recordatorios ni tareas programadas.\n_(Nota: Google Calendar presentó una intermitencia temporal)._`;
    }
    if (calendar.state === 'AUTH_REQUIRED' || calendar.state === 'DISCONNECTED') {
      return isEn
        ? `📅 *Your schedule for ${scopeLabel}:*\n\nYou have no reminders or tasks scheduled.\n\n🔐 Google Calendar needs to be connected to include its events.`
        : `📅 *Tu agenda para ${scopeLabel}:*\n\nNo tienes recordatorios ni tareas programadas.\n\n🔐 Google Calendar necesita conexión para incluir sus eventos.`;
    }
    return isEn
      ? `You have no calendar events, reminders, or tasks scheduled for ${scopeLabel}.`
      : `No tienes eventos en Google Calendar, recordatorios ni tareas programadas para ${scopeLabel}.`;
  }

  const sections = [];
  sections.push(allPending
    ? (isEn ? '📋 *Current pending items*' : '📋 *Pendientes actuales*')
    : (isEn ? `📅 *Your schedule for ${scopeLabel}:*` : `📅 *Tu agenda para ${scopeLabel}:*`));

  const isMultiDay = scope !== 'today' && scope !== 'tomorrow';

  // 1. Google Calendar Section
  if (calendar.state === 'CONNECTED' && calendarEvents.length > 0) {
    const lines = calendarEvents.map(ev => {
      const timeStr = ev.isAllDay
        ? (isEn ? 'All day' : 'Todo el día')
        : (isMultiDay ? (ev.displayDate || ev.localStartTime || '') : (ev.localStartTime || ''));
      const timeDisplay = timeStr ? ` — ${timeStr}` : '';
      return `• 📅 *${ev.summary || 'Evento'}*${timeDisplay}`;
    });
    sections.push(`📅 *CALENDARIO*\n${lines.join('\n')}`);
  } else if (!allPending && calendar.state === 'ERROR') {
    sections.push(`📅 *CALENDARIO*\n⚠️ _(Google Calendar no disponible temporalmente)_`);
  } else if (!allPending && (calendar.state === 'AUTH_REQUIRED' || calendar.state === 'DISCONNECTED')) {
    sections.push(isEn
      ? '📅 *CALENDAR*\n🔐 _(Google Calendar needs to be connected)_'
      : '📅 *CALENDARIO*\n🔐 _(Google Calendar necesita conexión)_');
  }

  // 2. Reminders Section
  if (reminders.length > 0) {
    const lines = reminders.map(r => {
      const timeStr = isMultiDay
        ? (r.sendAt ? formatHumanFriendlyDateTime(r.sendAt, timezone, language) : r.localTime)
        : r.localTime;
      const timeDisplay = timeStr ? ` — ${timeStr}` : '';
      const rec = r.recurrenceRule ? ` _(Recurrente)_` : '';
      return `• 🔔 *${r.content || r.title || 'Recordatorio'}*${timeDisplay}${rec}`;
    });
    sections.push(`🔔 *RECORDATORIOS*\n${lines.join('\n')}`);
  }

  // 3. Tasks Section
  if (tasks.length > 0) {
    const lines = tasks.map(t => {
      const ent = t.entityName ? ` [${t.entityName}]` : '';
      const timeStr = isMultiDay
        ? (t.dueDate ? formatHumanFriendlyDateTime(t.dueDate, timezone, language) : t.localTime)
        : t.localTime;
      const timeDisplay = timeStr ? ` (${timeStr})` : '';
      return `• ☑️ *${t.title || t.content}*${ent}${timeDisplay}`;
    });
    sections.push(`☑️ *TAREAS*\n${lines.join('\n')}`);
  }

  return sections.join('\n\n');
}
