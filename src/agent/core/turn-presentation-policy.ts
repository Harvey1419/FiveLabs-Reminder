import { TOOL_NAMES } from '../contracts/tool-names-contract.js';
import { PRESENTATION_TOKENS } from '../../shared/presentation-design-tokens.js';
export interface TurnPresentationFact extends Record<string, unknown> {
  tool?: string; requestedAction?: unknown; action?: unknown;
  success?: unknown; complete?: boolean; outcome?: string; requiresClarification?: unknown; errorCode?: unknown;
  summary?: string | null; card?: string | null; presentationData?: unknown; data?: unknown;
  presentationParams?: Record<string, unknown> | null;
  presentationContext?: { timezone?: string; language?: string } | null;
}
type MaybeFact = TurnPresentationFact | null | undefined | false;
export interface TurnPresentationDependencies {
  sanitizeResponseText(value: unknown): string;
  formatCanonicalTaskCreate(items: Record<string, unknown>[], context: { language: string; timezone: string }): string | null;
  formatCanonicalReminderCreateBatch(data: unknown[], context: { language: string; timezone: string }): string | null;
  formatCanonicalReminderCancelBatch(data: unknown[], context: { language: string }): string;
  formatHumanFriendlyDateTime(value: unknown, timezone: string, language: string): string;
}
function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' ? value as Record<string, unknown> : null;
}
function safeFacts(facts: MaybeFact[] | null | undefined): TurnPresentationFact[] {
  return (facts || []).filter((fact): fact is TurnPresentationFact => Boolean(fact));
}

const TOOL_DOMAINS: Readonly<Record<string, string>> = Object.freeze({
  [TOOL_NAMES.MANAGE_REMINDER]: 'reminder',
  [TOOL_NAMES.MANAGE_TASK]: 'task',
  [TOOL_NAMES.MANAGE_PROJECT]: 'project',
  [TOOL_NAMES.MANAGE_ENTITY]: 'entity',
  [TOOL_NAMES.MANAGE_MEMORY]: 'memory',
  [TOOL_NAMES.MANAGE_SUBSCRIPTION]: 'subscription',
  [TOOL_NAMES.MANAGE_GOOGLE_CALENDAR]: 'calendar',
  [TOOL_NAMES.GET_UNIFIED_AGENDA]: 'agenda',
  [TOOL_NAMES.ADMIN_METRICS]: 'admin',
});

const DOMAIN_LABELS: Readonly<Record<'es' | 'en', Record<string, [string, string]>>> = Object.freeze({
  es: {
    reminder: ['🔔', 'Recordatorios'],
    task: ['☑️', 'Tareas'],
    calendar: ['📅', 'Google Calendar'],
    project: ['📁', 'Proyectos y listas'],
    entity: ['🗂️', 'Entidades de conocimiento'],
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
    project: ['📁', 'Projects and lists'],
    entity: ['🗂️', 'Knowledge entities'],
    memory: ['🧠', 'Memory'],
    subscription: ['💳', 'Subscription'],
    agenda: ['📋', 'Agenda'],
    admin: ['📊', 'Administration'],
    other: ['✅', 'Actions'],
  },
});

