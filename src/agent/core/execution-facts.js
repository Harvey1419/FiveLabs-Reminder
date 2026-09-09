import { sanitizeResponseText } from './working-memory.js';
import { TOOL_NAMES } from '../contracts/tool-names.js';
import { formatCanonicalAgenda, formatCanonicalTaskList } from '../../shared/agenda-presentation.js';
import {
  formatCanonicalTaskComplete,
  formatCanonicalTaskCreate,
  formatCanonicalTaskDelete,
  formatCanonicalTaskUpdate,
} from '../../shared/task-presentation.js';
import {
  formatCanonicalReminderAcknowledge,
  formatCanonicalReminderCancel,
  formatCanonicalReminderCreate,
  formatCanonicalReminderList,
  formatCanonicalReminderUpdate,
} from '../../shared/reminder-presentation.js';
import { composeTurnPresentation } from './presentation-policy.js';

function getSafeSummary(result, language) {
  const fallback = result?.success
    ? (language === 'en' ? 'The operation completed successfully.' : 'La operación se completó correctamente.')
    : (language === 'en' ? 'The operation could not be completed.' : 'No se pudo completar la operación.');
  return sanitizeResponseText(
    result?.confirmation || result?.formattedCard || result?.rawSummary || result?.error || fallback
  );
}

function getPresentationContext(result, language) {
  return {
    language,
    timezone: result?.data?.timezone || 'UTC',
    locale: result?.data?.locale || (language === 'en' ? 'en-US' : 'es-CO'),
  };
}

function getCanonicalCard(toolName, params, result, language) {
  if (!result?.success) return null;
  const presentation = getPresentationContext(result, language);

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

function getSafeCard(toolName, params, result, language) {
  const canonical = getCanonicalCard(toolName, params, result, language);
  return sanitizeResponseText(
    canonical || result?.formattedCard || result?.confirmation || result?.rawSummary || getSafeSummary(result, language)
  );
}

export function createExecutionFact({ toolName, params, result, callId = null, language = 'es' }) {
  const success = Boolean(result?.success);
  const complete = success && result?.partialSuccess !== true && result?.complete !== false;
  return Object.freeze({
    callId,
    tool: toolName,
    action: result?.action || params?.action || 'executed',
    requestedAction: params?.action || null,
    success,
    complete,
    outcome: success ? (complete ? 'success' : 'partial_success') : 'failure',
    errorCode: success ? null : (result?.errorCode || 'TOOL_EXECUTION_ERROR'),
    requiresClarification: Boolean(result?.requiresClarification),
    summary: getSafeSummary(result, language),
    card: getSafeCard(toolName, params, result, language),
    ctaUrl: result?.ctaUrl || null,
    ctaHeader: result?.ctaHeader || null,
    ctaButtonText: result?.ctaButtonText || null,
    presentationData: result?.data ?? null,
    presentationParams: params && typeof params === 'object' ? { ...params } : {},
    presentationContext: getPresentationContext(result, language),
  });
}

/**
 * Backend-owned facts are composed once at the turn boundary. Individual tools
 * expose verified data; turn-level UX belongs to the central Presentation Policy.
 */
export function composeExecutionReply(facts, language = 'es', options = {}) {
  const safeFacts = (facts || []).filter(Boolean);
  if (safeFacts.length === 0) return '';

  const framing = options?.framing && typeof options.framing === 'object'
    ? options.framing
    : null;
  const before = typeof framing?.before === 'string' ? sanitizeResponseText(framing.before) : '';
  const after = typeof framing?.after === 'string' ? sanitizeResponseText(framing.after) : '';
  const body = sanitizeResponseText(composeTurnPresentation(safeFacts, language));

  return [before, body, after].filter(Boolean).join('\n\n');
}
