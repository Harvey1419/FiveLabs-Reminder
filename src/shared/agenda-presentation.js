import { formatHumanFriendlyDateTime } from './time.js';
import { formatTaskProjectGroups, getTaskTime, formatTaskNotesBadge } from './task-presentation.js';
import { isAllPendingScope, normalizeAgendaScope, normalizeTaskScope } from './agenda-scopes.js';

function scopeLabel(scope, language) {
  const isEn = language === 'en';
  const canonical = normalizeAgendaScope(scope, 'upcoming');
  const labels = {
    today: isEn ? 'today' : 'hoy',
    remaining_today: isEn ? 'the rest of today' : 'lo que queda de hoy',
    tomorrow: isEn ? 'tomorrow' : 'mañana',
    day_after_tomorrow: isEn ? 'the day after tomorrow' : 'pasado mañana',
    monday: isEn ? 'Monday' : 'el lunes',
    tuesday: isEn ? 'Tuesday' : 'el martes',
    wednesday: isEn ? 'Wednesday' : 'el miércoles',
    thursday: isEn ? 'Thursday' : 'el jueves',
    friday: isEn ? 'Friday' : 'el viernes',
    saturday: isEn ? 'Saturday' : 'el sábado',
    sunday: isEn ? 'Sunday' : 'el domingo',
    this_week: isEn ? 'this week' : 'esta semana',
    next_week: isEn ? 'next week' : 'la próxima semana',
    this_weekend: isEn ? 'this weekend' : 'este fin de semana',
    upcoming: isEn ? 'upcoming days' : 'los próximos días',
    explicit_date: isEn ? 'that date' : 'esa fecha',
    explicit_range: isEn ? 'that period' : 'ese período',
    month: isEn ? 'this month' : 'este mes',
    full_year: isEn ? 'this year' : 'este año',
  };
  return labels[canonical] || (isEn ? 'this period' : 'este período');
}

export function formatCanonicalTaskList(data = {}, {
  language = 'es',
  timezone = 'UTC',
} = {}) {
  const tasks = Array.isArray(data?.tasks) ? data.tasks : [];
  const projectName = data?.entityName || null;
  const scope = normalizeTaskScope(data?.scope, 'all_pending');

  if (tasks.length === 0) {
    if (projectName) {
      return language === 'en'
        ? `☑️ *Tasks · ${projectName}*\n\nNo pending tasks in this project.`
        : `☑️ *Tareas · ${projectName}*\n\nNo hay tareas pendientes en este proyecto.`;
    }
    if (scope === 'all_pending') {
      return language === 'en'
        ? '☑️ *Pending tasks*\n\nYou have no pending tasks.'
        : '☑️ *Tareas pendientes*\n\nNo tienes tareas pendientes.';
    }
    return language === 'en'
      ? `☑️ *Tasks for ${scopeLabel(scope, language)}*\n\nYou have no tasks in this period.`
      : `☑️ *Tareas para ${scopeLabel(scope, language)}*\n\nNo tienes tareas en este período.`;
  }

  if (projectName) {
    const isEn = language === 'en';
    const taskWord = tasks.length === 1 ? (isEn ? 'task' : 'tarea') : (isEn ? 'tasks' : 'tareas');
    const header = `📁 *${projectName}* · ${tasks.length} ${taskWord}`;
    let globalIndex = 1;
    const lines = tasks.map((task) => {
      const title = task?.title || task?.content || (isEn ? 'Untitled task' : 'Tarea sin título');
      const time = getTaskTime(task, { timezone, language, isMultiDay: !['today', 'remaining_today', 'tomorrow'].includes(scope) });
      const notesBadge = formatTaskNotesBadge(task, isEn);
      return `${globalIndex++}. ${title}${time ? ` — ${time}` : ''}${notesBadge}`;
    });
    return `${header}\n\n${lines.join('\n')}`;
  }

  const groups = formatTaskProjectGroups(tasks, {
    language,
    timezone,
    isMultiDay: !['today', 'remaining_today', 'tomorrow'].includes(scope),
    numbered: true,
  });

  const header = scope === 'all_pending'
    ? `☑️ *${language === 'en' ? 'Tasks' : 'Tareas'} · ${tasks.length}*`
    : `☑️ *${language === 'en' ? 'Tasks' : 'Tareas'} · ${scopeLabel(scope, language)} · ${tasks.length}*`;

  return `${header}\n\n${groups}`;
}

