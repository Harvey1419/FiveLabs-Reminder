import { formatHumanFriendlyDateTime } from './time.js';

function normalizeRecurrence(value) {
  return String(value || '').trim().toLowerCase().replace(/[\s-]+/g, '_');
}

export function formatRecurrenceLabel(value, language = 'es') {
  const recurrence = normalizeRecurrence(value);
  if (!recurrence) return '';

  const labels = language === 'en'
    ? {
      daily: 'Every day',
      weekdays: 'Weekdays',
      weekly: 'Every week',
      monthly: 'Every month',
      hourly: 'Every hour',
    }
    : {
      daily: 'Todos los días',
      weekdays: 'De lunes a viernes',
      weekly: 'Todas las semanas',
      monthly: 'Todos los meses',
      hourly: 'Cada hora',
    };

  return labels[recurrence] || (language === 'en' ? 'Recurring' : 'Recurrente');
}

function getReminderItems(data) {
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.items)) return data.items;
  return [];
}

export function formatCanonicalReminderCreate(data, {
  language = 'es',
  timezone = 'UTC',
} = {}) {
  const items = getReminderItems(data);
  if (items.length === 0) return '';

  const header = items.length === 1
    ? (language === 'en' ? '✅ *Scheduled Reminder*' : '✅ *Recordatorio programado*')
    : (language === 'en' ? '✅ *Scheduled Reminders*' : '✅ *Recordatorios programados*');

  const blocks = items.map((item) => {
    const content = item.displayContent || item.content || item.title || (language === 'en' ? 'Reminder' : 'Recordatorio');
    const sendAt = item.sendAt || item.send_at || null;
    const timeDisplay = item.formattedTime || (sendAt ? formatHumanFriendlyDateTime(sendAt, timezone, language) : '');
    const recurrence = item.recurrenceRule || item.recurrence_rule || null;
    const recurrenceLabel = formatRecurrenceLabel(recurrence, language);
    const icon = item.isAdvanceNotice ? '🔔' : '⏰';
    const lines = [`${icon} *${content}*`];

    if (timeDisplay) lines.push(`📅 ${timeDisplay}`);
    if (recurrenceLabel) lines.push(`🔁 *${recurrenceLabel}*`);

    return lines.join('\n');
  });

  return `${header}\n\n${blocks.join('\n\n')}`;
}