const OPERATION_LABELS: Readonly<Record<'es' | 'en', Record<string, string>>> = Object.freeze({
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

const READ_OPERATIONS = new Set([
  'list', 'read', 'search', 'next',
  'list_events', 'search_events', 'next_event', 'get_next_event', 'get_agenda',
]);

/** Central grouping consumes observed view facts and delegates canonical collection rendering. */
export function createTurnPresentation(dependencies: TurnPresentationDependencies) {
  const { sanitizeResponseText, formatCanonicalTaskCreate, formatCanonicalReminderCreateBatch, formatCanonicalReminderCancelBatch, formatHumanFriendlyDateTime } = dependencies;

  function isReadFact(fact: TurnPresentationFact): boolean {
    return READ_OPERATIONS.has(getFactOperation(fact))
      || getFactDomain(fact) === 'agenda';
  }

  function languageKey(language: string): 'es' | 'en' {
    return language === 'en' ? 'en' : 'es';
  }

  function getFactDomain(fact?: TurnPresentationFact | null): string {
    return TOOL_DOMAINS[fact?.tool || ''] || 'other';
  }

  function getFactOperation(fact: TurnPresentationFact): string {
    return String(fact?.requestedAction || fact?.action || 'executed').trim().toLowerCase();
  }

  function groupKey(fact: TurnPresentationFact): string {
    return `${getFactDomain(fact)}:${getFactOperation(fact)}`;
  }

  function classifyTurnPresentation(facts: MaybeFact[] | null | undefined): string {
    const validFacts = safeFacts(facts);
    if (validFacts.length === 0) return PRESENTATION_KINDS.SINGLE;

    const succeeded = validFacts.filter((fact) => fact.success);
    const failed = validFacts.filter((fact) => !fact.success);
    const clarifications = failed.filter((fact) => fact.requiresClarification);
    const hasPartialSuccess = succeeded.some((fact) => fact.complete === false || fact.outcome === 'partial_success');

    if (validFacts.length === 1) return hasPartialSuccess ? PRESENTATION_KINDS.PARTIAL_SUCCESS : PRESENTATION_KINDS.SINGLE;

    // A clarification is local to the action that needs it. It must not destroy
    // aggregation of other verified actions from the same user turn.
    if (hasPartialSuccess || (succeeded.length > 0 && failed.length > 0)) return PRESENTATION_KINDS.PARTIAL_SUCCESS;
    if (succeeded.length === 0 && clarifications.length > 0) return PRESENTATION_KINDS.CLARIFICATION;
    if (succeeded.length === 0) return PRESENTATION_KINDS.FAILURE_BATCH;

    return succeeded.every((fact) => groupKey(fact) === groupKey(succeeded[0]!))
      ? PRESENTATION_KINDS.HOMOGENEOUS_BATCH
      : PRESENTATION_KINDS.MIXED_BATCH;
  }

  /** Row shape is a trusted presenter payload projection, not canonical model admission. */
  function asArray(data: unknown): Record<string, unknown>[] {
    if (Array.isArray(data)) return data as Record<string, unknown>[];
    const value = record(data);
    if (Array.isArray(value?.items)) return value.items as Record<string, unknown>[];
    if (Array.isArray(value?.tasks)) return value.tasks as Record<string, unknown>[];
    if (Array.isArray(value?.reminders)) return value.reminders as Record<string, unknown>[];
    return value ? [value] : [];
  }

  function itemName(item: Record<string, unknown>, fact: TurnPresentationFact): string {
    const candidates = [
      item?.displayContent, item?.content, item?.title, item?.summary, item?.name, item?.entityName, item?.newName,
      fact?.presentationParams?.newName, fact?.presentationParams?.title, fact?.presentationParams?.content,
      fact?.presentationParams?.target,
    ];
    return candidates.find((value): value is string => typeof value === 'string' && Boolean(value.trim()))?.trim() || '';
  }

  function logicalItems(fact: TurnPresentationFact): Record<string, unknown>[] {
    const domain = getFactDomain(fact);
    const operation = getFactOperation(fact);
    const items = asArray(fact?.presentationData);

    if (domain === 'reminder' && operation === 'create') {
      const mains = items.filter((item) => !item?.isAdvanceNotice);
      return mains.length > 0 ? mains : items;
    }
    return items;
  }

  function compactFallback(fact: TurnPresentationFact): string {
    const text = sanitizeResponseText(fact?.summary || fact?.card || '');
    if (!text) return '';
    return text.split('\n').map((line) => line.trim()).filter(Boolean).slice(-1)[0] || text;
  }

  function compactFactLines(fact: TurnPresentationFact): string[] {
    const domain = getFactDomain(fact);
    const items = logicalItems(fact);
    const lines = [];
    const timezone = fact?.presentationContext?.timezone || 'UTC';
    const language = fact?.presentationContext?.language || 'es';

    for (const item of items) {
      const name = itemName(item, fact);
      if (!name) continue;
      const recurring = Boolean(item?.recurrenceRule || item?.recurrence_rule || record(fact?.presentationData)?.recurring);
      const icon = domain === 'reminder' ? (recurring ? '🔁' : '🔔') : (domain === 'task' ? '☑️' : '•');
      lines.push(`${icon} *${name}*`);

      const sendAt = item?.sendAt || item?.send_at || null;
      const timeDisplay = item?.formattedTime || (sendAt ? formatHumanFriendlyDateTime(sendAt, timezone, language) : '');
      if (timeDisplay && domain === 'reminder') {
        lines.push(`${PRESENTATION_TOKENS.ICONS.SCHEDULE_TIME} ${timeDisplay}`);
      }
      const entName = item?.entityName || item?.projectName || fact?.presentationParams?.entityName || null;
      if (entName && (domain === 'task' || domain === 'project')) {
        lines.push(`📂 ${entName}`);
      }
    }

    if (lines.length > 0) return lines;
    const target = itemName({}, fact);
    if (target) return [`• ${target}`];
    const fallback = compactFallback(fact);
    return fallback ? [`• ${fallback}`] : [];
  }

  function formatTaskCreateBatch(facts: TurnPresentationFact[], language: string): string | null {
    const items = facts.flatMap((fact) => asArray(fact.presentationData));
    if (items.length === 0) return null;
    return formatCanonicalTaskCreate(items, {
      language,
      timezone: facts.map((fact) => fact.presentationContext?.timezone).find(Boolean) || 'UTC',
    });
  }

  function formatHomogeneousGroup(facts: TurnPresentationFact[], language: string, { includeHeader = true }: { includeHeader?: boolean } = {}): string | null {
    if (!facts.length) return '';
    const domain = getFactDomain(facts[0]!);
    const operation = getFactOperation(facts[0]!);

    if (includeHeader && domain === 'reminder' && operation === 'create') {
      return formatCanonicalReminderCreateBatch(
        facts.map((fact) => fact.presentationData),
        { language, timezone: facts.map((fact) => fact.presentationContext?.timezone).find(Boolean) || 'UTC' },
      ) || facts.map(fact => fact.card || fact.summary).filter(Boolean).join('\n\n');
    }

    if (includeHeader && domain === 'reminder' && operation === 'cancel') {
      return formatCanonicalReminderCancelBatch(facts.map((fact) => fact.presentationData), { language });
    }

    if (includeHeader && domain === 'task' && operation === 'create') {
      return formatTaskCreateBatch(facts, language);
    }

    const lang = languageKey(language);
    const [icon, domainLabel] = DOMAIN_LABELS[lang][domain] || DOMAIN_LABELS[lang].other!;
    const opLabel = OPERATION_LABELS[lang][operation] || (language === 'en' ? 'completed' : 'realizadas');
    const lines = facts.flatMap((fact) => compactFactLines(fact));
    // A title and its project/date detail lines describe one affected record.
    const count = facts.reduce((total, fact) => total + (logicalItems(fact).length || 1), 0);
    if (!includeHeader) return lines.join('\n');
    return `${icon} *${domainLabel} · ${count} ${opLabel}*${lines.length ? `\n\n${lines.join('\n')}` : ''}`;
  }

  function isReadFactEmpty(fact: TurnPresentationFact): boolean {
    const data = fact?.presentationData ?? fact?.data;
    if (Array.isArray(data) && data.length === 0) return true;
    const value = record(data);
    if (value) {
      if (Array.isArray(value.events) && value.events.length === 0) return true;
      if (Array.isArray(value.tasks) && value.tasks.length === 0) return true;
      if (Array.isArray(value.reminders) && value.reminders.length === 0) return true;
      if (Array.isArray(value.items) && value.items.length === 0) return true;
    }
    const text = String(fact?.card || fact?.summary || '').toLowerCase();
    return text.includes('no tienes eventos programados')
      || text.includes('no tienes eventos próximos')
      || text.includes('no events scheduled')
      || text.includes('no tienes recordatorios pendientes')
      || text.includes('no tienes tareas pendientes');
  }

  function formatSuccesses(facts: TurnPresentationFact[], language: string): string {
    if (!facts.length) return '';
    const reads = facts.filter(isReadFact);
    const mutations = facts.filter((fact) => !isReadFact(fact));
    const sections = [];

    // When mutations are present in the turn, suppress empty read cards (e.g. empty calendar search)
    // so they do not pollute or prepend the confirmation of the created/updated action.
    const activeReads = mutations.length > 0
      ? reads.filter((fact) => !isReadFactEmpty(fact))
      : reads;

    if (activeReads.length > 0) {
      sections.push(activeReads.map((fact) => fact.card || fact.summary).filter(Boolean).join('\n\n'));
    }
    if (mutations.length > 0) {
      const homogeneous = mutations.every((fact) => groupKey(fact) === groupKey(mutations[0]!));
      sections.push(homogeneous
        ? formatHomogeneousGroup(mutations, language)
        : formatMixedSuccess(mutations, language));
    }
    return sections.filter(Boolean).join('\n\n');
  }

  function formatMixedSuccess(facts: TurnPresentationFact[], language: string): string {
    const groups = new Map<string, TurnPresentationFact[]>();
    for (const fact of facts) {
      const key = groupKey(fact);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(fact);
    }

    const header = language === 'en'
      ? `✅ *${facts.length} actions completed*`
      : `✅ *${facts.length} ${facts.length === 1 ? 'acción realizada' : 'acciones realizadas'}*`;

    const sections = [];
    for (const group of groups.values()) {
      const domain = getFactDomain(group[0]!);
      const operation = getFactOperation(group[0]!);
      const lang = languageKey(language);
      const [icon, domainLabel] = DOMAIN_LABELS[lang][domain] || DOMAIN_LABELS[lang].other!;
      const opLabel = OPERATION_LABELS[lang][operation] || (language === 'en' ? 'completed' : 'realizadas');
      const body = formatHomogeneousGroup(group, language, { includeHeader: false });
      sections.push(`${icon} *${domainLabel} · ${opLabel}*${body ? `\n${body}` : ''}`);
    }
    return `${header}\n\n${sections.join('\n\n')}`;
  }

  function formatFailures(failed: TurnPresentationFact[], language: string): string {
    if (!failed.length) return '';
    const header = language === 'en'
      ? `⚠️ *${failed.length} action${failed.length === 1 ? '' : 's'} could not be completed*`
      : `⚠️ *${failed.length} ${failed.length === 1 ? 'acción no se pudo completar' : 'acciones no se pudieron completar'}*`;
    const lines = failed.map((fact) => `• ${compactFallback(fact) || (language === 'en' ? 'Operation failed.' : 'La operación falló.')}`);
    return `${header}\n${lines.join('\n')}`;
  }

  function formatPartialSuccesses(partial: TurnPresentationFact[], language: string): string {
    if (!partial.length) return '';
    const heading = language === 'en'
      ? `⚠️ *${partial.length} action${partial.length === 1 ? '' : 's'} partially completed*`
      : `⚠️ *${partial.length} ${partial.length === 1 ? 'acción completada parcialmente' : 'acciones completadas parcialmente'}*`;
    const details = partial.map((fact) => sanitizeResponseText(
      isReadFact(fact) ? (fact.card || fact.summary || '') : (fact.summary || fact.card || ''),
    )).filter(Boolean);
    return `${heading}${details.length ? `\n${details.join('\n')}` : ''}`;
  }

  function formatClarifications(clarifications: TurnPresentationFact[], language: string): string {
    if (!clarifications.length) return '';
    const bodies = clarifications
      .map((fact) => sanitizeResponseText(fact?.card || fact?.summary || ''))
      .filter(Boolean);

    const allAreConfirmations = clarifications.every((fact) => (
      fact.errorCode === 'CONFIRMATION_REQUIRED'
      || (typeof fact.card === 'string' && (fact.card.includes('Confirmación necesaria') || fact.card.includes('Confirmation needed')))
    ));

    if (allAreConfirmations) {
      return bodies.join('\n\n');
    }

    const header = language === 'en'
      ? `⚠️ *${clarifications.length} ${clarifications.length === 1 ? 'item needs clarification' : 'items need clarification'}*`
      : `⚠️ *${clarifications.length} ${clarifications.length === 1 ? 'necesita aclaración' : 'necesitan aclaración'}*`;
    return `${header}${bodies.length ? `\n\n${bodies.join('\n\n')}` : ''}`;
  }

  /**
   * Turn-level presentation policy.
   * Tools expose verified facts; this layer decides how the whole user turn is communicated.
   * Domain presenters render entities/collections but never decide turn composition.
   */
  function composeTurnPresentation(facts: MaybeFact[] | null | undefined, language = 'es'): string {
    const validFacts = safeFacts(facts);
    if (validFacts.length === 0) return '';

    const kind = classifyTurnPresentation(validFacts);
    if (kind === PRESENTATION_KINDS.SINGLE) return validFacts[0]!.card || validFacts[0]!.summary || '';

    const succeeded = validFacts.filter((fact) => fact.success);
    const completeSuccesses = succeeded.filter((fact) => fact.complete !== false && fact.outcome !== 'partial_success');
    const partialSuccesses = succeeded.filter((fact) => fact.complete === false || fact.outcome === 'partial_success');
    const clarifications = validFacts.filter((fact) => !fact.success && fact.requiresClarification);
    const hardFailures = validFacts.filter((fact) => !fact.success && !fact.requiresClarification);
    const unknown = hardFailures.filter(fact => fact.outcome === 'unknown');

    if (kind === PRESENTATION_KINDS.CLARIFICATION) {
      return formatClarifications(clarifications, language)
        || validFacts.map((fact) => fact.card || fact.summary).filter(Boolean).join('\n\n');
    }

    return [
      formatSuccesses(completeSuccesses, language),
      formatPartialSuccesses(partialSuccesses, language),
      formatClarifications(clarifications, language),
      formatFailures(hardFailures.filter(fact => fact.outcome !== 'unknown'), language),
      unknown.length ? [(language === 'en' ? '⚠️ *Outcome not confirmed*' : '⚠️ *Resultado sin confirmar*'), ...unknown.map(fact => fact.summary)].join('\n') : '',
    ].filter(Boolean).join('\n\n');
  }

  return { getFactDomain, classifyTurnPresentation, composeTurnPresentation };
}
