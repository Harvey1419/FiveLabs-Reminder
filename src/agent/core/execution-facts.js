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
 * Cards remain backend-owned and are the primary WhatsApp presentation.
 * Modern callers pass an object framing and never receive an automatic generic
 * closing. A legacy string framing keeps the historical closing only for
 * backwards compatibility with older internal callers/tests while they migrate.
 */
export function composeExecutionReply(facts, language = 'es', options = {}) {
  const safeFacts = (facts || []).filter(Boolean);
  if (safeFacts.length === 0) return '';

  const legacyFraming = typeof options?.framing === 'string';
  const framing = options?.framing && typeof options.framing === 'object'
    ? options.framing
    : null;
  const before = typeof framing?.before === 'string' ? sanitizeResponseText(framing.before) : '';
  const after = typeof framing?.after === 'string' ? sanitizeResponseText(framing.after) : '';
  const frame = (body, legacyFallback = '') => [before, body, after || (legacyFraming ? legacyFallback : '')]
    .filter(Boolean)
    .join('\n\n');

  const renderedCards = safeFacts
    .map((fact) => fact.card || fact.summary)
    .filter(Boolean);
  const allComplete = safeFacts.every((fact) => fact.success && fact.complete);
  const completedMutation = allComplete && safeFacts.some((fact) => MUTATION_ACTIONS.has(fact.action));

  if (safeFacts.length === 1) {
    const legacyFollowUp = completedMutation
      ? (language === 'en' ? 'Anything else I can help you with?' : '¿Algo más en lo que pueda ayudarte?')
      : '';
    return frame(renderedCards[0] || safeFacts[0].summary, legacyFollowUp);
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
