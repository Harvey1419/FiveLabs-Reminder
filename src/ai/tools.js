import { executeReminderTool } from './tools/reminderTools.js';
import { executeTaskTool } from './tools/taskTools.js';
import { executeEntityTool } from './tools/entityTools.js';
import { executeMemoryTool } from './tools/memoryTools.js';
import { executeSubscriptionTool } from './tools/subscriptionTools.js';
import { executeCalendarTool } from './tools/calendarTools.js';
import { executeAdminTool } from './tools/adminTools.js';
import { formatErrorCard } from './tools/formatters.js';

export const TOOL_NAMES = {
  MANAGE_REMINDER: 'manage_reminder',
  MANAGE_TASK: 'manage_task',
  MANAGE_ENTITY: 'manage_entity',
  MANAGE_MEMORY: 'manage_memory',
  MANAGE_SUBSCRIPTION: 'manage_subscription',
  GET_SUBSCRIPTION_LINK: 'get_subscription_link',
  MANAGE_GOOGLE_CALENDAR: 'manage_google_calendar',
  ADMIN_METRICS: 'admin_metrics',
};

/**
 * Master tool router that executes domain tools deterministically and returns validated results.
 * Supports both options object and positional (toolName, params, user) invocations.
 */
export async function executeTool(toolNameOrOptions, paramsArg = {}, userArg = null) {
  let toolName;
  let params = {};
  let user = null;
  let isPro = false;
  let language = 'es';
  let userMessage = '';
  let correlationId = null;

  if (typeof toolNameOrOptions === 'object' && toolNameOrOptions !== null) {
    toolName = toolNameOrOptions.toolName;
    params = toolNameOrOptions.params || {};
    user = toolNameOrOptions.user;
    isPro = toolNameOrOptions.isPro ?? (user?.isPro || false);
    language = toolNameOrOptions.language || (user?.locale?.startsWith('en') ? 'en' : 'es');
    userMessage = toolNameOrOptions.userMessage || '';
    correlationId = toolNameOrOptions.correlationId || null;
  } else {
    toolName = toolNameOrOptions;
    params = paramsArg || {};
    user = userArg;
    isPro = userArg?.isPro ?? false;
    language = userArg?.locale?.startsWith('en') ? 'en' : 'es';
    userMessage = '';
    correlationId = null;
  }

  const reqId = correlationId ? `[tool req=${correlationId}]` : '[tool]';
  console.log(`${reqId} Executing ${toolName} action=${params?.action || 'default'} for user=${user?.id || user?.phone_number}`);

  try {
    let result = null;

    switch (toolName) {
      case TOOL_NAMES.MANAGE_REMINDER: {
        const action = params?.action || 'create';
        result = await executeReminderTool({ action, params, user, isPro, language, userMessage });
        break;
      }

      case TOOL_NAMES.MANAGE_TASK: {
        const action = params?.action || 'create';
        result = await executeTaskTool({ action, params, user, language, userMessage });
        break;
      }

      case TOOL_NAMES.MANAGE_ENTITY: {
        const action = params?.action || 'create';
        result = await executeEntityTool({ action, params, user, language });
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
        result = await executeSubscriptionTool({
          action,
          params,
          user,
          language,
        });
        break;
      }

      case TOOL_NAMES.MANAGE_GOOGLE_CALENDAR: {
        const action = params?.action || 'get_connect_link';
        result = await executeCalendarTool({ action, params, user, language });
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
      const rawSummary = result.error || 'Ocurrió un error al ejecutar la herramienta.';
      return {
        success: false,
        action: result.action || 'error',
        errorCode: result.errorCode || 'TOOL_EXECUTION_ERROR',
        error: result.error,
        isProFeature: result.isProFeature ?? (result.errorCode === 'PRO_TIER_REQUIRED'),
        rawSummary,
        confirmation: formatErrorCard(result.errorCode, result.error, language),
        ctaUrl: result.ctaUrl || null,
        data: result.data || null,
      };
    }

    const rawSummary = result.data?.formattedCard || result.confirmation || result.rawSummary || 'Operación completada.';

    return {
      success: true,
      action: result.action || params?.action || 'executed',
      data: result.data,
      rawSummary,
      confirmation: rawSummary,
      ctaUrl: result.ctaUrl || null,
      ctaHeader: result.ctaHeader || null,
      ctaButtonText: result.ctaButtonText || null,
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
