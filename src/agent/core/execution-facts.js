import { sanitizeResponseText } from './working-memory.js';
import { TOOL_NAMES } from '../contracts/tool-names.js';
import { formatCanonicalAgenda, formatCanonicalTaskList } from '../../shared/agenda-presentation.js';
import {
  formatCanonicalReminderCreate,
  formatCanonicalReminderCreateBatch,
  formatCanonicalReminderCancelBatch,
  formatCanonicalReminderList,
} from '../../shared/reminder-presentation.js';

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
    // Structured, backend-verified data used only by the presentation layer to
    // aggregate homogeneous multi-action turns. Never interpreted as user intent.
    presentationData: result?.data ?? null,
  });
}

function isReminderAction(fact, action) {
  return fact?.tool === TOOL_NAMES.MANAGE_REMINDER && fact?.requestedAction === action;
}

function aggregateSuccessfulReminderFacts(succeeded, language) {
  if (succeeded.length < 2) return null;

  if (succeeded.every((fact) => isReminderAction(fact, 'create') && fact.presentationData)) {
    const timezone = succeeded
      .map((fact) => fact.presentationData?.timezone)
      .find(Boolean) || 'UTC';
    return formatCanonicalReminderCreateBatch(
      succeeded.map((fact) => fact.presentationData),
      { language, timezone },
    );
  }

  if (succeeded.every((fact) => isReminderAction(fact, 'cancel') && fact.presentationData)) {
    return formatCanonicalReminderCancelBatch(
      succeeded.map((fact) => fact.presentationData),
      { language },
    );
  }

  return null;
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

  if (safeFacts.length === 1) {
    return frame(safeFacts[0].card || safeFacts[0].summary);
  }

  if (safeFacts.some((fact) => fact.requiresClarification)) {
    return frame(safeFacts.map((fact) => fact.card || fact.summary).filter(Boolean).join('\n\n'));
  }

  const succeeded = safeFacts.filter((fact) => fact.success);
  const failed = safeFacts.filter((fact) => !fact.success);
  const aggregateSuccessCard = aggregateSuccessfulReminderFacts(succeeded, language);

  if (failed.length === 0 && aggregateSuccessCard) {
    return frame(sanitizeResponseText(aggregateSuccessCard));
  }

  if (failed.length === 0) {
    return frame(safeFacts.map((fact) => fact.card || fact.summary).filter(Boolean).join('\n\n'));
  }

  const header = succeeded.length > 0
    ? (language === 'en'
      ? `I completed ${succeeded.length} action${succeeded.length === 1 ? '' : 's'}, but ${failed.length} could not be completed:`
      : `Completé ${succeeded.length} ${succeeded.length === 1 ? 'acción' : 'acciones'}, pero ${failed.length} no ${failed.length === 1 ? 'se pudo completar' : 'se pudieron completar'}:`)
    : (language === 'en' ? 'I could not complete the requested actions:' : 'No pude completar las acciones solicitadas:');

  const successSection = aggregateSuccessCard
    ? sanitizeResponseText(aggregateSuccessCard)
    : succeeded.map((fact) => fact.card || fact.summary).filter(Boolean).join('\n\n');
  const failureLines = failed.map((fact) => `⚠️ ${fact.card || fact.summary}`);
  const body = [header, successSection, failureLines.join('\n')].filter(Boolean).join('\n\n');
  return frame(body);
}
