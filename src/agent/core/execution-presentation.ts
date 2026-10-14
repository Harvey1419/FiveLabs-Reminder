import { TOOL_NAMES } from '../contracts/tool-names-contract.js';
export const TASK_CARD_COVERAGE = Symbol('local task card coverage');
export interface PresentationResult extends Record<string, unknown> {
  success?: unknown; outcome?: string; partialSuccess?: boolean; complete?: boolean;
  action?: string | null; errorCode?: string | null; requiresClarification?: unknown;
  data?: (Record<string, unknown> | Record<string, unknown>[]) | null;
}
export interface PresentationContext extends Record<string, unknown> {
  language: string; timezone: string; locale: string;
  onTaskRendered?: ((row: Record<string, unknown>, fields: readonly string[]) => void) | undefined;
}
export interface TaskCardCoverage { readonly itemId: string; readonly fields: readonly string[] }
export interface ExecutionPresentationFact extends Record<string, unknown> {
  callId: string | null; tool: string; action: unknown; requestedAction: unknown;
  success: boolean; complete: boolean; outcome: 'unknown' | 'success' | 'partial_success' | 'failure';
  summary: string; card: string; presentationContext: PresentationContext;
  readonly [TASK_CARD_COVERAGE]: readonly TaskCardCoverage[];
}
export interface ExecutionFactOptions {
  toolName: string; params?: Record<string, unknown> | null; result?: PresentationResult | null;
  callId?: string | null; language?: string; timezone?: string | null;
}
type Formatter = (data: unknown, options: unknown, context?: PresentationContext) => string | null;
export interface ExecutionPresentationDependencies {
  sanitizeResponseText(value: unknown): string;
  composeTurnPresentation(facts: ExecutionPresentationFact[], language: string): string;
  formatCanonicalAgenda: Formatter;
  formatCanonicalTaskList: Formatter;
  formatCanonicalTaskComplete: Formatter;
  formatCanonicalTaskCreate: Formatter;
  formatCanonicalTaskDelete: Formatter;
  formatCanonicalTaskUpdate: Formatter;
  formatCanonicalEntityCreate: Formatter;
  formatCanonicalEntityDeduplicate: Formatter;
  formatCanonicalEntityDelete: Formatter;
  formatCanonicalEntityList: Formatter;
  formatCanonicalEntityMerge: Formatter;
  formatCanonicalEntityRename: Formatter;
  formatCanonicalReminderAcknowledge: Formatter;
  formatCanonicalReminderCancel: Formatter;
  formatCanonicalReminderCreate: Formatter;
  formatCanonicalReminderList: Formatter;
  formatCanonicalReminderUpdate: Formatter;
}
/** Named metadata preserves legacy reads on object or collection payloads; rows stay opaque. */
function presentationMetadata(data: PresentationResult['data']): (Record<string, unknown> & { timezone?: string; locale?: string }) | null | undefined {
  return data as (Record<string, unknown> & { timezone?: string; locale?: string }) | null | undefined;
}
function attachTaskCoverage(target: object, value: readonly TaskCardCoverage[]): asserts target is object & { readonly [TASK_CARD_COVERAGE]: readonly TaskCardCoverage[] } {
  Object.defineProperty(target, TASK_CARD_COVERAGE, { value });
}
/** Tool observations drive local view facts; execution/ownership certification remains upstream. */
export function createExecutionPresentation(dependencies: ExecutionPresentationDependencies) {
  const { sanitizeResponseText, composeTurnPresentation, formatCanonicalAgenda, formatCanonicalTaskList, formatCanonicalTaskComplete, formatCanonicalTaskCreate, formatCanonicalTaskDelete, formatCanonicalTaskUpdate, formatCanonicalEntityCreate, formatCanonicalEntityDeduplicate, formatCanonicalEntityDelete, formatCanonicalEntityList, formatCanonicalEntityMerge, formatCanonicalEntityRename, formatCanonicalReminderAcknowledge, formatCanonicalReminderCancel, formatCanonicalReminderCreate, formatCanonicalReminderList, formatCanonicalReminderUpdate } = dependencies;

  function getSafeSummary(result: PresentationResult | null | undefined, language: string): string {
    const fallback = result?.success
      ? (language === 'en' ? 'The operation completed successfully.' : 'La operación se completó correctamente.')
      : (language === 'en' ? 'The operation could not be completed.' : 'No se pudo completar la operación.');
    return sanitizeResponseText(
      result?.confirmation || result?.formattedCard || result?.rawSummary || result?.error || fallback
    );
  }

  function getPresentationContext(result: PresentationResult | null | undefined, language: string, timezone: string | null | undefined): PresentationContext {
    return {
      language,
      timezone: timezone || presentationMetadata(result?.data)?.timezone || 'UTC',
      locale: presentationMetadata(result?.data)?.locale || (language === 'en' ? 'en-US' : 'es-CO'),
    };
  }



  function getCanonicalCard(toolName: string, params: Record<string, unknown> | null | undefined, result: PresentationResult | null | undefined, language: string, timezone: string | null | undefined, onTaskRendered: PresentationContext['onTaskRendered']): string | null {
    if (!result?.success) return null;
    const presentation = { ...getPresentationContext(result, language, timezone), onTaskRendered };

    if (toolName === TOOL_NAMES.MANAGE_SUBSCRIPTION) {
      const data = presentationMetadata(result?.data);
      if (Array.isArray(data?.benefits) && typeof data.hasProAccess === 'boolean') {
        const access = data.hasProAccess
          ? (language === 'en' ? 'You already have Reminder Pro access. No payment is needed.' : 'Ya tienes acceso a Reminder Pro. No necesitas realizar otro pago.')
          : 'Reminder Pro';
        return [access, ...data.benefits.map(benefit => `• ${benefit}`)].join('\n');
      }
      if (result.action === 'subscription_info' && data && Object.hasOwn(data, 'paymentOutcome')) {
        return language === 'en'
          ? `Payment provider: ${data.provider || 'unknown'}. Price, discounts and payment methods: unknown. Checkout confirmation, charge outcome, payment outcome and subscription status: unknown. Do not retry manually until the outcome is resolved.`
          : `Proveedor de pago: ${data.provider || 'desconocido'}. Precio, descuentos y métodos de pago: desconocidos. La confirmación del checkout, cualquier cargo, el resultado del pago y el estado de suscripción son desconocidos. No reintentes manualmente hasta resolver el resultado.`;
      }
    }

    if (toolName === TOOL_NAMES.GET_UNIFIED_AGENDA && result?.data) {
      return formatCanonicalAgenda(result.data, presentation);
    }

    if (toolName === TOOL_NAMES.MANAGE_TASK) {
      if (params?.action === 'list' && result?.data) return formatCanonicalTaskList(result.data, presentation);
      if (params?.action === 'create' && result?.data) return formatCanonicalTaskCreate(result.data, presentation);
      if (params?.action === 'complete' && result?.data) return formatCanonicalTaskComplete(result.data, presentation);
      if (params?.action === 'update' && result?.data) return formatCanonicalTaskUpdate(result.data, presentation);
      if (params?.action === 'delete') return formatCanonicalTaskDelete(result?.data, presentation);
    }

    if (toolName === TOOL_NAMES.MANAGE_PROJECT) {
      if (['create', 'upsert'].includes(typeof params?.action === 'string' ? params.action : '') && result?.data) return formatCanonicalEntityCreate({ ...result.data, category: presentationMetadata(result.data)?.category || 'project' }, presentation);
      if (params?.action === 'rename') return formatCanonicalEntityRename(result?.data, params, presentation);
      if (params?.action === 'list') return formatCanonicalEntityList(result?.data, { ...presentation, category: 'project' });
      if (params?.action === 'delete') return formatCanonicalEntityDelete(result?.data, presentation);
    }

    if (toolName === TOOL_NAMES.MANAGE_ENTITY) {
      if (['create', 'upsert'].includes(typeof params?.action === 'string' ? params.action : '') && result?.data) return formatCanonicalEntityCreate(result.data, presentation);
      if (params?.action === 'rename') return formatCanonicalEntityRename(result?.data, params, presentation);
      if (params?.action === 'merge') return formatCanonicalEntityMerge(result?.data, params, presentation);
      if (params?.action === 'deduplicate') return formatCanonicalEntityDeduplicate(result?.data, presentation);
      if (params?.action === 'list') return formatCanonicalEntityList(result?.data, { ...presentation, category: params?.category || null });
      if (params?.action === 'delete') return formatCanonicalEntityDelete(result?.data, presentation);
    }

    if (toolName === TOOL_NAMES.MANAGE_REMINDER && params?.action === 'create' && result?.data) {
      return formatCanonicalReminderCreate(result.data, presentation);
    }

    if (toolName === TOOL_NAMES.MANAGE_REMINDER && params?.action === 'list' && result?.data) {
      return formatCanonicalReminderList(result.data, presentation);
    }

    if (toolName === TOOL_NAMES.MANAGE_REMINDER && params?.action === 'cancel' && result?.data) {
      return formatCanonicalReminderCancel(result.data, presentation);
    }

    if (toolName === TOOL_NAMES.MANAGE_REMINDER && params?.action === 'update' && result?.data) {
      return formatCanonicalReminderUpdate(result.data, presentation);
    }

    if (toolName === TOOL_NAMES.MANAGE_REMINDER && params?.action === 'acknowledge' && result?.data) {
      return formatCanonicalReminderAcknowledge(result.data, presentation);
    }

    return null;
  }

  function getSafeCard(toolName: string, params: Record<string, unknown> | null | undefined, result: PresentationResult | null | undefined, language: string, timezone: string | null | undefined, onTaskRendered: PresentationContext['onTaskRendered']): string {
    const canonical = getCanonicalCard(toolName, params, result, language, timezone, onTaskRendered);
    return sanitizeResponseText(
      canonical || result?.formattedCard || result?.confirmation || result?.rawSummary || getSafeSummary(result, language)
    );
  }

  function createExecutionFact({ toolName, params, result, callId = null, language = 'es', timezone = null }: ExecutionFactOptions): ExecutionPresentationFact {
    const unknown = result?.outcome === 'unknown';
    if (unknown) {
      result = { ...result, success: false, formattedCard: null, confirmation: null,
        rawSummary: language === 'en'
          ? 'I could not confirm the outcome of this action. I stopped the remaining actions and will not repeat it without checking.'
          : 'No pude confirmar el resultado de esta acción. Detuve las acciones restantes y no la repetiré sin verificarlo.' };
    }
    const success = Boolean(result?.success) && !unknown;
    const complete = success && result?.partialSuccess !== true && result?.complete !== false;
    const coverage: { itemId: string; fields: string[] }[] = [];
    const seen = new Set<string>(), duplicates = new Set<string>();
    let renderedRows = 0;
    const card = getSafeCard(toolName, params, result, language, timezone, (row, fields) => {
      if (++renderedRows > 100) return;
      if (!complete || typeof row?.id !== 'string' || !row.id || row.id.length > 80) return;
      if (seen.has(row.id)) duplicates.add(row.id);
      seen.add(row.id);
      if (coverage.length < 100) coverage.push({ itemId: row.id, fields: [...fields] });
    });
    const fact = {
      callId,
      tool: toolName,
      action: result?.action || params?.action || 'executed',
      requestedAction: params?.action || null,
      success,
      complete,
      outcome: (unknown ? 'unknown' : success ? (complete ? 'success' : 'partial_success') : 'failure') as ExecutionPresentationFact['outcome'],
      errorCode: success ? null : (result?.errorCode || 'TOOL_EXECUTION_ERROR'),
      requiresClarification: Boolean(result?.requiresClarification),
      summary: getSafeSummary(result, language),
      card,
      ctaUrl: result?.ctaUrl || null,
      ctaHeader: result?.ctaHeader || null,
      ctaButtonText: result?.ctaButtonText || null,
      flow: result?.flow || null,
      presentationData: result?.data ?? null,
      presentationParams: params && typeof params === 'object' ? { ...params } : {},
      presentationContext: getPresentationContext(result, language, timezone),
    };
    // Non-enumerable local view metadata never enters JSON/history/provider payloads.
    attachTaskCoverage(fact, Object.freeze((renderedRows > 100 ? [] : coverage)
      .filter(item => !duplicates.has(item.itemId))
      .map(item => Object.freeze({ ...item, fields: Object.freeze(item.fields) }))));
    return Object.freeze(fact);
  }

  /**
   * Backend-owned facts are composed once at the turn boundary. Individual tools
   * expose verified data; turn-level UX belongs to the central Presentation Policy.
   */
  function composeExecutionReply(facts: (ExecutionPresentationFact | null | undefined | false)[] | null | undefined, language = 'es', options: { framing?: unknown } = {}): string {
    const safeFacts = (facts || []).filter((fact): fact is ExecutionPresentationFact => Boolean(fact));
    if (safeFacts.length === 0) return '';

    const framing = options?.framing && typeof options.framing === 'object'
      ? options.framing as Record<string, unknown>
      : null;
    const before = typeof framing?.before === 'string' ? sanitizeResponseText(framing.before) : '';
    const after = typeof framing?.after === 'string' ? sanitizeResponseText(framing.after) : '';
    const body = sanitizeResponseText(composeTurnPresentation(safeFacts, language));

    return [before, body, after].filter(Boolean).join('\n\n');
  }

  return { createExecutionFact, composeExecutionReply };
}
