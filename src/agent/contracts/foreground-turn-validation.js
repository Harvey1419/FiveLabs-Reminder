import { parseIntentArguments, validateTurnIntent } from './intent-contracts.js';
import { projectStructuredTurnIntent, stripStructuredNulls } from './foreground-turn-schema.js';
import { PERSONAL_READ_OPERATIONS } from '../orchestration/personal-knowledge.js';

/** Owned-history availability is supplied by the router, never inferred from prose. */
export function sanitizeForegroundEvidenceRefs(intent, hasHistoricalEvidence) {
  if (hasHistoricalEvidence || !intent || !Array.isArray(intent.actions)) return intent;
  return {
    ...intent,
    actions: intent.actions.map(action => {
      if (!action || typeof action !== 'object') return action;
      const op = String(action.operation || `${action.domain}.${action.action}`).toLowerCase();
      if ((op === 'conversation.reply' || (action.domain === 'conversation' && action.action === 'reply'))
        && action.evidenceRefs !== undefined && typeof action.content === 'string' && action.content.trim()) {
        const { evidenceRefs: _unused, ...cleaned } = action;
        return cleaned;
      }
      return action;
    }),
  };
}

export function enforceForegroundProfileSource(validation, currentUserText) {
  if (!validation?.valid || !validation.intent?.profileUpdate) return validation;
  const quote = validation.intent.profileUpdate.sourceQuote;
  if (quote && currentUserText.includes(quote)) return validation;
  const safe = validation.intent.actions.every(({ domain, action }) =>
    PERSONAL_READ_OPERATIONS.has(`${domain}.${action}`)
    || (domain === 'conversation' && ['reply', 'recap'].includes(action)));
  if (!safe) return { valid: false, errorCode: 'INVALID_TURN_CONTEXT', error: 'Profile evidence is not from the current user turn.' };
  const { profileUpdate, ...intent } = validation.intent;
  return { ...validation, intent };
}

export function validateForegroundContent(content, {
  isAdmin = false, hasHistoricalEvidence = true, currentUserText,
} = {}) {
  const parsed = parseIntentArguments(content);
  if (!parsed) return { valid: false, errorCode: 'INVALID_PARAMETERS', error: 'La decisión estructurada no era JSON válido.' };
  const canonical = sanitizeForegroundEvidenceRefs(
    projectStructuredTurnIntent(stripStructuredNulls(parsed)), hasHistoricalEvidence);
  const validation = validateTurnIntent(canonical, { isAdmin, requireResponseCapability: true });
  return typeof currentUserText === 'string'
    ? enforceForegroundProfileSource(validation, currentUserText) : validation;
}
