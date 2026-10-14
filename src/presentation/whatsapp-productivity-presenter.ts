import { boundWhatsAppText } from '../shared/whatsapp-text-boundary.js';
import {
  productivityUiPayloadSchema, type ProductivityItem, type ProductivityUiPayload, type TaskRecord,
  type TaskResult, type CalendarEvent,
} from '@templelabs/contracts';
import { WhatsAppCardPresenter, type WhatsAppPresentation } from './whatsapp-card-presenter.js';
import {
  formatCanonicalTaskCreate, formatCanonicalTaskComplete, formatCanonicalTaskUpdate, formatCanonicalTaskDelete,
} from '../shared/task-presentation.js';
import { formatCanonicalTaskList } from '../shared/agenda-presentation.js';
import { formatHumanFriendlyDateTime } from '../shared/time.js';

export interface ProductivityPresentation extends WhatsAppPresentation {
  readonly flows: readonly NonNullable<TaskResult['flow']>[];
}
function canonical(task: TaskRecord) {
  return { ...task, dueDate: task.dueDateIso };
}
function errorText(item: ProductivityItem, en: boolean): string {
  if (item.status === 'indeterminate' || item.code === 'EFFECT_RECONCILIATION_REQUIRED') return en
    ? '⚠️ *Outcome not confirmed*\nThis action needs checking before trying again.'
    : '⚠️ *Resultado sin confirmar*\nHay que verificar esta acción antes de volver a intentarla.';
  if (item.status === 'clarification_required') return item.result?.presentation.questions.join('\n')
    || (en ? 'Which item or time did you mean?' : '¿A qué elemento u horario te refieres?');
  if (item.status === 'approval_required') return en ? 'Please confirm this change.' : 'Confírmame este cambio.';
  if (item.code === 'PRO_TIER_REQUIRED') return en ? '✨ This action needs Pro.' : '✨ Esta acción necesita Pro.';
  if (item.status === 'denied') return en ? 'No permission was available for this action.' : 'No había permiso para realizar esta acción.';
  if (item.status === 'validation_failed') return en ? 'Please clarify the action details.' : 'Aclárame los datos de la acción.';
  return en ? 'I could not complete this action.' : 'No pude completar esta acción.';
}
function calendarLine(event: CalendarEvent, timezone: string, language: 'es' | 'en'): string {
  if (event.kind === 'all_day') {
    const [year, month, day] = event.startDate.split('-');
    return `• 📅 *${event.summary}* — ${day}/${month}/${year} (${language === 'en' ? 'All day' : 'Todo el día'})`;
  }
  const meet = event.meetLink && /^https:\/\//i.test(event.meetLink) ? ` (Google Meet: ${event.meetLink})` : '';
  return `• 📅 *${event.summary}* — ${formatHumanFriendlyDateTime(event.startIso, timezone, language)}${meet}`;
}