export function formatCanonicalAgenda(data = {}, {
  language = 'es',
  timezone = 'UTC',
} = {}) {
  const isEn = language === 'en';
  const calendar = data?.calendar || { state: 'DISCONNECTED', events: [] };
  const events = Array.isArray(calendar.events) ? calendar.events : [];
  const reminders = Array.isArray(data?.reminders) ? data.reminders : [];
  const tasks = Array.isArray(data?.tasks) ? data.tasks : [];
  const scope = normalizeAgendaScope(data?.scope, 'all_pending');
  const allPending = isAllPendingScope(scope);
  const sections = [];

  sections.push(allPending
    ? (isEn ? '📋 *Current pending items*' : '📋 *Pendientes actuales*')
    : (isEn ? `📅 *Your schedule for ${scopeLabel(scope, language)}*` : `📅 *Tu agenda para ${scopeLabel(scope, language)}*`));

  const summaryParts = [];
  if (reminders.length) summaryParts.push(`${reminders.length} ${isEn ? (reminders.length === 1 ? 'reminder' : 'reminders') : (reminders.length === 1 ? 'recordatorio' : 'recordatorios')}`);
  if (tasks.length) summaryParts.push(`${tasks.length} ${isEn ? (tasks.length === 1 ? 'task' : 'tasks') : (tasks.length === 1 ? 'tarea' : 'tareas')}`);
  if (events.length) summaryParts.push(`${events.length} ${isEn ? (events.length === 1 ? 'event' : 'events') : (events.length === 1 ? 'evento' : 'eventos')}`);
  if (summaryParts.length) sections.push(`_${summaryParts.join(' · ')}_`);

  if (calendar.state === 'CONNECTED' && events.length > 0) {
    const lines = events.map((event) => {
      const time = event.isAllDay
        ? (isEn ? 'All day' : 'Todo el día')
        : (event.displayDate || event.localStartTime || (event.startDateTime ? formatHumanFriendlyDateTime(event.startDateTime, timezone, language) : ''));
      return `• ${event.summary || (isEn ? 'Event' : 'Evento')}${time ? ` — ${time}` : ''}`;
    });
    sections.push(`📅 *Google Calendar · ${events.length}*\n${lines.join('\n')}`);
  } else if (calendar.state === 'CONNECTED') {
    sections.push(`📅 *Google Calendar*\n✅ ${isEn ? 'No events in this period' : 'Sin eventos en este período'}`);
  } else if (calendar.state === 'ERROR') {
    sections.push(`📅 *Google Calendar*\n⚠️ ${isEn ? 'Temporarily unavailable' : 'No disponible temporalmente'}`);
  } else {
    sections.push(`📅 *Google Calendar*\n🔒 ${isEn ? 'Not connected' : 'No conectado'}\n_${isEn ? 'Connect it to include your events in the agenda.' : 'Conéctalo para incluir tus eventos en la agenda.'}_`);
  }

  if (reminders.length > 0) {
    const lines = reminders.map((reminder, index) => {
      const date = reminder.sendAt || reminder.send_at || null;
      const time = date ? formatHumanFriendlyDateTime(date, timezone, language) : (reminder.localTime || null);
      const recurrent = reminder.recurrenceRule || reminder.recurrence_rule
        ? (isEn ? ' · recurring' : ' · recurrente')
        : '';
      return `${index + 1}. ${reminder.content || reminder.title || (isEn ? 'Reminder' : 'Recordatorio')}${recurrent}${time ? `\n   🕒 ${time}` : ''}`;
    });
    sections.push(`🔔 *${isEn ? 'Reminders' : 'Recordatorios'} · ${reminders.length}*\n${lines.join('\n')}`);
  }

  if (tasks.length > 0) {
    const groups = formatTaskProjectGroups(tasks, {
      language,
      timezone,
      isMultiDay: !['today', 'remaining_today', 'tomorrow'].includes(scope),
      numbered: true,
    });
    sections.push(`☑️ *${isEn ? 'Tasks' : 'Tareas'} · ${tasks.length}*\n\n${groups}`);
  }

  if (events.length === 0 && reminders.length === 0 && tasks.length === 0) {
    sections.push(isEn ? '✅ Nothing pending right now.' : '✅ No tienes pendientes en este momento.');
  }

  return sections.join('\n\n');
}
