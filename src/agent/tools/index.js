import { executeReminderCreate } from './reminder-create.js';
import { executeReminderUpdate } from './reminder-update.js';
import { executeReminderReadTool } from './reminder-read.js';
import { executeSingleReminderCancellation } from './reminder-cancel.js';
import { executeBulkReminderCancellation } from './reminder-bulk-cancel.js';
import { executeReminderAcknowledgement } from './reminder-acknowledge.js';
import { executeTaskCreate } from './task-create.js';
import { executeTaskComplete } from './task-complete.js';
import { executeTaskUpdate } from './task-update.js';
import { executeTaskDelete } from './task-delete.js';
import { executeTaskReadTool } from './task-read.js';
import { executeEntityTool } from './entities.js';
import { executeMemoryTool } from './memory.js';
import { executeSubscriptionTool } from './subscriptions.js';
import { executeCalendarTool } from './calendar.js';
import { executeAdminTool } from './admin.js';
import { executeUnifiedAgendaTool } from './unified-agenda.js';
import { formatErrorCard } from './formatters.js';
import { TOOL_NAMES } from '../contracts/tool-names.js';

export { TOOL_NAMES } from '../contracts/tool-names.js';

function unsupportedDomainAction(domain, action) {
  return {
    success: false,
    action: 'unsupported_action',
    errorCode: 'UNSUPPORTED_ACTION',
    error: `Acción '${action}' no soportada para ${domain}.`,
    rawSummary: `Acción '${action}' no soportada para ${domain}.`,
  };
}

function sanitizeCalendarParams(action, params) {
  if (action !== 'update_event') return params;
  const safe = { ...(params || {}) };
  if (safe.target && safe.summary && String(safe.target).trim() === String(safe.summary).trim()) delete safe.summary;
  return safe;
}

/** Canonical deterministic domain router. Reads and mutations have one explicit execution path each. */
export async function executeTool({
  toolName,
  params = {},
  user = null,
  isPro: requestedIsPro,
  language: requestedLanguage,
  correlationId = null,
  referenceTime = null,
  clarificationResolution = false,
} = {}) {
  const isPro = requestedIsPro ?? (user?.isPro || false);
  const language = requestedLanguage || (user?.locale?.startsWith('en') ? 'en' : 'es');
  const reqId = correlationId ? `[tool req=${correlationId}]` : '[tool]';

  if (!toolName) return { success: false, action: 'unknown', errorCode: 'UNKNOWN_TOOL', error: 'No se especificó una herramienta para ejecutar.', rawSummary: 'No se especificó una herramienta para ejecutar.', confirmation: formatErrorCard('UNKNOWN_TOOL', null, language), complete: false };

  console.log(`${reqId} Executing ${toolName} action=${params?.action || 'default'} for user=${user?.id || user?.phone_number}`);

  try {
    let result = null;
    switch (toolName) {
      case TOOL_NAMES.MANAGE_REMINDER: {
        const action = params?.action || 'create';
        const isBulkCancellation = action === 'cancel' && ['all', 'elapsed'].includes(params?.scope);
        if (action === 'list') result = await executeReminderReadTool({ params, user, language, referenceTime });
        else if (action === 'create') result = await executeReminderCreate({ params, user, isPro, language, referenceTime });
        else if (action === 'update') result = await executeReminderUpdate({ params, user, isPro, language, referenceTime });
        else if (action === 'cancel' && isBulkCancellation) result = await executeBulkReminderCancellation({ params, user, language, referenceTime, clarificationResolution });
        else if (action === 'cancel') result = await executeSingleReminderCancellation({ params, user, language, correlationId });
        else if (action === 'acknowledge') result = await executeReminderAcknowledgement({ params, user, language, correlationId });
        else result = unsupportedDomainAction('manage_reminder', action);
        break;
      }
      case TOOL_NAMES.MANAGE_TASK: {
        const action = params?.action || 'create';
        if (action === 'list') result = await executeTaskReadTool({ params, user, language });
        else if (action === 'create') result = await executeTaskCreate({ params, user, language, referenceTime });
        else if (action === 'complete') result = await executeTaskComplete({ params, user, language });
        else if (action === 'update') result = await executeTaskUpdate({ params, user, language, referenceTime });
        else if (action === 'delete') result = await executeTaskDelete({ params, user, language });
        else result = unsupportedDomainAction('manage_task', action);
        break;
      }
      case TOOL_NAMES.MANAGE_ENTITY: result = await executeEntityTool({ action: params?.action || 'create', params, user, language, clarificationResolution }); break;
      case TOOL_NAMES.MANAGE_MEMORY: result = await executeMemoryTool({ action: params?.action || 'save', params, user, language }); break;
      case TOOL_NAMES.MANAGE_SUBSCRIPTION: result = await executeSubscriptionTool({ action: params?.action || 'get_link', params, user, language }); break;
      case TOOL_NAMES.MANAGE_GOOGLE_CALENDAR: {
        const action = params?.action || 'get_connect_link';
        result = await executeCalendarTool({ action, params: sanitizeCalendarParams(action, params), user, language, referenceTime });
        break;
      }
      case TOOL_NAMES.GET_UNIFIED_AGENDA: result = await executeUnifiedAgendaTool({ action: params?.action || 'get_agenda', params, user, language }); break;
      case TOOL_NAMES.ADMIN_METRICS: result = await executeAdminTool({ action: params?.action || 'get_overview', params, user, language }); break;
      default: result = { success: false, action: 'unknown', errorCode: 'UNKNOWN_TOOL', error: `Herramienta desconocida: ${toolName}` }; break;
    }

    if (!result.success) {
      console.warn(`${reqId} ${toolName} failed with ${result.errorCode}:`, result.error);
      const rawSummary = result.formattedCard || result.rawSummary || result.error || 'Ocurrió un error al ejecutar la herramienta.';
      return { success: false, action: result.action || 'error', errorCode: result.errorCode || 'TOOL_EXECUTION_ERROR', error: result.error, isProFeature: result.isProFeature ?? (result.errorCode === 'PRO_TIER_REQUIRED'), rawSummary, confirmation: result.formattedCard || result.rawSummary || formatErrorCard(result.errorCode, result.error, language), ctaUrl: result.ctaUrl || null, ctaHeader: result.ctaHeader || null, ctaButtonText: result.ctaButtonText || null, data: result.data || null, requiresClarification: Boolean(result.requiresClarification), pendingClarifications: result.pendingClarifications || result.data?.pendingClarifications || [], partialSuccess: Boolean(result.partialSuccess), complete: false };
    }

    const rawSummary = result.confirmation || result.rawSummary || 'Operación completada.';
    return { success: true, action: result.action || params?.action || 'executed', data: result.data, rawSummary, confirmation: rawSummary, ctaUrl: result.ctaUrl || null, ctaHeader: result.ctaHeader || null, ctaButtonText: result.ctaButtonText || null, requiresClarification: Boolean(result.requiresClarification), pendingClarifications: result.pendingClarifications || result.data?.pendingClarifications || [], partialSuccess: Boolean(result.partialSuccess), complete: result.complete !== false };
  } catch (err) {
    console.error(`${reqId} Unexpected exception in ${toolName}:`, err);
    return { success: false, action: 'error', errorCode: 'UNEXPECTED_EXCEPTION', error: err.message, rawSummary: err.message, confirmation: formatErrorCard('UNEXPECTED_EXCEPTION', null, language), complete: false };
  }
}
