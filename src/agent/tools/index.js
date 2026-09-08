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
  // Event identity and event content are separate concepts. A target echoed as
  // summary is not an explicit rename, so it must never reach the calendar mutation.
  if (safe.target && safe.summary && String(safe.target).trim() === String(safe.summary).trim()) {
    delete safe.summary;
  }
  return safe;
}

/**
 * Canonical deterministic domain router.
 *
 * There is exactly one invocation contract: executeTool({ ... }). All semantic
 * meaning enters through TurnIntent -> intent-executor; this layer only routes
 * already-structured operations to domain implementations.
 */
export async function executeTool({
  toolName,
  params = {},
  user = null,
  isPro: requestedIsPro,
  language: requestedLanguage,
  userMessage = '',
  correlationId = null,
  referenceTime = null,
  clarificationResolution = false,
  typedTemporalResolution = false,
} = {}) {
  const isPro = requestedIsPro ?? (user?.isPro || false);
  const language = requestedLanguage || (user?.locale?.startsWith('en') ? 'en' : 'es');
  const reqId = correlationId ? `[tool req=${correlationId}]` : '[tool]';

  if (!toolName) {
    return {
      success: false,
      action: 'unknown',
      errorCode: 'UNKNOWN_TOOL',
      error: 'No se especificó una herramienta para ejecutar.',
      rawSummary: 'No se especificó una herramienta para ejecutar.',
      confirmation: formatErrorCard('UNKNOWN_TOOL', null, language),
      complete: false,
    };
  }

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
            action,
            params,
            user,
            isPro,
            language,
            userMessage,
            referenceTime,
            clarificationResolution,
            typedTemporalResolution,
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

      case TOOL_NAMES.MANAGE_SUBSCRIPTION: {
        const action = params?.action || 'get_link';
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
      complete: false,
    };
  }
}
