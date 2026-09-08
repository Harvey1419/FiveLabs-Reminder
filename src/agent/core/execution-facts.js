import { sanitizeResponseText } from './working-memory.js';
import { TOOL_NAMES } from '../contracts/tool-names.js';
import { formatCanonicalAgenda, formatCanonicalTaskList } from '../../shared/agenda-presentation.js';
import { formatCanonicalReminderCreate, formatCanonicalReminderList } from '../../shared/reminder-presentation.js';

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

  if (toolName === TOOL_NAMES.MANAGE_TASK && params?.action === 'list' && result?.data) {
    return formatCanonicalTaskList(result.data, presentation);
  }

  if (toolName === TOOL_NAMES.MANAGE_REMINDER && params?.action === 'create' && result?.data) {
    return formatCanonicalReminderCreate(result.data, presentation);
  }

  if (toolName === TOOL_NAMES.MANAGE_REMINDER && params?.action === 'list' && result?.data) {
    return formatCanonicalReminderList(result.data, presentation);
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
  });
}

/** Backend-owned cards are the primary WhatsApp presentation. */
export function composeExecutionReply(facts, language = 'es', options = {}) {
  const safeFacts = (facts || []).filter(Boolean);
  if (safeFacts.length === 0) return '';

  const framing = options?.framing && typeof options.framing === 'object'
    ? options.framing
    : null;
  const before = typeof framing?.before === 'string' ? sanitizeResponseText(framing.before) : '';
  const after = typeof framing?.after === 'string' ? sanitizeResponseText(framing.after) : '';
  const frame = (body) => [before, body, after].filter(Boolean).join('\n\n');

  const renderedCards = safeFacts
    .map((fact) => fact.card || fact.summary)
    .filter(Boolean);

  if (safeFacts.length === 1) {
    return frame(renderedCards[0] || safeFacts[0].summary);
  }

  if (safeFacts.some((fact) => fact.requiresClarification)) {
    return frame(renderedCards.join('\n\n'));
  }

  const succeeded = safeFacts.filter((fact) => fact.success);
  const failed = safeFacts.filter((fact) => !fact.success);

  if (failed.length === 0) return frame(renderedCards.join('\n\n'));

  const header = succeeded.length > 0
    ? (language === 'en'
      ? `I completed ${succeeded.length} action${succeeded.length === 1 ? '' : 's'}, but ${failed.length} could not be completed:`
      : `Completé ${succeeded.length} ${succeeded.length === 1 ? 'acción' : 'acciones'}, pero ${failed.length} no ${failed.length === 1 ? 'se pudo completar' : 'se pudieron completar'}:`)
    : (language === 'en' ? 'I could not complete the requested actions:' : 'No pude completar las acciones solicitadas:');

  const lines = safeFacts.map((fact) => `${fact.success ? '✅' : '⚠️'} ${fact.card || fact.summary}`);
  return frame(`${header}\n${lines.join('\n')}`);
}
