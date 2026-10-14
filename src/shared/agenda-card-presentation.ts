import { PRESENTATION_TOKENS } from './presentation-design-tokens.js';
import type { createTaskPresentation, TaskFormatContext } from './task-card-presentation.js';
type TaskHelpers = ReturnType<typeof createTaskPresentation>;
export interface AgendaPresentationDependencies {
  formatHumanFriendlyDateTime(value: unknown, timezone: string, language: string): string;
  formatTaskProjectGroups: TaskHelpers['formatTaskProjectGroups'];
  getTaskTime: TaskHelpers['getTaskTime'];
  formatTaskNotesBadge: TaskHelpers['formatTaskNotesBadge'];
  fullyRenderedTaskFields: TaskHelpers['fullyRenderedTaskFields'];
  isAllPendingScope(value: unknown): boolean;
  normalizeAgendaScope(value: unknown, fallback: string): string;
  normalizeTaskScope(value: unknown, fallback: string): string;
}
/** Consumed host payload projection; admission and current ownership stay upstream. */
function row(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' ? value as Record<string, unknown> : null;
}
function rows(value: unknown): readonly unknown[] { return Array.isArray(value) ? value : []; }
export function createAgendaPresentation(dependencies: AgendaPresentationDependencies) {
  const { formatHumanFriendlyDateTime, formatTaskProjectGroups, getTaskTime, formatTaskNotesBadge, fullyRenderedTaskFields, isAllPendingScope, normalizeAgendaScope, normalizeTaskScope } = dependencies;

  function scopeLabel(scope: unknown, language: string): string {
    const isEn = language === 'en';
    const canonical = normalizeAgendaScope(scope, 'upcoming');
    const labels: Record<string, string> = {
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

  function formatCanonicalTaskList(data: unknown = {}, {
    language = 'es',
    timezone = 'UTC',
    onTaskRendered = null,
  }: TaskFormatContext = {}): string {
    const tasks = rows(row(data)?.tasks);
    const projectName = row(data)?.entityName || null;
    const scope = normalizeTaskScope(row(data)?.scope, 'all_pending');

    const isCompleted = row(data)?.status === 'completed' || (tasks.length > 0 && tasks.every((t) => row(t)?.status === 'completed'));
    if (isCompleted) {
      const isEn = language === 'en';
      const scopeTxt = (scope === 'today' || scope === 'all_pending')
        ? (isEn ? 'today' : 'hoy')
        : scopeLabel(scope, language);
      if (tasks.length === 0) {
        return isEn
          ? `🎉 *Completed tasks ${scopeTxt}*\n\nYou haven't completed any tasks ${scopeTxt} yet.`
          : `🎉 *Tareas completadas ${scopeTxt}*\n\nNo has completado tareas ${scopeTxt} todavía.`;
      }
      const header = isEn
        ? `🎉 *Completed tasks ${scopeTxt} · ${tasks.length}*`
        : `🎉 *Tareas completadas ${scopeTxt} · ${tasks.length}*`;

      let globalIndex = 1;
      const lines = tasks.map((task) => {
        const title = row(task)?.title || row(task)?.content || (isEn ? 'Untitled task' : 'Tarea sin título');
        const entity = (row(task)?.entityName || row(row(task)?.entities)?.name) ? ` [${row(task)?.entityName || row(row(task)?.entities)?.name}]` : '';
        const time = row(task)?.localTime ? ` _(${row(task)?.localTime})_` : '';
        onTaskRendered?.(task, row(task)?.status === 'completed' ? ['status'] : []);
        return `${globalIndex++}. ~${title}~${entity}${time}`;
      });

      const footer = isEn
        ? '\n\nGreat job today! Keep up the momentum. 🚀'
        : '\n\n¡Gran trabajo hoy! Cerramos con broche de oro. 🚀';

      return `${header}\n\n${lines.join('\n')}${footer}`;
    }

    const query = row(data)?.query || null;

    if (tasks.length === 0) {
      if (projectName) {
        if (query) {
          return language === 'en'
            ? `☑️ *Tasks · ${projectName}*\n\nNo pending tasks found for "${query}".`
            : `☑️ *Tareas · ${projectName}*\n\nNo encontré tareas pendientes sobre "${query}" en este proyecto.`;
        }
        return language === 'en'
          ? `☑️ *Tasks · ${projectName}*\n\nNo pending tasks in this project.`
          : `☑️ *Tareas · ${projectName}*\n\nNo hay tareas pendientes en este proyecto.`;
      }
      if (scope === 'all_pending') {
        if (query) {
          return language === 'en'
            ? `☑️ *Pending tasks*\n\nNo pending tasks found for "${query}".`
            : `☑️ *Tareas pendientes*\n\nNo encontré tareas pendientes sobre "${query}".`;
        }
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
        const title = row(task)?.title || row(task)?.content || (isEn ? 'Untitled task' : 'Tarea sin título');
        const time = getTaskTime(task, { timezone, language, isMultiDay: !['today', 'remaining_today', 'tomorrow'].includes(scope) });
        const notesBadge = formatTaskNotesBadge(task, isEn);
        const desc = String(row(task)?.description || row(task)?.notes || '').trim();
        const noteLine = desc ? `\n   ↳ 📝 _${desc.replace(/\n+/g, ' · ')}_` : '';
        onTaskRendered?.(task, fullyRenderedTaskFields(task, desc, time));
        return `${globalIndex++}. ${title}${time ? ` — ${time}` : ''}${notesBadge}${noteLine}`;
      });
      return `${header}\n\n${lines.join('\n')}`;
    }

    const groups = formatTaskProjectGroups(tasks, {
      language,
      timezone,
      isMultiDay: !['today', 'remaining_today', 'tomorrow'].includes(scope),
      numbered: true,
      onTaskRendered,
    });

    const header = scope === 'all_pending'
      ? `☑️ *${language === 'en' ? 'Tasks' : 'Tareas'} · ${tasks.length}*`
      : `☑️ *${language === 'en' ? 'Tasks' : 'Tareas'} · ${scopeLabel(scope, language)} · ${tasks.length}*`;

    return `${header}\n\n${groups}`;
  }

  function formatCanonicalAgenda(data: unknown = {}, {
    language = 'es',
    timezone = 'UTC',
    onTaskRendered = null,
  }: TaskFormatContext = {}): string {
    const isEn = language === 'en';
    const calendar = row(row(data)?.calendar) || { state: 'DISCONNECTED', events: [] };
    const events = rows(calendar.events);
    const reminders = rows(row(data)?.reminders);
    const tasks = rows(row(data)?.tasks);
    const scope = normalizeAgendaScope(row(data)?.scope, 'all_pending');
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
        const time = row(event)?.isAllDay
          ? (isEn ? 'All day' : 'Todo el día')
          : (row(event)?.displayDate || row(event)?.localStartTime || (row(event)?.startDateTime ? formatHumanFriendlyDateTime(row(event)?.startDateTime, timezone, language) : ''));
        return `• ${row(event)?.summary || (isEn ? 'Event' : 'Evento')}${time ? ` — ${time}` : ''}`;
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
        const date = row(reminder)?.sendAt || row(reminder)?.send_at || null;
        const time = date ? formatHumanFriendlyDateTime(date, timezone, language) : (row(reminder)?.localTime || null);
        const recurrent = row(reminder)?.recurrenceRule || row(reminder)?.recurrence_rule
          ? (isEn ? ' · recurring' : ' · recurrente')
          : '';
        return `${index + 1}. ${row(reminder)?.content || row(reminder)?.title || (isEn ? 'Reminder' : 'Recordatorio')}${recurrent}${time ? `\n   ${PRESENTATION_TOKENS.ICONS.SCHEDULE_TIME} ${time}` : ''}`;
      });
      sections.push(`🔔 *${isEn ? 'Reminders' : 'Recordatorios'} · ${reminders.length}*\n${lines.join('\n')}`);
    }

    if (tasks.length > 0) {
      const groups = formatTaskProjectGroups(tasks, {
        language,
        timezone,
        isMultiDay: !['today', 'remaining_today', 'tomorrow'].includes(scope),
        numbered: true,
        onTaskRendered,
      });
      sections.push(`☑️ *${isEn ? 'Tasks' : 'Tareas'} · ${tasks.length}*\n\n${groups}`);
    }

    for (const source of ['reminders', 'tasks']) {
      if (row(row(data)?.sources)?.[source] === 'ERROR') {
        const label = source === 'reminders' ? (isEn ? 'Reminders' : 'Recordatorios') : (isEn ? 'Tasks' : 'Tareas');
        sections.push(`⚠️ ${label}: ${isEn ? 'temporarily unavailable' : 'no disponibles temporalmente'}.`);
      }
    }
    if (events.length === 0 && reminders.length === 0 && tasks.length === 0) {
      const complete = row(data)?.complete !== false && calendar.state === 'CONNECTED';
      sections.push(complete
        ? (isEn ? '✅ No pending items found for this period.' : '✅ No encontré pendientes en este período.')
        : (isEn ? 'No items found in the available sources. Your agenda could be incomplete.' : 'No encontré elementos en las fuentes disponibles. Tu agenda puede estar incompleta.'));
    }

    return sections.join('\n\n');
  }

  return { formatCanonicalTaskList, formatCanonicalAgenda };
}
