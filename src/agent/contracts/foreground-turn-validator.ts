import type { IntentValidation } from './intent-validator.js';
import { parseIntentArguments, validateTurnIntent } from './intent-validator.js';
import { projectStructuredTurnIntent, stripStructuredNulls } from './foreground-turn-projection.js';
import { PERSONAL_READ_OPERATIONS } from '../orchestration/personal-knowledge-core.js';
function object(value: unknown): value is Record<string,unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value); }

/** Owned-history availability is supplied by the router, never inferred from prose. */
export function sanitizeForegroundEvidenceRefs(intent: unknown,hasHistoricalEvidence: boolean): unknown {
  if (hasHistoricalEvidence || !object(intent) || !Array.isArray(intent.actions)) return intent;
  return {
    ...intent,
    actions: intent.actions.map(action => {
      if (!object(action)) return action;
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

export function enforceForegroundProfileSource(validation: IntentValidation,currentUserText: string): IntentValidation;
export function enforceForegroundProfileSource(validation: IntentValidation | { valid: true; intent: null },currentUserText: string): IntentValidation | { valid: true; intent: null };
export function enforceForegroundProfileSource(validation: IntentValidation | { valid: true; intent: null },currentUserText: string): IntentValidation | { valid: true; intent: null } {
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

export function validateForegroundContent(content: unknown,{
  isAdmin = false, hasHistoricalEvidence = true, currentUserText,
}: { isAdmin?: boolean; hasHistoricalEvidence?: boolean; currentUserText?: string } = {}): IntentValidation {
  const parsed = parseIntentArguments(content);
  if (!parsed) return { valid: false, errorCode: 'INVALID_PARAMETERS', error: 'La decisión estructurada no era JSON válido.' };
  const canonical = sanitizeForegroundEvidenceRefs(
    projectStructuredTurnIntent(stripStructuredNulls(parsed)), hasHistoricalEvidence);
  const validation = validateTurnIntent(canonical, { isAdmin, requireResponseCapability: true });
  return typeof currentUserText === 'string'
    ? enforceForegroundProfileSource(validation,currentUserText) : validation;
}
