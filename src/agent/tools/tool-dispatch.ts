import type { ToolHandler, ToolOptions, ToolResult, ToolParams, ToolUser } from './remaining-tool-ports.js';

export interface Dependencies {
  executeReminderCreate: ToolHandler;
  executeReminderUpdate: ToolHandler;
  executeReminderReadTool: ToolHandler;
  executeSingleReminderCancellation: ToolHandler;
  executeBulkReminderCancellation: ToolHandler;
  executeReminderAcknowledgement: ToolHandler;
  executeTaskCreate: ToolHandler;
  executeTaskComplete: ToolHandler;
  executeTaskUpdate: ToolHandler;
  executeTaskDelete: ToolHandler;
  executeTaskReadTool: ToolHandler;
  executeEntityTool: ToolHandler;
  executeProjectTool: ToolHandler;
  executeMemoryTool: ToolHandler;
  executeSubscriptionTool: ToolHandler;
  executeCalendarTool: ToolHandler;
  executeAdminTool: ToolHandler;
  executeUnifiedAgendaTool: ToolHandler;
  formatErrorCard: typeof import('./formatters.js').formatErrorCard;
  TOOL_NAMES: typeof import('../contracts/tool-names.js').TOOL_NAMES;
  assertTurnLease: typeof import('../core/turn-lease.js').assertTurnLease;
  logger: Pick<Console, 'log' | 'warn' | 'error'>;
}

