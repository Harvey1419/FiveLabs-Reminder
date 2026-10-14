import {
  reminderUiPayloadSchema, type ReminderRecord, type ReminderUiItem, type ReminderUiPayload,
} from '@templelabs/contracts';
import {
  formatCanonicalReminderCreate, formatCanonicalReminderUpdate,
  formatCanonicalReminderAcknowledge, formatCanonicalReminderList,
} from '../shared/reminder-presentation.js';

export interface WhatsAppPresentation {
  readonly text: string;
  readonly ctas: readonly { readonly url: string; readonly header: string | null; readonly buttonText: string | null }[];
}
function canonical(record: ReminderRecord) {
  return { id: record.id, content: record.content, sendAt: record.sendAt, recurrenceRule: record.recurrence,
    isAdvanceNotice: record.isAdvanceNotice, parentReminderId: record.parentReminderId };
}
function uniqueRecords(items: readonly ReminderUiItem[]): ReminderRecord[] {
  const records = new Map<string, ReminderRecord>();
  for (const item of items) for (const record of item.result?.records ?? []) records.set(record.id, record);
  return [...records.values()];
}
function errorText(item: ReminderUiItem, language: 'es' | 'en'): string {
  const en = language === 'en';
  if (item.status === 'indeterminate' || item.code === 'EFFECT_RECONCILIATION_REQUIRED') return en
    ? '⚠️ *Outcome not confirmed*\nI could not confirm this action. It needs checking before trying again.'
    : '⚠️ *Resultado sin confirmar*\nNo pude confirmar esta acción. Hay que verificarla antes de volver a intentarla.';
  if (item.status === 'clarification_required') {
    const questions = [...new Set(item.result?.presentation.questions ?? [])];
    return questions.length ? questions.join('\n') : en ? 'Which reminder or time did you mean?' : '¿A qué recordatorio u horario te refieres?';
  }
  if (item.code === 'PRO_TIER_REQUIRED') return en ? '✨ This reminder needs Pro.' : '✨ Este recordatorio necesita Pro.';
  if (item.status === 'denied') return en ? 'No permission was available for this action.' : 'No había permiso para realizar esta acción.';
  if (item.status === 'approval_required') return en ? 'Please confirm whether you want me to make this change.' : 'Confírmame si quieres que haga este cambio.';
  if (item.status === 'validation_failed') return en ? 'Please clarify the reminder details.' : 'Aclárame los datos del recordatorio.';
  return en ? 'I could not complete this action.' : 'No pude completar esta acción.';
}

/** Only verified domain data enters card rendering; provider prose is not an input. */
export class WhatsAppCardPresenter {
  render(rawPayload: ReminderUiPayload): WhatsAppPresentation {
    const payload = reminderUiPayloadSchema.parse(rawPayload);
    new Intl.DateTimeFormat('en', { timeZone: payload.timezone }).format();
    const context = { language: payload.language, timezone: payload.timezone };
    const sections: string[] = [];
    const groups = new Map<string, ReminderUiItem[]>();
    const ctas = new Map<string, WhatsAppPresentation['ctas'][number]>();
    for (const item of payload.items) {
      const cta = item.result?.presentation.cta;
      if (cta?.url && /^https:\/\//i.test(cta.url)) ctas.set(cta.url, { ...cta, url: cta.url });
      if (item.status === 'success' || item.status === 'partial') {
        if (!item.result || item.result.operation !== item.toolName.replace('reminder_', '')) {
          throw new Error('Presentation operation mismatch');
        }
        const key = item.toolName === 'reminder_read' ? `${item.toolName}:${item.readFilter}:${item.readQuery}` : item.toolName;
        const group = groups.get(key) ?? [];
        group.push(item); groups.set(key, group);
      } else sections.push(errorText(item, payload.language));
    }
    const cards: string[] = [];
    for (const items of groups.values()) {
      const first = items[0];
      if (!first) continue;
      const records = uniqueRecords(items).map(canonical);
      switch (first.toolName) {
        case 'reminder_create': cards.push(formatCanonicalReminderCreate(records, context)); break;
        case 'reminder_update': cards.push(...records.map(record => formatCanonicalReminderUpdate(record, context))); break;
        case 'reminder_acknowledge': cards.push(...records.map(record => formatCanonicalReminderAcknowledge(record, context))); break;
        case 'reminder_read': cards.push(formatCanonicalReminderList({ reminders: records,
          ...(first.readFilter ? { filter: first.readFilter } : {}), ...(first.readQuery ? { query: first.readQuery } : {}),
        }, context)); break;
      }
      if (items.some(item => item.status === 'partial')) {
        cards.push(payload.language === 'en'
          ? '⚠️ *Partially completed*\nThe confirmed changes are shown above. Some requested details remain unconfirmed.'
          : '⚠️ *Completado parcialmente*\nLos cambios confirmados están arriba. Algunos detalles solicitados siguen sin confirmar.');
      }
      const questions = [...new Set(items.flatMap(item => item.result?.presentation.questions ?? []))];
      if (questions.length) cards.push(questions.join('\n'));
    }
    const text = [...new Set([...cards, ...sections].filter(Boolean))].join('\n\n');
    const notice = payload.notices.length ? (payload.language === 'en'
      ? 'I could not complete all of this request. No additional actions were attempted.'
      : 'No pude completar toda esta solicitud. No intenté acciones adicionales.') : '';
    return { text: [text, notice].filter(Boolean).join('\n\n') || (payload.language === 'en'
      ? 'What reminder would you like to create, check or change?'
      : '¿Qué recordatorio quieres crear, consultar o cambiar?'), ctas: [...ctas.values()] };
  }
}
