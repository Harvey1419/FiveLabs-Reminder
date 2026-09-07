import { formatHumanFriendlyDateTime } from '../../shared/time.js';

function plural(count, singular, pluralForm = `${singular}s`) {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

function scopeTitle(scope, language) {
  const isEn = language === 'en';
  if (['all', 'all_pending', 'todos', 'pendientes', 'todos_los_pendientes'].includes(String(scope || '').toLowerCase())) {
    return isEn ? '📋 *Current pending items*' : '📋 *Pendientes actuales*';
  }
  const labels = isEn
    ? {
      today: '🗓️ *Today*', tomorrow: '🗓️ *Tomorrow*', this_week: '🗓️ *This week*',
      next_week: '🗓️ *Next week*', this_weekend: '🗓️ *This weekend*', upcoming: '🗓️ *Upcoming*',
      explicit_date: '🗓️ *Your agenda*',
    }
    : {
      today: '🗓️ *Hoy*', tomorrow: '🗓️ *Mañana*', this_week: '🗓️ *Esta semana*',
      next_week: '🗓️ *Próxima semana*', this_weekend: '🗓️ *Este fin de semana*', upcoming: '🗓️ *Próximamente*',
      explicit_date: '🗓️ *Tu agenda*',
    };
  return labels[scope] || (isEn ? '🗓️ *Your agenda*' : '🗓️ *Tu agenda*');
}

function compactSummary({ calendarEvents, reminders, tasks, language }) {
  const isEn = language === 'en';
  const parts = [];
  if (calendarEvents.length) parts.push(plural(calendarEvents.length, isEn ? 'event' : 'evento'));
  if (reminders.length) parts.push(plural(reminders.length, isEn ? 'reminder' : 'recordatorio'));
  if (tasks.length) parts.push(plural(tasks.length, isEn ? 'task' : 'tarea'));
  if (!parts.length) return isEn ? '_Nothing pending in the connected sources._' : '_Nada pendiente en las fuentes disponibles._';
  return `_${parts.join(' · ')}_`;
}

function renderCalendar(calendar, timezone, language) {
  const isEn = language === 'en';
  const events = calendar?.events || [];
  const header = isEn ? '📅 *Google Calendar*' : '📅 *Google Calendar*';

  if (calendar?.state === 'DISCONNECTED' || calendar?.state === 'AUTH_REQUIRED') {
    return `${header}\n🔒 ${isEn ? 'Not connected' : 'No conectado'}\n_${isEn ? 'Connect it to include your calendar events.' : 'Conéctalo para incluir tus eventos en la agenda.'}_`;
  }
  if (calendar?.state === 'ERROR') {
    return `${header}\n⚠️ ${isEn ? 'Temporarily unavailable' : 'No disponible temporalmente'}`;
  }
  if (events.length === 0) {
    return `${header}\n✅ ${isEn ? 'No events in this period.' : 'Sin eventos en este período.'}`;
  }

  const lines = events.map((event, index) => {
    const title = event.summary || (isEn ? 'Event' : 'Evento');
    let when = event.isAllDay
      ? (isEn ? 'All day' : 'Todo el día')
      : (event.displayDate || event.localStartTime || null);
    if (!when && event.startDateTime) when = formatHumanFriendlyDateTime(event.startDateTime, timezone, language);
    return `${index + 1}. *${title}*${when ? `\n   🕒 ${when}` : ''}`;
  });
  return `${header} · ${events.length}\n${lines.join('\n')}`;
}

function renderReminders(reminders, timezone, language) {
  if (!reminders.length) return null;
  const isEn = language === 'en';
  const lines = reminders.map((reminder, index) => {
    const title = reminder.content || reminder.title || (isEn ? 'Reminder' : 'Recordatorio');
    const when = reminder.sendAt
      ? formatHumanFriendlyDateTime(reminder.sendAt, timezone, language)
      : reminder.localTime;
    const recurrence = reminder.recurrenceRule ? (isEn ? ' · 🔁 Recurring' : ' · 🔁 Recurrente') : '';
    return `${index + 1}. *${title}*${when ? `\n   🕒 ${when}` : ''}${recurrence}`;
  });
  return `🔔 *${isEn ? 'Reminders' : 'Recordatorios'}* · ${reminders.length}\n${lines.join('\n')}`;
}

function renderTasks(tasks, timezone, language) {
  if (!tasks.length) return null;
  const isEn = language === 'en';
  const lines = tasks.map((task, index) => {
    const title = task.title || task.content || (isEn ? 'Task' : 'Tarea');
    const metadata = [];
    if (task.entityName) metadata.push(`📁 ${task.entityName}`);
    if (task.dueDate) metadata.push(`🕒 ${formatHumanFriendlyDateTime(task.dueDate, timezone, language)}`);
    return `${index + 1}. *${title}*${metadata.length ? `\n   ${metadata.join(' · ')}` : ''}`;
  });
  return `☑️ *${isEn ? 'Tasks' : 'Tareas'}* · ${tasks.length}\n${lines.join('\n')}`;
}

/**
 * Canonical WhatsApp presentation for Unified Agenda.
 * Structured agenda data remains the source of truth; this function only owns
 * human-facing layout and never changes inclusion/filter semantics.
 */
export function formatAgendaWhatsAppCard(agenda, language = 'es') {
  const calendar = agenda?.calendar || { state: 'DISCONNECTED', events: [] };
  const reminders = agenda?.reminders || [];
  const tasks = agenda?.tasks || [];
  const calendarEvents = calendar.events || [];
  const timezone = agenda?.timezone || 'America/Bogota';

  const sections = [
    scopeTitle(agenda?.scope, language),
    compactSummary({ calendarEvents, reminders, tasks, language }),
    renderCalendar(calendar, timezone, language),
    renderReminders(reminders, timezone, language),
    renderTasks(tasks, timezone, language),
  ].filter(Boolean);

  return sections.join('\n\n');
}