export function createToolDispatch(dependencies: Dependencies) {
const { executeReminderCreate, executeReminderUpdate, executeReminderReadTool, executeSingleReminderCancellation, executeBulkReminderCancellation, executeReminderAcknowledgement, executeTaskCreate, executeTaskComplete, executeTaskUpdate, executeTaskDelete, executeTaskReadTool, executeEntityTool, executeProjectTool, executeMemoryTool, executeSubscriptionTool, executeCalendarTool, executeAdminTool, executeUnifiedAgendaTool, formatErrorCard, assertTurnLease, logger } = dependencies;

function unsupportedDomainAction(domain: string, action: string) {
  return {
    success: false,
    action: 'unsupported_action',
    errorCode: 'UNSUPPORTED_ACTION',
    error: `Acción '${action}' no soportada para ${domain}.`,
    rawSummary: `Acción '${action}' no soportada para ${domain}.`,
  };
}

function sanitizeCalendarParams(action: string, params: ToolParams) {
  if (action !== 'update_event') return params;
  const safe = { ...(params || {}) };
  if (safe.target && safe.summary && String(safe.target).trim() === String(safe.summary).trim()) delete safe.summary;
  return safe;
}

/** Canonical deterministic domain router. Reads and mutations have one explicit execution path each. */
async function executeTool(firstArg?: string | ToolOptions | null, secondArg?: ToolParams, thirdArg?: ToolUser | null) {
  const options: ToolOptions = (typeof firstArg === 'string')
    ? { toolName: firstArg, params: secondArg || {}, user: thirdArg || null }
    : (firstArg || {});

  const {
    toolName,
    params = {},
    user = null,
    isPro: requestedIsPro,
    language: requestedLanguage,
    correlationId = null,
    referenceTime = null,
    clarificationResolution = false,
    memoryTurn = null,
  } = options;

  const isPro = requestedIsPro ?? (user?.isPro || false);
  const language = requestedLanguage || (user?.locale?.startsWith('en') ? 'en' : 'es');
  const reqId = correlationId ? `[tool req=${correlationId}]` : '[tool]';

  await assertTurnLease();

  if (!toolName) return { success: false, action: 'unknown', errorCode: 'UNKNOWN_TOOL', error: 'No se especificó una herramienta para ejecutar.', rawSummary: 'No se especificó una herramienta para ejecutar.', confirmation: formatErrorCard('UNKNOWN_TOOL', null, language), complete: false };

  logger.log(`${reqId} Executing ${toolName} action=${params?.action || 'default'} for user=${user?.id || user?.phone_number}`);

  try {
    let result: ToolResult | null = null;
    switch (toolName) {
      case dependencies.TOOL_NAMES.MANAGE_REMINDER: {
        const action = params?.action || 'create';
        const isBulkCancellation = action === 'cancel' && ['all', 'elapsed'].includes(params?.scope as string);
        if (action === 'list') result = await executeReminderReadTool({ params, user, language, referenceTime });
        else if (action === 'create') result = await executeReminderCreate({ params, user, isPro, language, referenceTime });
        else if (action === 'update') result = await executeReminderUpdate({ params, user, isPro, language, referenceTime });
        else if (action === 'cancel' && isBulkCancellation) result = await executeBulkReminderCancellation({ params, user, language, referenceTime, clarificationResolution });
        else if (action === 'cancel') result = await executeSingleReminderCancellation({ params, user, language, correlationId });
        else if (action === 'acknowledge') result = await executeReminderAcknowledgement({ params, user, language, correlationId });
        else result = unsupportedDomainAction('manage_reminder', action);
        break;
      }
      case dependencies.TOOL_NAMES.MANAGE_TASK: {
        const action = params?.action || 'create';
        if (action === 'list') result = await executeTaskReadTool({ params, user, language, referenceTime });
        else if (action === 'create') result = await executeTaskCreate({ params, user, language, referenceTime });
        else if (action === 'complete') result = await executeTaskComplete({ params, user, language });
        else if (action === 'update') result = await executeTaskUpdate({ params, user, language, referenceTime });
        else if (action === 'delete') result = await executeTaskDelete({ params, user, language });
        else result = unsupportedDomainAction('manage_task', action);
        break;
      }
      case dependencies.TOOL_NAMES.MANAGE_PROJECT: result = await executeProjectTool({ action: params?.action || 'create', params, user, language, clarificationResolution }); break;
      case dependencies.TOOL_NAMES.MANAGE_ENTITY: result = await executeEntityTool({ action: params?.action || 'create', params, user, language, clarificationResolution }); break;
      case dependencies.TOOL_NAMES.MANAGE_MEMORY: result = await executeMemoryTool({ action: params?.action || 'save', params, user, language, correlationId, memoryTurn }); break;
      case dependencies.TOOL_NAMES.MANAGE_SUBSCRIPTION: result = await executeSubscriptionTool({ action: params?.action || 'get_link', params, user, language }); break;
      case dependencies.TOOL_NAMES.MANAGE_GOOGLE_CALENDAR: {
        const action = params?.action || 'get_connect_link';
        result = await executeCalendarTool({ action, params: sanitizeCalendarParams(action, params), user, language, referenceTime });
        break;
      }
      case dependencies.TOOL_NAMES.GET_UNIFIED_AGENDA: result = await executeUnifiedAgendaTool({ action: params?.action || 'get_agenda', params, user, language }); break;
      case dependencies.TOOL_NAMES.ADMIN_METRICS: result = await executeAdminTool({ action: params?.action || 'get_overview', params, user, language }); break;
      default: result = { success: false, action: 'unknown', errorCode: 'UNKNOWN_TOOL', error: `Herramienta desconocida: ${toolName}` }; break;
    }

    if (!result || typeof result.success !== 'boolean') throw new Error('Unobservable tool result');
    if (['delete', 'cancel', 'forget', 'delete_event'].includes(params.action as string)) {
      // Log observed tool receipts, including partial/failed outcomes, never just the requested target.
      logger.log(`[deletion-audit] ${JSON.stringify({ correlationId, userId: user?.id, tool: toolName,
        requestedAction: params.action, action: result.action, success: result.success,
        outcome: result.outcome || (result.success ? (result.partialSuccess ? 'partial_success' : 'success') : 'failure'),
        errorCode: result.errorCode || null, affected: result.success || (result.data as { receipts?: unknown } | null)?.receipts ? result.data : null })}`);
    }
    if (result.outcome === 'unknown') {
      return { ...result, success: false, complete: false, outcome: 'unknown' };
    }
    if (!result.success) {
      logger.warn(`${reqId} ${toolName} failed with ${result.errorCode}:`, result.error);
      const rawSummary = result.formattedCard || result.rawSummary || result.error || 'Ocurrió un error al ejecutar la herramienta.';
      return { success: false, action: result.action || 'error', errorCode: result.errorCode || 'TOOL_EXECUTION_ERROR', error: result.error, isProFeature: result.isProFeature ?? (result.errorCode === 'PRO_TIER_REQUIRED'), rawSummary, confirmation: result.formattedCard || result.rawSummary || formatErrorCard(result.errorCode as string, result.error, language), ctaUrl: result.ctaUrl || null, ctaHeader: result.ctaHeader || null, ctaButtonText: result.ctaButtonText || null, data: result.data || null, requiresClarification: Boolean(result.requiresClarification), pendingClarifications: result.pendingClarifications || (result.data as { pendingClarifications?: unknown } | null)?.pendingClarifications || [], partialSuccess: Boolean(result.partialSuccess), complete: false };
    }

    const rawSummary = result.confirmation || result.rawSummary || (language === 'en' ? 'Operation completed.' : 'Operación completada.');
    return { success: true, action: result.action || params?.action || 'executed', data: result.data, rawSummary, confirmation: rawSummary, ctaUrl: result.ctaUrl || null, ctaHeader: result.ctaHeader || null, ctaButtonText: result.ctaButtonText || null, flow: result.flow || null, requiresClarification: Boolean(result.requiresClarification), pendingClarifications: result.pendingClarifications || (result.data as { pendingClarifications?: unknown } | null)?.pendingClarifications || [], partialSuccess: Boolean(result.partialSuccess), complete: result.complete !== false };
  } catch (err) {
    logger.error(`${reqId} Unexpected exception in ${toolName}:`, err);
    const readOnly = ['list', 'read', 'search', 'get_agenda', 'get_overview', 'status', 'metrics', 'next'].includes(params.action as string);
    const summary = readOnly
      ? (language === 'en' ? 'I could not retrieve that information.' : 'No pude consultar esa información.')
      : (language === 'en' ? 'I could not confirm the outcome of this action. I will not repeat it automatically.' : 'No pude confirmar el resultado de esta acción. No la repetiré automáticamente.');
    return { success: false, action: 'error', ...(readOnly ? {} : { outcome: 'unknown' }), errorCode: readOnly ? 'UNEXPECTED_EXCEPTION' : 'WRITE_OUTCOME_UNKNOWN', error: summary, rawSummary: summary, confirmation: summary, complete: false };
  }
}

return { executeTool };
}