/** Renders owned domain facts with existing card vocabulary. Never accepts provider prose. */
export class WhatsAppProductivityPresenter {
  render(raw: ProductivityUiPayload): ProductivityPresentation {
    const payload = productivityUiPayloadSchema.parse(raw);
    new Intl.DateTimeFormat('en', { timeZone: payload.timezone }).format();
    const en = payload.language === 'en';
    const context = { language: payload.language, timezone: payload.timezone };
    const sections: string[] = [];
    // Only final public dialogue accompanies fully confirmed outcomes. Failures own their wording.
    if (payload.conversationReply?.trim() && !payload.notices.length && payload.items.every(item => item.status === 'success')) {
      sections.push(payload.conversationReply.trim());
    }
    const ctas = new Map<string, WhatsAppPresentation['ctas'][number]>();
    const flows = new Map<string, NonNullable<TaskResult['flow']>>();
    const groups = new Map<string, ProductivityItem[]>();
    for (const item of payload.items) {
      if (item.toolName.endsWith('_read') && item.status === 'success' && item.result) {
        const ids = item.domain === 'calendar' ? item.result.events.map(event => event.id) : item.result.records.map(record => record.id);
        const written = new Set(payload.items.filter(other => other.domain === item.domain && !other.toolName.endsWith('_read')
          && other.status === 'success' && other.result?.complete).flatMap(other => !other.result ? []
            : other.domain === 'calendar' ? other.result.events.map(event => event.id) : other.result.records.map(record => record.id)));
        if (ids.length && ids.every(id => written.has(id))) continue;
      }
      const cta = item.result?.presentation.cta;
      if (cta?.url && /^https:\/\//i.test(cta.url)) {
        const url = new URL(cta.url);
        if (!url.username && !url.password) ctas.set(cta.url, { ...cta, url: cta.url });
      }
      if (item.domain === 'reminders') {
        // Preserve the reminder presenter as the canonical implementation.
        const key = `reminders:${item.toolName}:${JSON.stringify(item.readScope ?? {})}`;
        groups.set(key, [...(groups.get(key) ?? []), item]); continue;
      }
      if (item.domain === 'calendar' && item.result?.connection === 'authorization_required') {
        sections.push(en ? '🔒 Connect Google Calendar to continue.' : '🔒 Conecta Google Calendar para continuar.');
      }
      if (item.status !== 'success' && item.status !== 'partial') {
        if (item.domain !== 'calendar' || item.result?.connection !== 'authorization_required') sections.push(errorText(item, en));
        continue;
      }
      if (item.domain === 'tasks' && item.result?.flow) {
        const flow = item.result.flow;
        if (flow.flowId && flow.flowToken) flows.set(`${flow.flowId}:${flow.flowToken}`, structuredClone(flow));
      }
      const key = `${item.toolName}:${JSON.stringify(item.readScope ?? {})}`;
      groups.set(key, [...(groups.get(key) ?? []), item]);
    }
    for (const items of groups.values()) {
      const first = items[0]!;
      if (first.domain === 'reminders') {
        const reply = new WhatsAppCardPresenter().render({ ...context, notices: [], items: items.map(item => {
          if (item.domain !== 'reminders') throw new Error('Mixed reminder group');
          return { callId: item.callId, toolName: item.toolName, status: item.status, code: item.code,
            result: item.result, readFilter: item.readScope?.filter ?? null, readQuery: item.readScope?.query ?? null };
        }) });
        sections.push(reply.text);
        if (items.some(item => item.result?.coverage === 'bounded_list')) sections.push(en
          ? 'This is a limited list of returned results.' : 'Esta es una lista limitada de los resultados devueltos.');
        continue;
      }
      if (first.domain === 'tasks') {
        const records = new Map<string, TaskRecord>();
        for (const item of items) if (item.domain === 'tasks') {
          for (const task of item.result?.records ?? []) records.set(task.id, task);
        }
        const tasks = [...records.values()].map(canonical);
        switch (first.toolName) {
          case 'task_create': sections.push(formatCanonicalTaskCreate(tasks, context)); break;
          case 'task_read': sections.push(formatCanonicalTaskList({ tasks, ...first.readScope }, context)); break;
          case 'task_update': sections.push(...tasks.map(task => formatCanonicalTaskUpdate(task, context))); break;
          case 'task_complete': sections.push(...tasks.map(task => formatCanonicalTaskComplete(task, context))); break;
          case 'task_delete': sections.push(...tasks.map(task => formatCanonicalTaskDelete(task, context))); break;
        }
      } else {
        const events = new Map<string, CalendarEvent>();
        for (const item of items) if (item.domain === 'calendar') {
          for (const event of item.result?.events ?? []) events.set(event.id, event);
        }
        if (first.toolName === 'calendar_connect') {
          if (first.result?.connection === 'connected') sections.push(en ? '✅ Google Calendar connected.' : '✅ Google Calendar conectado.');
        } else {
          const heading = first.toolName === 'calendar_create'
            ? (en ? '✅ *Event created*' : '✅ *Evento creado*')
            : first.toolName === 'calendar_update' ? (en ? '✏️ *Event updated*' : '✏️ *Evento actualizado*')
            : first.toolName === 'calendar_delete' ? (en ? '🗑️ *Event deleted*' : '🗑️ *Evento eliminado*') : '📅 *Google Calendar*';
          const scope = first.readScope;
          const labels: Record<string, [string, string]> = {
            today: ['hoy', 'today'], remaining_today: ['lo que queda de hoy', 'the rest of today'],
            tomorrow: ['mañana', 'tomorrow'], day_after_tomorrow: ['pasado mañana', 'the day after tomorrow'],
            monday: ['lunes', 'Monday'], tuesday: ['martes', 'Tuesday'], wednesday: ['miércoles', 'Wednesday'],
            thursday: ['jueves', 'Thursday'], friday: ['viernes', 'Friday'], saturday: ['sábado', 'Saturday'], sunday: ['domingo', 'Sunday'],
            this_week: ['esta semana', 'this week'], next_week: ['la próxima semana', 'next week'],
            this_weekend: ['este fin de semana', 'this weekend'], upcoming: ['próximos días', 'upcoming days'],
            next_event: ['próximo evento', 'next event'],
          };
          const label = scope?.scope ? labels[scope.scope]?.[en ? 1 : 0] ?? scope.scope : null;
          const qualifier = label || scope?.query ? `\n${[label, scope?.query].filter(Boolean).join(' · ')}` : '';
          const lines = [...events.values()].map(event => calendarLine(event, payload.timezone, payload.language));
          sections.push(`${heading}${qualifier}\n\n${lines.join('\n') || (en ? 'No matching events returned.' : 'No se devolvieron eventos que coincidan.')}`);
        }
      }
      if (items.some(item => item.status === 'partial' || item.result?.complete === false)) {
        sections.push(en
          ? '⚠️ *Partially completed*\nThe confirmed results are shown above. Some requested details remain unconfirmed.'
          : '⚠️ *Completado parcialmente*\nLos resultados confirmados están arriba. Algunos detalles solicitados siguen sin confirmar.');
      }
      if (items.some(item => item.result?.coverage === 'bounded_list')) {
        sections.push(en ? 'This is a limited list of returned results.' : 'Esta es una lista limitada de los resultados devueltos.');
      }
      sections.push(...items.flatMap(item => item.result?.presentation.questions ?? []));
    }
    if (payload.notices.includes('provider_unavailable')) sections.push(en ? 'I could not finish the response right now. Confirmed results are shown above.' : 'No pude terminar la respuesta en este momento. Los resultados confirmados están arriba.');
    else if (payload.notices.length) sections.push(en ? 'I could not finish all of this request. Confirmed results are shown above.' : 'No pude completar toda la solicitud. Los resultados confirmados están arriba.');
    return { text: boundWhatsAppText([...new Set(sections.filter(Boolean))].join('\n\n')
      || (en ? 'I could not prepare a useful response. Could you tell me a little more?' : 'No pude preparar una respuesta útil. ¿Me cuentas un poco más?')),
    ctas: [...ctas.values()], flows: [...flows.values()] };
  }
}
