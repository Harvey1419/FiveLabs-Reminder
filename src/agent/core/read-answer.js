import { READ_ANSWER_OPERATIONS, validateReadAnswer } from '../contracts/read-answer.js';
import { formatHumanFriendlyDateTime } from '../../shared/time.js';

const LABELS = Object.freeze({
  es: { task: 'tareas', reminder: 'recordatorios', calendar: 'eventos', project: 'proyectos', entity: 'entidades' },
  en: { task: 'tasks', reminder: 'reminders', calendar: 'events', project: 'projects', entity: 'entities' },
});
const STATUS = Object.freeze({
  es: { pending: 'pendiente', in_progress: 'en progreso', completed: 'completado', cancelled: 'cancelado',
    sent: 'enviado', acknowledged: 'confirmado', active: 'activo', confirmed: 'confirmado', tentative: 'tentativo' },
  en: { pending: 'pending', in_progress: 'in progress', completed: 'completed', cancelled: 'cancelled',
    sent: 'sent', acknowledged: 'acknowledged', active: 'active', confirmed: 'confirmed', tentative: 'tentative' },
});
const DISPLAY_LIMIT = 5;

function text(value) {
  return typeof value === 'string' ? value.split('\n').map((part) => part.trim()).join(' ').replaceAll('\r', ' ').trim() : '';
}

function recordsFromFact(fact, domain) {
  const data = fact.presentationData;
  if (Array.isArray(data)) return data;
  const key = { task: 'tasks', reminder: 'reminders', calendar: 'events', project: 'projects', entity: 'entities' }[domain];
  if (Array.isArray(data?.[key])) return data[key];
  // Structured item envelopes are backend results, not conversational text.
  if (Array.isArray(data?.items)) return data.items.map((item) => item.raw || item);
  return null;
}

function recordedTime(row, domain, context) {
  const existing = row.localFormatted || row.formattedTime || row.displayDate;
  if (existing) return text(existing);
  if (domain === 'calendar' && row.isAllDay && row.startDate) return text(row.startDate);
  const raw = domain === 'task' ? (row.due_date || row.dueDate)
    : domain === 'reminder' ? (row.send_at || row.sendAt)
      : (row.start?.dateTime || row.start?.date || row.startDateTime || row.startTime || row.startIso);
  if (!raw) return '';
  const date = new Date(raw);
  if (!Number.isFinite(date.getTime())) return '';
  return formatHumanFriendlyDateTime(date, context.timezone, context.language);
}

function describeRecord(row, domain, fields, context) {
  const { language } = context;
  const title = text(row.title || row.content || row.summary || row.name);
  const status = STATUS[language][row.status] || text(row.status);
  const identity = `«${title}»${status ? ` (${status})` : ''}`;
  const parts = [identity];
  if (fields.includes('description')) {
    const description = text(row.description || row.notes);
    parts.push(description || (language === 'en' ? 'No description was returned' : 'La consulta no devolvió una descripción'));
  }
  if (fields.includes('schedule')) {
    const when = recordedTime(row, domain, context);
    parts.push(when || (language === 'en' ? 'No date was returned' : 'La consulta no devolvió una fecha'));
  }
  return parts.join(' — ');
}

/**
 * Project an operational response from the exact execution fact selected by
 * Hermes. No history, memories, user text, model prose, or numeric operands are
 * accepted here. Semantic routing remains in Hermes; values remain in Tools.
 */
