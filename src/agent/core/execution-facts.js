import { sanitizeResponseText } from './working-memory.js';

function getSafeSummary(result, language) {
  const fallback = result?.success
    ? (language === 'en' ? 'The operation completed successfully.' : 'La operación se completó correctamente.')
    : (language === 'en' ? 'The operation could not be completed.' : 'No se pudo completar la operación.');
  return sanitizeResponseText(
    result?.confirmation || result?.formattedCard || result?.rawSummary || result?.error || fallback
  );
}

function getSafeCard(result, language) {
  return sanitizeResponseText(
    result?.formattedCard || result?.confirmation || result?.rawSummary || getSafeSummary(result, language)
  );
}

const MUTATION_ACTIONS = new Set([
  'created_reminders_batch', 'created_advance_reminder', 'updated_reminder', 'cancelled_reminders',
  'acknowledged_reminder', 'acknowledged_reminders_batch', 'created_tasks_batch', 'completed_task',
  'completed_tasks', 'updated_task', 'deleted_task', 'created_entity', 'renamed_entity', 'merged_entities',
  'deleted_entities', 'deduplicated_entities',
]);

/**
 * Build the only response-facing representation of a backend execution.
 * Internal IDs and raw database objects are intentionally excluded.
 */
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
    card: getSafeCard(result, language),
    ctaUrl: result?.ctaUrl || null,
    ctaHeader: result?.ctaHeader || null,
    ctaButtonText: result?.ctaButtonText || null,
  });
}

/**
 * Compose a concise answer exclusively from validated execution facts.
 * This deliberately does not reuse pre-execution model prose.
 */
export function composeExecutionReply(facts, language = 'es', options = {}) {
  const safeFacts = (facts || []).filter(Boolean);
  if (safeFacts.length === 0) return '';
  const framing = options?.framing && typeof options.framing === 'object'
    ? options.framing
    : null;
  const before = typeof framing?.before === 'string' ? sanitizeResponseText(framing.before) : '';
  const after = typeof framing?.after === 'string' ? sanitizeResponseText(framing.after) : '';
  const frame = (body, fallbackAfter = '') => [before, body, after || fallbackAfter]
    .filter(Boolean)
    .join('\n\n');
  const renderedCards = safeFacts
    .map((fact) => fact.card || fact.summary)
    .filter(Boolean);
  const allComplete = safeFacts.every((fact) => fact.success && fact.complete);
  const completedMutation = allComplete && safeFacts.some((fact) => MUTATION_ACTIONS.has(fact.action));

  // Execution presentation is backend-owned for every domain. Model framing
  // is intentionally ignored because even a short sentence can duplicate the
  // following card. Successful mutations close warmly after the useful facts.
  if (completedMutation) {
    const followUp = language === 'en'
      ? 'Anything else I can help you with?'
      : '¿Algo más en lo que pueda ayudarte?';
    return frame(renderedCards.join('\n\n'), followUp);
  }

  if (safeFacts.length === 1) return frame(renderedCards[0] || safeFacts[0].summary);

  if (safeFacts.some((fact) => fact.requiresClarification)) {
    return frame(renderedCards.join('\n\n'));
  }

  const succeeded = safeFacts.filter((fact) => fact.success);
  const failed = safeFacts.filter((fact) => !fact.success);

  if (failed.length === 0) {
    return frame(renderedCards.join('\n\n'));
  }

  const header = succeeded.length > 0
    ? (language === 'en'
      ? `I completed ${succeeded.length} action${succeeded.length === 1 ? '' : 's'}, but ${failed.length} could not be completed:`
      : `Completé ${succeeded.length} ${succeeded.length === 1 ? 'acción' : 'acciones'}, pero ${failed.length} no ${failed.length === 1 ? 'se pudo completar' : 'se pudieron completar'}:`)
    : (language === 'en' ? 'I could not complete the requested actions:' : 'No pude completar las acciones solicitadas:');

  const lines = safeFacts.map((fact) => `${fact.success ? '✅' : '⚠️'} ${fact.card || fact.summary}`);
  return frame(`${header}\n${lines.join('\n')}`);
}
