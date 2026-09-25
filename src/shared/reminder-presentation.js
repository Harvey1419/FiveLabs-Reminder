import { formatHumanFriendlyDateTime } from './time.js';
import { PRESENTATION_TOKENS } from './presentation-tokens.js';

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
      yearly: 'Every year',
      annual: 'Every year',
      hourly: 'Every hour',
    }
    : {
      daily: 'Todos los días',
      weekdays: 'De lunes a viernes',
      weekly: 'Todas las semanas',
      monthly: 'Todos los meses',
      yearly: 'Todos los años',
      annual: 'Todos los años',
      hourly: 'Cada hora',
    };

  return labels[recurrence] || (language === 'en' ? 'Recurring' : 'Recurrente');
}

function getReminderItems(data) {
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.items)) return data.items;
  return [];
}

function reminderContent(item, language) {
  return item?.displayContent || item?.content || item?.title || (language === 'en' ? 'Reminder' : 'Recordatorio');
}

function reminderTime(item, timezone, language) {
  const sendAt = item?.sendAt || item?.send_at || null;
  return item?.formattedTime || (sendAt ? formatHumanFriendlyDateTime(sendAt, timezone, language) : '');
}

function reminderRecurrence(item) {
  return item?.recurrenceRule || item?.recurrence_rule || null;
}

function groupCreateItems(items, language) {
  const mainItems = items.filter((item) => !item?.isAdvanceNotice);
  const advanceItems = items.filter((item) => item?.isAdvanceNotice);
  const usedAdvance = new Set();

  const groups = mainItems.map((main) => {
    const content = reminderContent(main, language);
    const advance = advanceItems.find((candidate, index) => {
      if (usedAdvance.has(index)) return false;
      return reminderContent(candidate, language) === content;
    }) || null;

    if (advance) usedAdvance.add(advanceItems.indexOf(advance));
    return { main, advance };
  });

  advanceItems.forEach((advance, index) => {
    if (!usedAdvance.has(index)) groups.push({ main: advance, advance: null });
  });

  return groups;
}

function renderCreateGroup({ main, advance }, { language, timezone }) {
  const content = reminderContent(main, language);
  const timeDisplay = reminderTime(main, timezone, language);
  const recurrence = reminderRecurrence(main);
  const recurrenceLabel = formatRecurrenceLabel(recurrence, language);
  const primaryIcon = recurrence ? '🔁' : (main?.isAdvanceNotice ? '🔔' : '⏰');
  const lines = [`${primaryIcon} *${content}*`];

  if (timeDisplay) lines.push(`   ${PRESENTATION_TOKENS.ICONS.SCHEDULE_TIME} ${timeDisplay}`);
  if (recurrenceLabel) lines.push(`   🔁 ${recurrenceLabel}`);

  if (advance) {
    const advanceTime = reminderTime(advance, timezone, language);
    const advanceLabel = language === 'en' ? 'Advance notice' : 'Aviso previo';
    lines.push(`   🔔 ${advanceLabel}${advanceTime ? ` · ${advanceTime}` : ''}`);
  }

  return lines.join('\n');
}

export function formatCanonicalReminderCreate(data, {
  language = 'es',
  timezone = 'UTC',
} = {}) {
  const items = getReminderItems(data);
  if (items.length === 0) return '';

  const groups = groupCreateItems(items, language);
  const logicalCount = groups.length;
  const header = logicalCount === 1
    ? (language === 'en' ? '✅ *Scheduled reminder*' : '✅ *Recordatorio programado*')
    : (language === 'en' ? `✅ *${logicalCount} reminders scheduled*` : `✅ *${logicalCount} recordatorios programados*`);

  const blocks = groups.map((group) => renderCreateGroup(group, { language, timezone }));
  return `${header}\n\n${blocks.join('\n\n')}`;
}

export function formatCanonicalReminderCreateBatch(dataSets, context = {}) {
  const items = (dataSets || []).flatMap((data) => getReminderItems(data));
  return formatCanonicalReminderCreate(items, context);
}

export function formatCanonicalReminderCancel(data, { language = 'es' } = {}) {
  if (!data || typeof data !== 'object') return '';
  const content = reminderContent(data, language);
  const recurring = Boolean(data.recurring || data.recurrenceRule || data.recurrence_rule);
  const header = recurring
    ? (language === 'en' ? '🗑️ *Recurring reminder removed*' : '🗑️ *Recordatorio recurrente eliminado*')
    : (language === 'en' ? '🗑️ *Reminder removed*' : '🗑️ *Recordatorio eliminado*');
  const lines = [`${recurring ? '🔁' : '🔔'} *${content}*`];
  if (recurring) {
    lines.push(language === 'en'
      ? 'The active series was cancelled and no pending occurrences remain scheduled.'
      : 'La serie activa quedó cancelada y no quedan ocurrencias pendientes programadas.');
  }
  return `${header}\n\n${lines.join('\n')}`;
}

export function formatCanonicalReminderCancelBatch(dataSets, { language = 'es' } = {}) {
  const entries = (dataSets || [])
    .filter((data) => data && typeof data === 'object' && data.content)
    .map((data) => ({ content: data.content, recurring: Boolean(data.recurring || data.recurrenceRule || data.recurrence_rule) }));

  if (entries.length === 0) return '';
  const count = entries.length;
  const header = language === 'en'
    ? `🗑️ *${count} reminder${count === 1 ? '' : 's'} removed*`
    : `🗑️ *${count} ${count === 1 ? 'recordatorio eliminado' : 'recordatorios eliminados'}*`;
  const lines = entries.map((entry) => `${entry.recurring ? '🔁' : '🔔'} *${entry.content}*`);
  return `${header}\n\n${lines.join('\n')}`;
}

