import { executeReminderTool } from './reminders.js';
import { executeReminderReadTool } from './reminder-read.js';
import { executeSingleReminderCancellation } from './reminder-cancel.js';
import { executeTaskTool } from './tasks.js';
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

function sanitizeCalendarParams(action, params) {
  if (action !== 'update_event') return params;
  const safe = { ...(params || {}) };
  // target identifies the event; it is never event content. The old executor
  // may carry target into summary as a compatibility fallback. Strip only that
  // identity echo while preserving an explicit rename where summary differs.
  if (safe.target && safe.summary && String(safe.target).trim() === String(safe.summary).trim()) {
    delete safe.summary;
  }
  return safe;
}

/**
 * Master deterministic domain router. Read collections are routed through
 * canonical read models; mutations remain owned by their domain tools.
 */
export async function executeTool(toolNameOrOptions, paramsArg = {}, userArg = null) {
  let toolName;
  let params = {};
  let user = null;
  let isPro = false;
  let language = 'es';
  let userMessage = '';
  let correlationId = null;
  let referenceTime = null;
  let clarificationResolution = false;
  let typedTemporalResolution = false;

  if (typeof toolNameOrOptions === 'object' && toolNameOrOptions !== null) {
    toolName = toolNameOrOptions.toolName;
    params = toolNameOrOptions.params || {};
    user = toolNameOrOptions.user;
    isPro = toolNameOrOptions.isPro ?? (user?.isPro || false);
    language = toolNameOrOptions.language || (user?.locale?.startsWith('en') ? 'en' : 'es');
    userMessage = toolNameOrOptions.userMessage || '';
    correlationId = toolNameOrOptions.correlationId || null;
    referenceTime = toolNameOrOptions.referenceTime || null;
    clarificationResolution = toolNameOrOptions.clarificationResolution === true;
    typedTemporalResolution = toolNameOrOptions.typedTemporalResolution === true;
  } else {
    toolName = toolNameOrOptions;
    params = paramsArg || {};
    user = userArg;
    isPro = userArg?.isPro ?? false;
    language = userArg?.locale?.startsWith('en') ? 'en' : 'es';
  }

  const reqId = correlationId ? `[tool req=${correlationId}]` : '[tool]';
  console.log(`${reqId} Executing ${toolName} action=${params?.action || 'default'} for user=${user?.id || user?.phone_number}`);

  try {
    let result = null;

    switch (toolName) {
      case TOOL_NAMES.MANAGE_REMINDER: {
        const action = params?.action || 'create';
        const isBulkCancellation = action === 'cancel' && ['all', 'elapsed'].includes(params?.scope);
        if (action === 'list') {
          result = await executeReminderReadTool({ params, user, language, referenceTime });
        } else if (action === 'cancel' && !isBulkCancellation) {
          result = await executeSingleReminderCancellation({ params, user, language, userMessage, correlationId });
        } else {
          result = await executeReminderTool({
            action, params, user, isPro, language, userMessage, referenceTime, clarificationResolution, typedTemporalResolution,
          });
        }
        break;
      }

      case TOOL_NAMES.MANAGE_TASK: {
        const action = params?.action || 'create';
        result = action === 'list'
          ? await executeTaskReadTool({ params, user, language })
          : await executeTaskTool({ action, params, user, language, userMessage, referenceTime });
        break;
      }

      case TOOL_NAMES.MANAGE_ENTITY: {
        const action = params?.action || 'create';
        result = await executeEntityTool({ action, params, user, language, clarificationResolution });
        break;
      }

      case TOOL_NAMES.MANAGE_MEMORY: {
        const action = params?.action || 'save';
        result = await executeMemoryTool({ action, params, user, language });
        break;
      }

      case TOOL_NAMES.MANAGE_SUBSCRIPTION:
      case TOOL_NAMES.GET_SUBSCRIPTION_LINK: {
        const action = toolName === TOOL_NAMES.GET_SUBSCRIPTION_LINK ? 'get_link' : (params?.action || 'get_link');
        result = await executeSubscriptionTool({ action, params, user, language });
        break;
      }

      case TOOL_NAMES.MANAGE_GOOGLE_CALENDAR: {
        const action = params?.action || 'get_connect_link';
        const safeParams = sanitizeCalendarParams(action, params);
        result = await executeCalendarTool({ action, params: safeParams, user, language, referenceTime });
        break;
      }

      case TOOL_NAMES.GET_UNIFIED_AGENDA: {
        const action = params?.action || 'get_agenda';
        result = await executeUnifiedAgendaTool({ action, params, user, language });
        break;
      }

      case TOOL_NAMES.ADMIN_METRICS: {
        const action = params?.action || 'get_overview';
        result = await executeAdminTool({ action, params, user, language });
        break;
      }

      default:
        result = {
          success: false,
          action: 'unknown',
          errorCode: 'UNKNOWN_TOOL',
          error: `Herramienta desconocida: ${toolName}`,
        };
        break;
    }

    if (!result.success) {
      console.warn(`${reqId} ${toolName} failed with ${result.errorCode}:`, result.error);
      const rawSummary = result.formattedCard
        || result.rawSummary
        || result.error
        || 'Ocurrió un error al ejecutar la herramienta.';
      return {
        success: false,
        action: result.action || 'error',
        errorCode: result.errorCode || 'TOOL_EXECUTION_ERROR',
        error: result.error,
        isProFeature: result.isProFeature ?? (result.errorCode === 'PRO_TIER_REQUIRED'),
        rawSummary,
        confirmation: result.formattedCard || result.rawSummary || formatErrorCard(result.errorCode, result.error, language),
        ctaUrl: result.ctaUrl || null,
        ctaHeader: result.ctaHeader || null,
        ctaButtonText: result.ctaButtonText || null,
        data: result.data || null,
        requiresClarification: Boolean(result.requiresClarification),
        pendingClarifications: result.pendingClarifications || result.data?.pendingClarifications || [],
        partialSuccess: Boolean(result.partialSuccess),
        complete: false,
      };
    }

    const rawSummary = result.confirmation || result.rawSummary || 'Operación completada.';

    return {
      success: true,
      action: result.action || params?.action || 'executed',
      data: result.data,
      rawSummary,
      confirmation: rawSummary,
      ctaUrl: result.ctaUrl || null,
      ctaHeader: result.ctaHeader || null,
      ctaButtonText: result.ctaButtonText || null,
      requiresClarification: Boolean(result.requiresClarification),
      pendingClarifications: result.pendingClarifications || result.data?.pendingClarifications || [],
      partialSuccess: Boolean(result.partialSuccess),
      complete: result.complete !== false,
    };
  } catch (err) {
    console.error(`${reqId} Unexpected exception in ${toolName}:`, err);
    return {
      success: false,
      action: 'error',
      errorCode: 'UNEXPECTED_EXCEPTION',
      error: err.message,
      rawSummary: err.message,
      confirmation: formatErrorCard('UNEXPECTED_EXCEPTION', null, language),
    };
  }
}
