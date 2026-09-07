import { formatHumanFriendlyDateTime } from './time.js';
import { formatTaskProjectGroups } from './task-presentation.js';

function isAllPendingScope(scope) {
  return new Set(['all', 'all_pending', 'todos', 'pendientes', 'todos_los_pendientes']).has(
    String(scope || '').toLowerCase().trim(),
  );
}

function scopeLabel(scope, language) {
  const isEn = language === 'en';
  const labels = {
    today: isEn ? 'today' : 'hoy',
    tomorrow: isEn ? 'tomorrow' : 'mañana',
    day_after_tomorrow: isEn ? 'the day after tomorrow' : 'pasado mañana',
    this_week: isEn ? 'this week' : 'esta semana',
    next_week: isEn ? 'next week' : 'la próxima semana',
    this_weekend: isEn ? 'this weekend' : 'este fin de semana',
    upcoming: isEn ? 'upcoming days' : 'los próximos días',
  };
  return labels[scope] || (isEn ? 'this period' : 'este período');
}

export function formatCanonicalTaskList(data = {}, {
  language = 'es',
  timezone = 'America/Bogota',
} = {}) {
  const tasks = Array.isArray(data?.tasks) ? data.tasks : [];
  const projectName = data?.entityName || null;
  if (tasks.length === 0) {
    if (projectName) {
      return language === 'en'
        ? `☑️ *Tasks · ${projectName}*\n\nNo pending tasks in this project.`
        : `☑️ *Tareas · ${projectName}*\n\nNo hay tareas pendientes en este proyecto.`;
    }
    return language === 'en'
      ? '☑️ *Pending tasks*\n\nYou have no pending tasks.'
      : '☑️ *Tareas pendientes*\n\nNo tienes tareas pendientes.';
  }

  const groups = formatTaskProjectGroups(tasks, {
    language,
    timezone,
    isMultiDay: true,
    projectName,
  });
  return `☑️ *${language === 'en' ? 'Tasks' : 'Tareas'} · ${tasks.length}*\n\n${groups}`;
}

export function formatCanonicalAgenda(data = {}, {
  language = 'es',
  timezone = 'America/Bogota',
} = {}) {
  const isEn = language === 'en';
  const calendar = data?.calendar || { state: 'DISCONNECTED', events: [] };
  const events = Array.isArray(calendar.events) ? calendar.events : [];
  const reminders = Array.isArray(data?.reminders) ? data.reminders : [];
  const tasks = Array.isArray(data?.tasks) ? data.tasks : [];
  const scope = data?.scope || 'all_pending';
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
        : (event.displayDate || event.localStartTime || '');
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
      isMultiDay: scope !== 'today' && scope !== 'tomorrow',
    });
    sections.push(`☑️ *${isEn ? 'Tasks' : 'Tareas'} · ${tasks.length}*\n\n${groups}`);
  }

  if (events.length === 0 && reminders.length === 0 && tasks.length === 0) {
    sections.push(isEn ? '✅ Nothing pending right now.' : '✅ No tienes pendientes en este momento.');
  }

  return sections.join('\n\n');
}