export function formatCanonicalReminderUpdate(data, {
  language = 'es',
  timezone = 'UTC',
} = {}) {
  if (!data || typeof data !== 'object') return '';
  const content = reminderContent(data, language);
  const timeDisplay = reminderTime(data, timezone, language);
  const recurrenceLabel = formatRecurrenceLabel(reminderRecurrence(data), language);
  const lines = [
    language === 'en' ? '🔄 *Reminder updated*' : '🔄 *Recordatorio actualizado*',
    '',
    `⏰ *${content}*`,
  ];
  if (timeDisplay) lines.push(`${PRESENTATION_TOKENS.ICONS.SCHEDULE_TIME} ${timeDisplay}`);
  if (recurrenceLabel) lines.push(`🔁 ${recurrenceLabel}`);
  return lines.join('\n');
}

export function formatCanonicalReminderAcknowledge(data, { language = 'es' } = {}) {
  if (!data || typeof data !== 'object') return '';
  const content = reminderContent(data, language);
  return language === 'en'
    ? `✅ *Reminder confirmed*\n\n🔔 *${content}*\nRecorded as completed and pending follow-ups were stopped.`
    : `✅ *Recordatorio confirmado*\n\n🔔 *${content}*\nQueda registrado como completado y se detienen los avisos pendientes.`;
}

export function formatCanonicalReminderList(data, {
  language = 'es',
  timezone = 'UTC',
} = {}) {
  const reminders = Array.isArray(data?.reminders) ? data.reminders : [];
  const filter = String(data?.filter || '').toLowerCase();
  const isEn = language === 'en';

  const getHeader = (filterName) => {
    switch (filterName) {
      case 'tomorrow':
        return isEn ? '🔔 *Tomorrow\'s reminders*' : '🔔 *Recordatorios para mañana*';
      case 'day_after_tomorrow':
        return isEn ? '🔔 *Day after tomorrow\'s reminders*' : '🔔 *Recordatorios para pasado mañana*';
      case 'today':
      case 'pending_today':
      case 'remaining_today':
        return isEn ? '🔔 *Today\'s reminders*' : '🔔 *Recordatorios de hoy*';
      case 'this_week':
        return isEn ? '🔔 *This week\'s reminders*' : '🔔 *Recordatorios de esta semana*';
      case 'next_week':
        return isEn ? '🔔 *Next week\'s reminders*' : '🔔 *Recordatorios de la próxima semana*';
      case 'this_weekend':
        return isEn ? '🔔 *Weekend reminders*' : '🔔 *Recordatorios del fin de semana*';
      case 'completed_today':
        return isEn ? '🔔 *Reminders completed today*' : '🔔 *Recordatorios completados hoy*';
      default:
        return isEn ? '🔔 *Pending reminders*' : '🔔 *Recordatorios pendientes*';
    }
  };

  const header = getHeader(filter);

  if (reminders.length === 0) {
    let emptyMsg;
    switch (filter) {
      case 'tomorrow':
        emptyMsg = isEn ? 'You have no reminders scheduled for tomorrow.' : 'No tienes recordatorios programados para mañana.';
        break;
      case 'day_after_tomorrow':
        emptyMsg = isEn ? 'You have no reminders scheduled for the day after tomorrow.' : 'No tienes recordatorios programados para pasado mañana.';
        break;
      case 'today':
      case 'pending_today':
      case 'remaining_today':
        emptyMsg = isEn ? 'You have no pending reminders for today.' : 'No tienes recordatorios pendientes para hoy.';
        break;
      case 'this_week':
        emptyMsg = isEn ? 'You have no reminders scheduled for this week.' : 'No tienes recordatorios programados para esta semana.';
        break;
      case 'next_week':
        emptyMsg = isEn ? 'You have no reminders scheduled for next week.' : 'No tienes recordatorios programados para la próxima semana.';
        break;
      default:
        emptyMsg = isEn ? 'You have no pending reminders.' : 'No tienes recordatorios pendientes.';
        break;
    }
    return `${header}\n\n${emptyMsg}`;
  }

  const blocks = reminders.map((reminder, index) => {
    const content = reminder.content || reminder.title || (language === 'en' ? 'Reminder' : 'Recordatorio');
    const sendAt = reminder.send_at || reminder.sendAt || null;
    const timeDisplay = sendAt ? formatHumanFriendlyDateTime(sendAt, timezone, language) : '';
    const recurring = Boolean(reminder.recurrence_rule || reminder.recurrenceRule);
    const recurrenceSuffix = recurring
      ? (language === 'en' ? ' · recurring' : ' · recurrente')
      : '';
    const lines = [`${index + 1}. *${content}*${recurrenceSuffix}`];
    if (timeDisplay) lines.push(`   ${PRESENTATION_TOKENS.ICONS.SCHEDULE_TIME} ${timeDisplay}`);
    return lines.join('\n');
  });

  return `${header}\n\n${blocks.join('\n\n')}`;
}
