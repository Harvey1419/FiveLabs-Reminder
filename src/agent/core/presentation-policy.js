import { TOOL_NAMES } from '../contracts/tool-names.js';
import { sanitizeResponseText } from './working-memory.js';
import {
  formatCanonicalReminderCreateBatch,
  formatCanonicalReminderCancelBatch,
} from '../../shared/reminder-presentation.js';

const TOOL_DOMAINS = Object.freeze({
  [TOOL_NAMES.MANAGE_REMINDER]: 'reminder',
  [TOOL_NAMES.MANAGE_TASK]: 'task',
  [TOOL_NAMES.MANAGE_ENTITY]: 'entity',
  [TOOL_NAMES.MANAGE_MEMORY]: 'memory',
  [TOOL_NAMES.MANAGE_SUBSCRIPTION]: 'subscription',
  [TOOL_NAMES.GET_SUBSCRIPTION_LINK]: 'subscription',
  [TOOL_NAMES.MANAGE_GOOGLE_CALENDAR]: 'calendar',
  [TOOL_NAMES.GET_UNIFIED_AGENDA]: 'agenda',
  [TOOL_NAMES.ADMIN_METRICS]: 'admin',
});

const DOMAIN_LABELS = Object.freeze({
  es: {
    reminder: ['🔔', 'Recordatorios'],
    task: ['☑️', 'Tareas'],
    calendar: ['📅', 'Google Calendar'],
    entity: ['📁', 'Proyectos y entidades'],
    memory: ['🧠', 'Memoria'],
    subscription: ['💳', 'Suscripción'],
    agenda: ['📋', 'Agenda'],
    admin: ['📊', 'Administración'],
    other: ['✅', 'Acciones'],
  },
  en: {
    reminder: ['🔔', 'Reminders'],
    task: ['☑️', 'Tasks'],
    calendar: ['📅', 'Google Calendar'],
    entity: ['📁', 'Projects and entities'],
    memory: ['🧠', 'Memory'],
    subscription: ['💳', 'Subscription'],
    agenda: ['📋', 'Agenda'],
    admin: ['📊', 'Administration'],
    other: ['✅', 'Actions'],
  },
});

const OPERATION_LABELS = Object.freeze({
  es: {
    create: 'creados', update: 'actualizados', cancel: 'eliminados', delete: 'eliminados',
    complete: 'completados', acknowledge: 'confirmados', save: 'guardados', forget: 'eliminados',
    connect: 'conectado', disconnect: 'desconectado',
  },
  en: {
    create: 'created', update: 'updated', cancel: 'removed', delete: 'removed', complete: 'completed',
    acknowledge: 'confirmed', save: 'saved', forget: 'removed', connect: 'connected', disconnect: 'disconnected',
  },
});

export const PRESENTATION_KINDS = Object.freeze({
  SINGLE: 'single',
  CLARIFICATION: 'clarification',
  HOMOGENEOUS_BATCH: 'homogeneous_batch',
  MIXED_BATCH: 'mixed_batch',
  PARTIAL_SUCCESS: 'partial_success',
  FAILURE_BATCH: 'failure_batch',
});

function languageKey(language) {
  return language === 'en' ? 'en' : 'es';
}

export function getFactDomain(fact) {
  return TOOL_DOMAINS[fact?.tool] || 'other';
}

function getFactOperation(fact) {
  return String(fact?.requestedAction || fact?.action || 'executed').trim().toLowerCase();
}

function groupKey(fact) {
  return `${getFactDomain(fact)}:${getFactOperation(fact)}`;
}

export function classifyTurnPresentation(facts) {
  const safeFacts = (facts || []).filter(Boolean);
  if (safeFacts.length <= 1) return PRESENTATION_KINDS.SINGLE;

  const succeeded = safeFacts.filter((fact) => fact.success);
  const failed = safeFacts.filter((fact) => !fact.success);
  const clarifications = failed.filter((fact) => fact.requiresClarification);

  // A clarification is local to the action that needs it. It must not destroy
  // aggregation of other verified actions from the same user turn.
  if (succeeded.length > 0 && failed.length > 0) return PRESENTATION_KINDS.PARTIAL_SUCCESS;
  if (succeeded.length === 0 && clarifications.length > 0) return PRESENTATION_KINDS.CLARIFICATION;
  if (succeeded.length === 0) return PRESENTATION_KINDS.FAILURE_BATCH;

  return succeeded.every((fact) => groupKey(fact) === groupKey(succeeded[0]))
    ? PRESENTATION_KINDS.HOMOGENEOUS_BATCH
    : PRESENTATION_KINDS.MIXED_BATCH;
}

