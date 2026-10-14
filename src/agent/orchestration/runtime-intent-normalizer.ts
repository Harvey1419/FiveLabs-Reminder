import type { DomainSchedule, NormalizedDomainAction, DomainCallContext } from './domain-call-builder.js';
import type { ContextItem, ContextMemory, ContextResolution } from '../core/context-reference-resolver.js';
export interface RuntimeAction extends NormalizedDomainAction {
  content?: string | null; title?: string | null; target?: string | null;
  query?: string | null; description?: string | null; scope?: string | null;
  filter?: string | null; newName?: string | null; entityName?: string | null;
  recurrence?: string | null; category?: string | null;
  contextRef?: { source: string; position: number } | null;
}
export interface RuntimeNormalizationDependencies {
  getWorkingMemory(user: unknown): ContextMemory | null | undefined;
  resolveContextReference(options: { reference: string; preferredType?: string | undefined; workingMemory: ContextMemory | null | undefined }): ContextResolution;
  parseStructuredOrdinal(reference: unknown): number | null;
  getLocalDateParts(referenceTime?: Date | string | number | undefined, timezone?: string | undefined): { year: number; month: number; day: number };
  shiftZonedCalendarDays(base: Date, days: number, timezone?: string | undefined): Date | null;
  resolveTypedSchedule(schedule: DomainSchedule, context: { referenceTime?: Date | string | number | undefined; timezone?: string | undefined; baseDate?: unknown }): { valid: boolean; date?: Date | null };
  normalizeAgendaScope(value: unknown, fallback: string): string;
  normalizeTaskScope(value: unknown, fallback: string): string;
  buildExplicitTaskDateScope(date: string | null): string | null;
  buildExplicitReminderDateScope(date: string): string | null;
  parseReminderScope(value: unknown, fallback: string): { scope: string; runtimeScope: string };
  sanitizeCalendarQueryAndScope(options: { query: unknown; scope: unknown }): { query: string | null; scope: string | null };
}
/** Validated host actions enter here; canonical admission and execution authority stay separate. */
export function createIntentNormalizer(dependencies: RuntimeNormalizationDependencies) {
  const { getWorkingMemory, resolveContextReference, parseStructuredOrdinal, getLocalDateParts, shiftZonedCalendarDays, resolveTypedSchedule, normalizeAgendaScope, normalizeTaskScope, buildExplicitTaskDateScope, buildExplicitReminderDateScope, parseReminderScope, sanitizeCalendarQueryAndScope } = dependencies;

  function resolveWorkingItem(user: unknown, target: unknown, preferredType?: string): ContextItem | null {
    const reference = String(target || '').trim();
    if (!reference) return null;
    const resolved = resolveContextReference({
      reference,
      preferredType,
      workingMemory: getWorkingMemory(user),
    });
    return resolved.status === 'RESOLVED' ? resolved.item : null;
  }

  function normalizeCalendarYear(action: RuntimeAction, context: DomainCallContext): RuntimeAction {
    if (action.schedule?.kind !== 'calendar_date_time') return action;
    if (Number.isInteger(action.schedule.year)) return action;
    const parts = getLocalDateParts(context.referenceTime, context.timezone);
    return { ...action, schedule: { ...action.schedule, year: parts.year } };
  }

  function localDateFromOffset(referenceTime: Date | string | number | undefined, timezone: string | undefined, dayOffset: number | undefined): string | null {
    const base = referenceTime instanceof Date ? referenceTime : new Date(referenceTime || Date.now());
    const shifted = shiftZonedCalendarDays(base, Number(dayOffset || 0), timezone);
    if (!shifted) return null;
    const parts = getLocalDateParts(shifted, timezone);
    return [parts.year, parts.month, parts.day]
      .map((part, index) => index === 0 ? String(part) : String(part).padStart(2, '0'))
      .join('-');
  }

  function normalizeReadScope(action: RuntimeAction, context: DomainCallContext): RuntimeAction {
    if (action.domain === 'agenda' && action.action === 'read') {
      if (!action.scope) return action;
      return { ...action, scope: normalizeAgendaScope(action.scope, 'all_pending') };
    }

    if (action.domain === 'calendar') {
      if (action.action === 'list' || action.action === 'search') {
        const rawQuery = action.query || action.target || action.description;
        const sanitized = sanitizeCalendarQueryAndScope({ query: rawQuery, scope: action.scope });

        let scope: string | null = sanitized.scope;
        let date: string | null | undefined;
        if (!scope && action.schedule) {
          const schedule = action.schedule;
          if (schedule.kind === 'relative_day_time') {
            if (schedule.dayOffset === 0) scope = 'today';
            else if (schedule.dayOffset === 1) scope = 'tomorrow';
            else if (schedule.dayOffset === 2) scope = 'day_after_tomorrow';
            else if (Number.isInteger(schedule.dayOffset)) {
              date = localDateFromOffset(context.referenceTime, context.timezone, schedule.dayOffset);
              scope = 'explicit_date';
            }
          } else if (schedule.kind === 'weekday_time' && schedule.weekday) {
            scope = schedule.weekday;
          } else if (schedule.kind === 'local_time') {
            scope = 'today';
          } else if (schedule.kind === 'calendar_date_time'
            && Number.isInteger(schedule.month) && Number.isInteger(schedule.day)) {
            const year = Number.isInteger(schedule.year)
              ? schedule.year
              : getLocalDateParts(context.referenceTime, context.timezone).year;
            date = [year, schedule.month, schedule.day]
              .map((part, index) => index === 0 ? String(part) : String(part).padStart(2, '0'))
              .join('-');
            scope = 'explicit_date';
          }
        }

        const normalizedScope = scope ? normalizeAgendaScope(scope, 'upcoming') : (action.scope ? normalizeAgendaScope(action.scope, 'upcoming') : undefined);

        if (action.action === 'search') {
          if (!sanitized.query) {
            const { query: _q, target: _t, ...rest } = action;
            return {
              ...rest,
              ...(date ? { date } : {}),
              action: 'list',
              scope: normalizedScope || 'today',
            };
          }
          return {
            ...action,
            query: sanitized.query,
            ...(date ? { date } : {}),
            ...(normalizedScope ? { scope: normalizedScope } : {}),
          };
        }

        const { query: _q, ...rest } = action;
        return {
          ...rest,
          ...(date ? { date } : {}),
          ...(normalizedScope ? { scope: normalizedScope } : {}),
          ...(sanitized.query ? { query: sanitized.query } : {}),
        };
      }
    }

    if (action.domain === 'reminder' && action.action === 'list') {
      let raw: string | null | undefined = action.filter || action.scope;
      if (!raw && action.schedule) {
        const schedule = action.schedule;
        let date: string | null = null;
        if (schedule.kind === 'calendar_date_time' && Number.isInteger(schedule.month) && Number.isInteger(schedule.day)) {
          const year = Number.isInteger(schedule.year) ? schedule.year : getLocalDateParts(context.referenceTime, context.timezone).year;
          date = [year, schedule.month, schedule.day].map((part, index) => index === 0 ? String(part) : String(part).padStart(2, '0')).join('-');
        } else if (schedule.kind === 'relative_day_time' && Number.isInteger(schedule.dayOffset)) {
          date = localDateFromOffset(context.referenceTime, context.timezone, schedule.dayOffset);
        }
        raw = date ? buildExplicitReminderDateScope(date) : undefined;
      }
      if (raw) {
        const parsed = parseReminderScope(raw, 'upcoming');
        return {
          ...action,
          filter: parsed.scope,
          scope: parsed.runtimeScope,
        };
      }
      return action;
    }

    if (action.domain !== 'task' || action.action !== 'list') return action;

    const query = action.query || (action.entityName && action.target ? action.target : null);

    const base = {
      ...action,
      ...(query ? { query: String(query).trim() } : {}),
    };
    if (base.scope) return { ...base, scope: normalizeTaskScope(base.scope, 'all_pending') };

    const schedule = base.schedule;
    if (!schedule) return { ...base, scope: 'all_pending' };

    if (schedule.kind === 'relative_day_time') {
      if (schedule.dayOffset === 0) return { ...base, scope: 'today' };
      if (schedule.dayOffset === 1) return { ...base, scope: 'tomorrow' };
      if (schedule.dayOffset === 2) return { ...base, scope: 'day_after_tomorrow' };
      const explicit = buildExplicitTaskDateScope(localDateFromOffset(context.referenceTime, context.timezone, schedule.dayOffset));
      return explicit ? { ...base, scope: explicit } : { ...base, scope: 'upcoming' };
    }

    if (schedule.kind === 'weekday_time' && schedule.weekday) {
      return { ...base, scope: normalizeTaskScope(schedule.weekday, 'upcoming') };
    }

    if (schedule.kind === 'calendar_date_time') {
      const year = schedule.year;
      const month = schedule.month;
      const day = schedule.day;
      if (Number.isInteger(year) && Number.isInteger(month) && Number.isInteger(day)) {
        const localDate = [year, month, day]
          .map((part, index) => index === 0 ? String(part) : String(part).padStart(2, '0'))
          .join('-');
        const explicit = buildExplicitTaskDateScope(localDate);
        return explicit ? { ...base, scope: explicit } : { ...base, scope: 'upcoming' };
      }
    }

    if (schedule.kind === 'local_time') return { ...base, scope: 'today' };
    return { ...base, scope: 'upcoming' };
  }

  /** Natural rename/edit requests map semantic newName to the domain field. */
  function normalizeUpdateFields(action: RuntimeAction): RuntimeAction {
    if (action.action !== 'update' || !action.newName) return action;

    if (action.domain === 'reminder' && !action.content && !action.title) {
      return { ...action, content: action.newName };
    }
    if (action.domain === 'task' && !action.title && !action.content) {
      return { ...action, title: action.newName };
    }
    if (action.domain === 'calendar' && !action.title && !action.content) {
      return { ...action, title: action.newName };
    }
    return action;
  }

  /**
   * A recurring reminder represents the next occurrence of a routine, not an
   * already elapsed wall-clock occurrence. This invariant applies both when a
   * routine is created and when an existing recurring reminder is edited.
   */
  function normalizeRecurringReminder(action: RuntimeAction, context: DomainCallContext): RuntimeAction {
    if (action.domain !== 'reminder' || !['create', 'update'].includes(action.action || '')) return action;

    const workingItem = action.action === 'update' && action.target
      ? resolveWorkingItem(context.user, action.target, 'reminder')
      : null;
    const inheritedRecurrence = workingItem?.raw?.recurrence_rule
      || workingItem?.raw?.recurrenceRule
      || null;
    const recurrence = action.clearFields?.includes('recurrence') ? null : action.recurrence || inheritedRecurrence;

    if (recurrence !== 'daily' || !action.schedule) return action;
    if (!['local_time', 'relative_day_time'].includes(action.schedule.kind || '')) return action;
    if (action.schedule.kind === 'relative_day_time' && (action.schedule.dayOffset ?? 0) !== 0) return action;

    const resolved = resolveTypedSchedule(action.schedule, {
      referenceTime: context.referenceTime,
      timezone: context.timezone,
      baseDate: workingItem?.raw?.sendAt || workingItem?.raw?.send_at || workingItem?.time || null,
    });
    const reference = context.referenceTime instanceof Date ? context.referenceTime : new Date(context.referenceTime || Date.now());
    if (!resolved.valid || !resolved.date || resolved.date.getTime() > reference.getTime()) return action;

    return {
      ...action,
      schedule: {
        ...action.schedule,
        kind: 'relative_day_time',
        dayOffset: 1,
      },
    };
  }

  /**
   * Bridges conversational references (e.g. "recuérdame la 1 a las 5pm") into
   * concrete reminder content using items currently active in working memory.
   */
  function normalizeReminderCreateFromWorkingTarget(action: RuntimeAction, context: DomainCallContext): RuntimeAction {
    if (action.domain !== 'reminder' || action.action !== 'create') return action;

    const candidateRef = action.target
      || (action.content && parseStructuredOrdinal(action.content) !== null ? action.content : null)
      || (action.title && parseStructuredOrdinal(action.title) !== null ? action.title : null)
      || (action.content && /^(?:hacer\s+)?(?:la\s+|el\s+)?(?:tarea\s+|item\s+|pendiente\s+)?#?(\d+)$/i.test(action.content.trim()) ? action.content.trim() : null);

    if (!candidateRef) return action;

    const hasSubstantiveContent = action.content
      && parseStructuredOrdinal(action.content) === null
      && !/^(?:hacer\s+)?(?:la\s+|el\s+)?(?:tarea\s+|item\s+|pendiente\s+)?#?(\d+)$/i.test(action.content.trim());

    if (hasSubstantiveContent && !action.target) return action;

    const workingItem = resolveWorkingItem(context?.user, candidateRef, 'task')
      || resolveWorkingItem(context?.user, candidateRef);

    if (workingItem) {
      const title = workingItem.title || workingItem.summary || (typeof workingItem.content === 'string' ? workingItem.content : undefined);
      if (title) {
        const updated = { ...action, content: title };
        delete updated.target;
        return updated;
      }
    }

    return action;
  }

  /**
   * Structural bulk entity deletion normalizer:
   * Enforces scope="all", category="project" fallback, and preserveNames array
   * ONLY when scope="all" or preserveNames is already structurally provided.
   * Node never infers bulk operations from natural-language target strings.
   */
  function normalizeEntityDelete(action: RuntimeAction): RuntimeAction {
    if (action.domain !== 'entity' || action.action !== 'delete') return action;

    if (action.scope === 'all' || Array.isArray(action.preserveNames)) {
      return {
        ...action,
        scope: 'all',
        category: action.category || 'project',
        preserveNames: Array.isArray(action.preserveNames) ? action.preserveNames : [],
      };
    }

    return action;
  }

  function normalizeProjectOperations(action: RuntimeAction): RuntimeAction {
    if (action.domain === 'project' && action.action === 'delete') {
      if (action.scope === 'all' || Array.isArray(action.preserveNames)) {
        return {
          ...action,
          scope: 'all',
          preserveNames: Array.isArray(action.preserveNames) ? action.preserveNames : [],
        };
      }
    }
    return action;
  }

  function normalizeTaskEntityName(action: RuntimeAction, context: DomainCallContext): RuntimeAction {
    if (action.domain !== 'task' || !action.entityName) return action;
    const target = String(action.entityName).trim();
    const workingItem = resolveWorkingItem(context?.user, target, 'project');
    if (workingItem) {
      const resolvedName = workingItem.title || workingItem.name || workingItem.summary;
      if (resolvedName) {
        return { ...action, entityName: resolvedName };
      }
    }
    return action;
  }

  /**
   * Add deterministic runtime context only. This layer never changes semantic
   * domain/action and never turns identity/context into patch content.
   */
  function bindTypedContextReference(action: RuntimeAction, context: DomainCallContext): RuntimeAction {
    if (!action.contextRef) return action;
    const expectedTypes: Record<string, string> = { reminder: 'reminder', task: 'task', calendar: 'calendar_event' };
    const expectedType = expectedTypes[action.domain || ''];
    const selectedReference = action.contextRef;
    const item = getWorkingMemory(context.user)?.items?.find(item => item.position === selectedReference.position);
    const compatible = item?.type === expectedType;
    if (action.contextRef.source !== 'working_memory' || !expectedType || !compatible || !item?.internalId || ['deleted', 'cancelled'].includes(typeof item.raw?.status === 'string' ? item.raw.status : '')) {
      return { ...action, _referenceError: true };
    }
    // Freeze the selected identity before any sibling action can replace working memory.
    const { contextRef, ...bound } = action;
    return { ...bound, target: item.internalId };
  }

  function normalizeTurnActionForRuntime(original: unknown, context: DomainCallContext = {}): RuntimeAction {
    let action = bindTypedContextReference({ ...original as RuntimeAction }, context);
    action = normalizeCalendarYear(action, context);
    action = normalizeReadScope(action, context);
    action = normalizeUpdateFields(action);
    action = normalizeRecurringReminder(action, context);
    action = normalizeReminderCreateFromWorkingTarget(action, context);
    action = normalizeEntityDelete(action);
    action = normalizeProjectOperations(action);
    action = normalizeTaskEntityName(action, context);
    return action;
  }

  function normalizeTurnIntentForRuntime<T extends { actions: unknown[] }>(intent: T, context?: DomainCallContext): Omit<T, 'actions'> & { actions: RuntimeAction[] };
  function normalizeTurnIntentForRuntime(intent: unknown, context?: DomainCallContext): unknown;
  function normalizeTurnIntentForRuntime(intent: unknown, context: DomainCallContext = {}): unknown {
    if (!intent || typeof intent !== 'object' || !('actions' in intent) || !Array.isArray(intent.actions)) return intent;
    return { ...intent, actions: intent.actions.map((action) => normalizeTurnActionForRuntime(action, context)) };
  }
  return { normalizeTurnActionForRuntime, normalizeTurnIntentForRuntime };
}
