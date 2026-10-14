import { PRESENTATION_TOKENS } from './presentation-design-tokens.js';
/** Existing canonical DTO retained for typed presenter callers. */
export interface CanonicalReminderItem {
  readonly id: string; readonly content: string; readonly sendAt: string | null;
  readonly recurrenceRule: string | null; readonly isAdvanceNotice: boolean;
  readonly parentReminderId: string | null;
}
export interface ReminderFormatContext { readonly language?: string; readonly timezone?: string }
export interface ReminderPresentationDependencies {
  formatHumanFriendlyDateTime(value: unknown, timezone: string, language: string, options: { includeYearWhenDifferent: boolean }): string;
}
interface CreateGroup { main: unknown; advance: unknown | null }
/** Trusted host row projection; this renderer does not admit model output or certify effects. */
function row(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' ? value as Record<string, unknown> : null;
}
export function createReminderPresentation(dependencies: ReminderPresentationDependencies) {
  const { formatHumanFriendlyDateTime } = dependencies;

  function normalizeRecurrence(value: unknown): string {
    return String(value || '').trim().toLowerCase().replace(/[\s-]+/g, '_');
  }

  function formatRecurrenceLabel(value: unknown, language = 'es'): string {
    const recurrence = normalizeRecurrence(value);
    if (!recurrence) return '';

    const labels: Record<string, string> = language === 'en'
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

  function getReminderItems(data: unknown): readonly unknown[] {
    if (Array.isArray(data)) return data;
    if (Array.isArray(row(data)?.items)) return row(data)!.items as unknown[];
    return [];
  }

  function reminderContent(item: unknown, language: string): unknown {
    return row(item)?.displayContent || row(item)?.content || row(item)?.title || (language === 'en' ? 'Reminder' : 'Recordatorio');
  }

  function reminderTime(item: unknown, timezone: string, language: string): unknown {
    const sendAt = row(item)?.sendAt || row(item)?.send_at || null;
    // Rebuild from the stored instant so stale preformatted text cannot omit or
    // duplicate the year. Legacy rows without a usable instant keep their label.
    return sendAt && !Number.isNaN(new Date(sendAt as string | number).getTime())
      ? formatHumanFriendlyDateTime(sendAt, timezone, language, { includeYearWhenDifferent: true })
      : row(item)?.formattedTime || '';
  }

  function reminderRecurrence(item: unknown): unknown {
    return row(item)?.recurrenceRule || row(item)?.recurrence_rule || null;
  }

  function groupCreateItems(items: readonly unknown[], language: string): CreateGroup[] {
    const mainItems = items.filter((item) => !row(item)?.isAdvanceNotice);
    const advanceItems = items.filter((item) => row(item)?.isAdvanceNotice);
    const usedAdvance = new Set<number>();

    const groups = mainItems.map((main) => {
      const content = reminderContent(main, language);
      const advance = advanceItems.find((candidate, index) => {
        if (usedAdvance.has(index)) return false;
        const parentId = row(candidate)?.parentReminderId || row(candidate)?.parent_reminder_id;
        if (parentId) return parentId === row(main)?.id;
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

  function renderCreateGroup({ main, advance }: CreateGroup, { language, timezone }: { language: string; timezone: string }): string {
    const content = reminderContent(main, language);
    const timeDisplay = reminderTime(main, timezone, language);
    const recurrence = reminderRecurrence(main);
    const recurrenceLabel = formatRecurrenceLabel(recurrence, language);
    const primaryIcon = recurrence ? '🔁' : (row(main)?.isAdvanceNotice ? '🔔' : '⏰');
    const lines = [`${primaryIcon} *${content}*`];

    if (timeDisplay) lines.push(`${PRESENTATION_TOKENS.ICONS.SCHEDULE_TIME} ${timeDisplay}`);
    if (recurrenceLabel) lines.push(`🔁 ${recurrenceLabel}`);

    if (advance) {
      const advanceTime = reminderTime(advance, timezone, language);
      const advanceLabel = language === 'en' ? 'Advance notice' : 'Aviso previo';
      lines.push(`🔔 ${advanceLabel}${advanceTime ? ` · ${advanceTime}` : ''}`);
    }

    return lines.join('\n');
  }

  function formatCanonicalReminderCreate(data: unknown, {
    language = 'es',
    timezone = 'UTC',
  }: ReminderFormatContext = {}): string {
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

  function formatCanonicalReminderCreateBatch(dataSets: readonly unknown[] | null | undefined, context: ReminderFormatContext = {}): string {
    const items = (dataSets || []).flatMap((data) => getReminderItems(data));
    return formatCanonicalReminderCreate(items, context);
  }

  function formatCanonicalReminderCancel(data: unknown, { language = 'es' }: ReminderFormatContext = {}): string {
    if (!data || typeof data !== 'object') return '';
    const content = reminderContent(data, language);
    const recurring = Boolean(row(data)?.recurring || row(data)?.recurrenceRule || row(data)?.recurrence_rule);
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

  function formatCanonicalReminderCancelBatch(dataSets: readonly unknown[] | null | undefined, { language = 'es' }: ReminderFormatContext = {}): string {
    const entries = (dataSets || [])
      .filter((data) => data && typeof data === 'object' && row(data)?.content)
      .map((data) => ({ content: row(data)?.content, recurring: Boolean(row(data)?.recurring || row(data)?.recurrenceRule || row(data)?.recurrence_rule) }));

    if (entries.length === 0) return '';
    const count = entries.length;
    const header = language === 'en'
      ? `🗑️ *${count} reminder${count === 1 ? '' : 's'} removed*`
      : `🗑️ *${count} ${count === 1 ? 'recordatorio eliminado' : 'recordatorios eliminados'}*`;
    const lines = entries.map((entry) => `${entry.recurring ? '🔁' : '🔔'} *${entry.content}*`);
    return `${header}\n\n${lines.join('\n')}`;
  }

  function formatCanonicalReminderUpdate(data: unknown, {
    language = 'es',
    timezone = 'UTC',
  }: ReminderFormatContext = {}): string {
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

  function formatCanonicalReminderAcknowledge(data: unknown, { language = 'es' }: ReminderFormatContext = {}): string {
    if (!data || typeof data !== 'object') return '';
    const content = reminderContent(data, language);
    return language === 'en'
      ? `✅ *Reminder confirmed*\n\n🔔 *${content}*\nRecorded as completed and pending follow-ups were stopped.`
      : `✅ *Recordatorio confirmado*\n\n🔔 *${content}*\nQueda registrado como completado y se detienen los avisos pendientes.`;
  }

  function formatCanonicalReminderList(data: unknown, {
    language = 'es',
    timezone = 'UTC',
  }: ReminderFormatContext = {}): string {
    const reminders: readonly unknown[] = Array.isArray(row(data)?.reminders) ? row(data)!.reminders as unknown[] : [];
    const filter = String(row(data)?.filter || '').toLowerCase();
    const isEn = language === 'en';

    const getHeader = (filterName: string) => {
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
        case 'created_today':
          return isEn ? '🔔 *Reminders created today*' : '🔔 *Recordatorios creados hoy*';
        case 'completed_today':
          return isEn ? '🔔 *Reminders completed today*' : '🔔 *Recordatorios completados hoy*';
        default:
          return isEn ? '🔔 *Pending reminders*' : '🔔 *Recordatorios pendientes*';
      }
    };

    const header = getHeader(filter);

    if (reminders.length === 0) {
      const query = row(data)?.query;
      if (typeof query === 'string' && query.trim().length > 0) {
        const message = isEn
          ? 'No reminders match your search within the requested scope. 🔎'
          : 'No hay recordatorios que coincidan con tu búsqueda dentro del alcance solicitado. 🔎';
        return `${header}\n\n${message}`;
      }
      let emptyMsg;
      switch (filter) {
        case 'created_today':
          emptyMsg = isEn ? 'I found no reminders created today.' : 'No encontré recordatorios creados hoy.';
          break;
        case 'tomorrow':
          emptyMsg = isEn
            ? 'You have no reminders scheduled for tomorrow. Your day is completely clear! 🚀'
            : 'No tienes recordatorios programados para mañana. ¡Día completamente despejado! 🚀';
          break;
        case 'day_after_tomorrow':
          emptyMsg = isEn
            ? 'You have no reminders scheduled for the day after tomorrow. Enjoy your clear schedule! ✨'
            : 'No tienes recordatorios programados para pasado mañana. ¡Panorama despejado! ✨';
          break;
        case 'today':
        case 'pending_today':
        case 'remaining_today':
          emptyMsg = isEn
            ? 'You have no pending reminders for today. ☕'
            : 'No tienes recordatorios pendientes para hoy. ☕';
          break;
        case 'this_week':
          emptyMsg = isEn
            ? 'You have no reminders scheduled for this week. Have a relaxed and focused week! 🌟'
            : 'No tienes recordatorios programados para esta semana. ¡Semana libre de alarmas por ahora! 🌟';
          break;
        case 'next_week':
          emptyMsg = isEn
            ? 'You have no reminders scheduled for next week. Clear schedule ahead! 🎯'
            : 'No tienes recordatorios programados para la próxima semana. ¡Agenda despejada! 🎯';
          break;
        default:
          emptyMsg = isEn
            ? 'You have no pending reminders. Enjoy your peace of mind! ☕'
            : 'No tienes recordatorios pendientes. ¡Tranquilidad total y todo bajo control! ☕';
          break;
      }
      return `${header}\n\n${emptyMsg}`;
    }

    const blocks = reminders.map((reminder, index) => {
      const content = row(reminder)?.content || row(reminder)?.title || (language === 'en' ? 'Reminder' : 'Recordatorio');
      const timeDisplay = reminderTime(reminder, timezone, language);
      const recurring = Boolean(row(reminder)?.recurrence_rule || row(reminder)?.recurrenceRule);
      const recurrenceSuffix = recurring
        ? (language === 'en' ? ' · recurring' : ' · recurrente')
        : '';
      const lines = [`${index + 1}. *${content}*${recurrenceSuffix}`];
      if (timeDisplay) lines.push(`   ${PRESENTATION_TOKENS.ICONS.SCHEDULE_TIME} ${timeDisplay}`);
      return lines.join('\n');
    });

    return `${header}\n\n${blocks.join('\n\n')}`;
  }

  return { formatRecurrenceLabel, formatCanonicalReminderCreate, formatCanonicalReminderCreateBatch, formatCanonicalReminderCancel, formatCanonicalReminderCancelBatch, formatCanonicalReminderUpdate, formatCanonicalReminderAcknowledge, formatCanonicalReminderList };
}