function asArray(data) {
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.items)) return data.items;
  if (Array.isArray(data?.tasks)) return data.tasks;
  if (Array.isArray(data?.reminders)) return data.reminders;
  return data && typeof data === 'object' ? [data] : [];
}

function itemName(item, fact) {
  const candidates = [
    item?.displayContent, item?.content, item?.title, item?.summary, item?.name, item?.entityName, item?.newName,
    fact?.presentationParams?.newName, fact?.presentationParams?.title, fact?.presentationParams?.content,
    fact?.presentationParams?.target,
  ];
  return candidates.find((value) => typeof value === 'string' && value.trim())?.trim() || '';
}

function logicalItems(fact) {
  const domain = getFactDomain(fact);
  const operation = getFactOperation(fact);
  const items = asArray(fact?.presentationData);

  if (domain === 'reminder' && operation === 'create') {
    const mains = items.filter((item) => !item?.isAdvanceNotice);
    return mains.length > 0 ? mains : items;
  }
  return items;
}

function compactFallback(fact) {
  const text = sanitizeResponseText(fact?.summary || fact?.card || '');
  if (!text) return '';
  return text.split('\n').map((line) => line.trim()).filter(Boolean).slice(-1)[0] || text;
}

function compactFactLines(fact) {
  const domain = getFactDomain(fact);
  const items = logicalItems(fact);
  const lines = [];

  for (const item of items) {
    const name = itemName(item, fact);
    if (!name) continue;
    const recurring = Boolean(item?.recurrenceRule || item?.recurrence_rule || fact?.presentationData?.recurring);
    const icon = domain === 'reminder' ? (recurring ? '🔁' : '🔔') : '•';
    lines.push(`${icon} ${name}`);
  }

  if (lines.length > 0) return lines;
  const target = itemName({}, fact);
  if (target) return [`• ${target}`];
  const fallback = compactFallback(fact);
  return fallback ? [`• ${fallback}`] : [];
}

function formatTaskCreateBatch(facts, language) {
  const items = facts.flatMap((fact) => asArray(fact.presentationData));
  if (items.length === 0) return null;
  const header = language === 'en'
    ? `✅ *${items.length} task${items.length === 1 ? '' : 's'} created*`
    : `✅ *${items.length} ${items.length === 1 ? 'tarea creada' : 'tareas creadas'}*`;

  const groups = new Map();
  for (const item of items) {
    const project = item?.entityName || (language === 'en' ? 'No project' : 'Sin proyecto');
    if (!groups.has(project)) groups.set(project, []);
    groups.get(project).push(item);
  }

  const sections = [];
  for (const [project, projectItems] of groups.entries()) {
    const noProjectLabel = language === 'en' ? 'No project' : 'Sin proyecto';
    const showProject = project !== noProjectLabel || groups.size > 1;
    const lines = projectItems.map((item) => `• ${item.title || item.content || (language === 'en' ? 'Task' : 'Tarea')}`);
    sections.push(`${showProject ? `📁 *${project}*\n` : ''}${lines.join('\n')}`);
  }
  return `${header}\n\n${sections.join('\n\n')}`;
}

function formatHomogeneousGroup(facts, language, { includeHeader = true } = {}) {
  if (!facts.length) return '';
  const domain = getFactDomain(facts[0]);
  const operation = getFactOperation(facts[0]);

  if (includeHeader && domain === 'reminder' && operation === 'create') {
    return formatCanonicalReminderCreateBatch(
      facts.map((fact) => fact.presentationData),
      { language, timezone: facts.map((fact) => fact.presentationContext?.timezone).find(Boolean) || 'UTC' },
    );
  }

  if (includeHeader && domain === 'reminder' && operation === 'cancel') {
    return formatCanonicalReminderCancelBatch(facts.map((fact) => fact.presentationData), { language });
  }

  if (includeHeader && domain === 'task' && operation === 'create') {
    return formatTaskCreateBatch(facts, language);
  }

  const lang = languageKey(language);
  const [icon, domainLabel] = DOMAIN_LABELS[lang][domain] || DOMAIN_LABELS[lang].other;
  const opLabel = OPERATION_LABELS[lang][operation] || (language === 'en' ? 'completed' : 'realizadas');
  const lines = facts.flatMap((fact) => compactFactLines(fact));
  const count = lines.length || facts.length;
  if (!includeHeader) return lines.join('\n');
  return `${icon} *${domainLabel} · ${count} ${opLabel}*${lines.length ? `\n\n${lines.join('\n')}` : ''}`;
}