export function presentReadAnswer(intent, execution, { userId, language = 'es', timezone = 'America/Bogota' } = {}) {
  const executionFacts = execution.facts || [];
  if (!intent?.readAnswer) return { facts: executionFacts, evidence: null, sourceCallId: null };
  const lang = language === 'en' ? 'en' : 'es';
  const validation = validateReadAnswer(intent.readAnswer, intent.actions || []);
  if (!validation.valid) throw new Error(validation.error);
  const plan = validation.readAnswer;
  const sourceAction = intent.actions[plan.actionIndex];
  // Executor indexes operational actions only; conversational framing is never
  // a source. Preserve this mapping even in mixed turns and batched mutations.
  const index = intent.actions.slice(0, plan.actionIndex).filter((action) => action.domain !== 'conversation').length;
  const record = (execution.records || []).find((candidate) => candidate.sourceActionIndex === index);
  const fact = record?.fact;
  const callId = fact?.callId || null;
  const expected = READ_ANSWER_OPERATIONS[`${sourceAction.domain}.${sourceAction.action}`];
  const tool = expected.tool;
  const safeFailure = lang === 'en'
    ? 'I could not verify that information from the current read.'
    : 'No pude verificar ese dato con la consulta actual.';
  const matches = fact?.tool === tool && fact?.requestedAction === expected.action;
  if (!matches) {
    // This indicates an internal wiring failure. Never fall back to stale chat.
    const failed = { success: false, complete: false, card: safeFailure, summary: safeFailure,
      errorCode: 'READ_EVIDENCE_MISSING', requiresClarification: false };
    return { facts: fact ? executionFacts.map((item) => item === fact ? failed : item) : [...executionFacts, failed],
      evidence: null, sourceCallId: null };
  }
  if (!fact.success) return { facts: executionFacts, evidence: null, sourceCallId: callId };

  const rows = recordsFromFact(fact, sourceAction.domain);
  const malformed = !rows || rows.some((row) => !row || typeof row !== 'object'
    || !(row.id || row.internalId) || (userId && row.user_id && row.user_id !== userId)
    || !text(row.title || row.content || row.summary || row.name));
  const ids = malformed ? [] : rows.map((row) => String(row.id || row.internalId));
  const duplicateIds = new Set(ids).size !== ids.length;
  const complete = fact.complete === true && fact.presentationData?.readCoverage?.complete === true;
  const context = { language: lang, timezone };
  const container = text(fact.presentationData?.entityName);
  const scopeText = container ? (lang === 'en' ? ` in ${container}` : ` en ${container}`) : '';
  const label = LABELS[lang][sourceAction.domain];
  const singular = { es: { task: 'tarea', reminder: 'recordatorio', calendar: 'evento', project: 'proyecto', entity: 'entidad' },
    en: { task: 'task', reminder: 'reminder', calendar: 'event', project: 'project', entity: 'entity' } }[lang][sourceAction.domain];
  const countLabel = rows?.length === 1 ? singular : label;
  let card;
  if (malformed || duplicateIds) {
    card = safeFailure;
  } else if (plan.mode === 'count') {
    // A limited/unknown read proves only a lower bound, never a total.
    card = complete
      ? (lang === 'en' ? `The current query returned ${rows.length} ${countLabel}${scopeText}.` : `La consulta actual devuelve ${rows.length} ${countLabel}${scopeText}.`)
      : (lang === 'en' ? `I found ${rows.length} ${countLabel}${scopeText}, but the read is incomplete; I cannot confirm the total.`
        : `Encontré ${rows.length} ${countLabel}${scopeText}, pero la lectura es incompleta; no puedo confirmar el total.`);
  } else if (rows.length === 0) {
    card = complete
      ? (lang === 'en' ? `No ${label} matched this query${scopeText}.` : `No encontré ${label} que coincidan con esta consulta${scopeText}.`)
      : (lang === 'en' ? 'The read returned no matching records, but it is incomplete; I cannot confirm their absence.'
        : 'La lectura no devolvió registros coincidentes, pero es incompleta; no puedo confirmar su ausencia.');
  } else {
    const shown = rows.slice(0, DISPLAY_LIMIT);
    const details = shown.map((row) => describeRecord(row, sourceAction.domain, plan.fields, context));
    card = lang === 'en' ? `Currently recorded${scopeText}: ` : `Actualmente figura${scopeText}: `;
    card += details.length === 1 ? `${details[0]}.` : `\n${details.map((detail) => `• ${detail}`).join('\n')}`;
    if (rows.length > shown.length) card += lang === 'en'
      ? `\nShowing ${shown.length} of ${rows.length} returned records.` : `\nMostrando ${shown.length} de ${rows.length} registros devueltos.`;
    if (fact.presentationData?.readCoverage?.complete === false || fact.complete !== true) card += lang === 'en' ? '\nThis read does not establish the complete inventory.' : '\nEsta lectura no acredita el inventario completo.';
  }

  const evidence = malformed || duplicateIds ? null : Object.freeze({
    sourceCallId: callId, tool, action: fact.requestedAction, mode: plan.mode,
    recordIds: Object.freeze(plan.mode === 'count' ? ids : ids.slice(0, DISPLAY_LIMIT)),
    fields: Object.freeze(plan.mode === 'records' ? [...new Set(['title', 'status', ...plan.fields])] : []),
    complete, readAt: fact.presentationData?.readAt || record.executedAt || null,
  });
  const projected = Object.freeze({ ...fact, card, flow: null, readAnswerEvidence: evidence,
    ...(malformed || duplicateIds ? { success: false, complete: false, outcome: 'failure',
      errorCode: 'READ_EVIDENCE_INVALID', summary: safeFailure, presentationData: null } : {}),
  });
  return { facts: executionFacts.map((item) => item === fact ? projected : item), evidence, sourceCallId: callId };
}