function formatSuccesses(facts, language) {
  if (!facts.length) return '';
  const homogeneous = facts.every((fact) => groupKey(fact) === groupKey(facts[0]));
  return homogeneous
    ? formatHomogeneousGroup(facts, language)
    : formatMixedSuccess(facts, language);
}

function formatMixedSuccess(facts, language) {
  const groups = new Map();
  for (const fact of facts) {
    const key = groupKey(fact);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(fact);
  }

  const header = language === 'en'
    ? `✅ *${facts.length} actions completed*`
    : `✅ *${facts.length} ${facts.length === 1 ? 'acción realizada' : 'acciones realizadas'}*`;

  const sections = [];
  for (const group of groups.values()) {
    const domain = getFactDomain(group[0]);
    const operation = getFactOperation(group[0]);
    const lang = languageKey(language);
    const [icon, domainLabel] = DOMAIN_LABELS[lang][domain] || DOMAIN_LABELS[lang].other;
    const opLabel = OPERATION_LABELS[lang][operation] || (language === 'en' ? 'completed' : 'realizadas');
    const body = formatHomogeneousGroup(group, language, { includeHeader: false });
    sections.push(`${icon} *${domainLabel} · ${opLabel}*${body ? `\n${body}` : ''}`);
  }
  return `${header}\n\n${sections.join('\n\n')}`;
}

function formatFailures(failed, language) {
  if (!failed.length) return '';
  const header = language === 'en'
    ? `⚠️ *${failed.length} action${failed.length === 1 ? '' : 's'} could not be completed*`
    : `⚠️ *${failed.length} ${failed.length === 1 ? 'acción no se pudo completar' : 'acciones no se pudieron completar'}*`;
  const lines = failed.map((fact) => `• ${compactFallback(fact) || (language === 'en' ? 'Operation failed.' : 'La operación falló.')}`);
  return `${header}\n${lines.join('\n')}`;
}

function formatClarifications(clarifications, language) {
  if (!clarifications.length) return '';
  const header = language === 'en'
    ? `⚠️ *${clarifications.length} ${clarifications.length === 1 ? 'item needs clarification' : 'items need clarification'}*`
    : `⚠️ *${clarifications.length} ${clarifications.length === 1 ? 'necesita aclaración' : 'necesitan aclaración'}*`;
  const bodies = clarifications
    .map((fact) => sanitizeResponseText(fact?.card || fact?.summary || ''))
    .filter(Boolean);
  return `${header}${bodies.length ? `\n\n${bodies.join('\n\n')}` : ''}`;
}

/**
 * Turn-level presentation policy.
 * Tools expose verified facts; this layer decides how the whole user turn is communicated.
 * Domain presenters render entities/collections but never decide turn composition.
 */
export function composeTurnPresentation(facts, language = 'es') {
  const safeFacts = (facts || []).filter(Boolean);
  if (safeFacts.length === 0) return '';

  const kind = classifyTurnPresentation(safeFacts);
  if (kind === PRESENTATION_KINDS.SINGLE) return safeFacts[0].card || safeFacts[0].summary || '';

  const succeeded = safeFacts.filter((fact) => fact.success);
  const clarifications = safeFacts.filter((fact) => !fact.success && fact.requiresClarification);
  const hardFailures = safeFacts.filter((fact) => !fact.success && !fact.requiresClarification);

  if (kind === PRESENTATION_KINDS.CLARIFICATION) {
    return formatClarifications(clarifications, language)
      || safeFacts.map((fact) => fact.card || fact.summary).filter(Boolean).join('\n\n');
  }

  return [
    formatSuccesses(succeeded, language),
    formatClarifications(clarifications, language),
    formatFailures(hardFailures, language),
  ].filter(Boolean).join('\n\n');
}
