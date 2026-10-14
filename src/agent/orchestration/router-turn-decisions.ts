import { TOOL_NAMES } from '../contracts/tool-names-contract.js';
import { parseIntentArguments, validateTurnIntent, type ValidatedAction, type ValidatedIntent, type IntentValidation } from '../contracts/intent-validator.js';
import { validateForegroundContent, enforceForegroundProfileSource, sanitizeForegroundEvidenceRefs } from '../contracts/foreground-turn-validator.js';
import { projectStructuredTurnIntent, stripStructuredNulls } from '../contracts/foreground-turn-projection.js';
import { sanitizeResponseText } from '../core/working-memory-cache.js';
import type { NormalizedToolCall } from './router-model-response.js';

export type CollectedIntent = IntentValidation | { valid: true; intent: null };
export type StructuredTurnDecision = { unavailable: true; validation: null } | { unavailable: false; validation: IntentValidation };
interface DecisionResponse { unavailable?: unknown; toolCalls?: readonly unknown[]; structuredIntent?: unknown; content?: unknown }
export interface FollowupOverview extends Record<string, unknown> { pendingConfirmationReminders?: readonly { id?: unknown; content?: unknown; title?: unknown }[] | null }
export interface FollowupMemory { notificationReminderId?: unknown; notificationContent?: unknown }

export function collectIntent(toolCalls: readonly Pick<NormalizedToolCall, 'name' | 'arguments'>[], { isAdmin = false }: { isAdmin?: boolean } = {}): CollectedIntent {
  const executeCalls = toolCalls.filter((call) => call.name === TOOL_NAMES.EXECUTE_TURN);
  const replyCalls = toolCalls.filter((call) => call.name === TOOL_NAMES.REPLY_TO_USER);
  const unknownCalls = toolCalls.filter((call) => ![TOOL_NAMES.EXECUTE_TURN, TOOL_NAMES.REPLY_TO_USER].includes(call.name as typeof TOOL_NAMES.EXECUTE_TURN | typeof TOOL_NAMES.REPLY_TO_USER));
  if (unknownCalls.length > 0 || (executeCalls.length > 0 && replyCalls.length > 0) || replyCalls.length > 1) {
    return { valid: false, errorCode: 'UNKNOWN_TOOL', error: 'El modelo intentó usar una combinación de capacidades no disponible.' };
  }
  if (replyCalls.length === 1) {
    const parsed = parseIntentArguments(replyCalls[0]!.arguments) as { content?: unknown } | null;
    const content = typeof parsed?.content === 'string' ? parsed.content.trim() : '';
    if (!content) return { valid: false, errorCode: 'MISSING_CONTENT', error: 'reply_to_user requiere contenido.' };
    return { valid: true, intent: { actions: [{ domain: 'conversation', action: 'reply', content }], excluded: [] } };
  }
  if (executeCalls.length === 0) return { valid: true, intent: null };

  const actions: ValidatedAction[] = [];
  const excluded: unknown[] = [];
  for (const call of executeCalls) {
    const parsed = parseIntentArguments(call.arguments);
    if (!parsed) return { valid: false, errorCode: 'INVALID_PARAMETERS', error: 'La decisión estructurada no era JSON válido.' };
    const validation = validateTurnIntent(parsed, { isAdmin });
    if (!validation.valid) return validation;
    actions.push(...validation.intent.actions);
    excluded.push(...validation.intent.excluded);
  }
  if (actions.length > 12) {
    return { valid: false, errorCode: 'TURN_ACTION_LIMIT', error: 'La solicitud contiene demasiadas acciones para un solo turno.' };
  }
  return { valid: true, intent: { actions, excluded } };
}

export function conversationReplyFromActions(actions: readonly { domain?: string; action?: string; content?: unknown }[] = []): string {
  return actions
    .filter((action) => action.domain === 'conversation' && action.action === 'reply')
    .map((action) => sanitizeResponseText(action.content || ''))
    .filter(Boolean)
    .join('\n\n');
}

// Initial-turn source boundary only. A stale optional update must not block
// independent conversation/reads, nor permit mutations under the old context.
export function enforceCurrentProfileSource(validation: IntentValidation, currentUserText: string): IntentValidation;
export function enforceCurrentProfileSource(validation: CollectedIntent, currentUserText: string): CollectedIntent;
export function enforceCurrentProfileSource(validation: CollectedIntent, currentUserText: string): CollectedIntent {
  return enforceForegroundProfileSource(validation, currentUserText);
}

export function sanitizeHallucinatedEvidenceRefs(intent: unknown, hasHistoricalEvidence: boolean): unknown {
  return sanitizeForegroundEvidenceRefs(intent, hasHistoricalEvidence);
}

export function parseStructuredTurnDecision(input: unknown, { isAdmin = false, hasHistoricalEvidence = true }: { isAdmin?: boolean; hasHistoricalEvidence?: boolean } = {}): StructuredTurnDecision {
  const modelResponse = input as DecisionResponse | null | undefined;
  if (modelResponse?.unavailable) return { unavailable: true, validation: null };
  if (modelResponse?.toolCalls?.length) return { unavailable: false, validation: { valid: false, errorCode: 'INVALID_PARAMETERS', error: 'La decisión foreground no admite llamadas a herramientas.' } };
  if (modelResponse?.structuredIntent) {
    const canonical = sanitizeHallucinatedEvidenceRefs(modelResponse.structuredIntent, hasHistoricalEvidence);
    return { unavailable: false, validation: validateTurnIntent(canonical, { isAdmin, requireResponseCapability: true }) };
  }
  const parsed = parseIntentArguments(modelResponse?.content);
  if (!parsed) return { unavailable: false, validation: { valid: false, errorCode: 'INVALID_PARAMETERS', error: 'La decisión estructurada no era JSON válido.' } };
  const canonical = sanitizeHallucinatedEvidenceRefs(
    projectStructuredTurnIntent(stripStructuredNulls(parsed)),
    hasHistoricalEvidence
  );
  return { unavailable: false, validation: validateTurnIntent(canonical, { isAdmin, requireResponseCapability: true }) };
}

export function validateStructuredTurnContent(content: unknown, { isAdmin = false, hasHistoricalEvidence = true }: { isAdmin?: boolean; hasHistoricalEvidence?: boolean } = {}): IntentValidation {
  return validateForegroundContent(content, { isAdmin, hasHistoricalEvidence });
}

export function enforceAttachmentOnlyIntent<T extends CollectedIntent | null | undefined>(collected: T, isAttachmentOnlyTurn: unknown): T | Extract<IntentValidation, { valid: false }> {
  if (!isAttachmentOnlyTurn || !collected?.valid || !collected.intent) return collected;
  const hasOperationalAction = collected.intent.responseCapability !== 'general'
    || collected.intent.actions.some((action) => action?.domain !== 'conversation');
  if (!hasOperationalAction) return collected;
  return {
    valid: false,
    errorCode: 'UNTRUSTED_ATTACHMENT_ACTION',
    error: 'El contenido de un adjunto sin instrucción confiable del usuario no puede originar acciones operativas.',
  };
}

export function bindAuthoritativeFollowupTargets<T>(intent: T, overview: FollowupOverview | null | undefined, workingMemory: FollowupMemory | null = null): T {
  const value = intent as (Record<string, unknown> & { actions?: ValidatedAction[] }) | null | undefined;
  if (!value || !Array.isArray(value.actions)) return intent;

  const wmReminderId = String(workingMemory?.notificationReminderId || '').trim();
  const wmHumanTarget = String(workingMemory?.notificationContent || '').trim();

  const active = Array.isArray(overview?.pendingConfirmationReminders)
    ? overview.pendingConfirmationReminders
    : [];
  const singleActive = active.length === 1 ? active[0] : null;
  const singleHumanTarget = String(singleActive?.content || singleActive?.title || '').trim();
  const singleReminderId = String(singleActive?.id || '').trim();

  if (!wmReminderId && (!singleReminderId || !singleHumanTarget)) return intent;

  return {
    ...value,
    actions: value.actions.map((action) => {
      if (action?.domain !== 'reminder' || action?.action !== 'acknowledge') return action;
      const declaredTarget = String(action.target || '').trim();

      // Prioritize working memory from a recent nudge/notification
      if (wmReminderId && wmHumanTarget) {
        const targetsWm = !declaredTarget
          || declaredTarget === '1'
          || declaredTarget.localeCompare(wmHumanTarget, undefined, { sensitivity: 'base' }) === 0;
        if (targetsWm) {
          return {
            ...action,
            target: declaredTarget || wmHumanTarget,
            authoritativeReminderId: wmReminderId,
          };
        }
      }

      // Fallback to sole active notice from overview
      if (singleReminderId && singleHumanTarget) {
        const targetsActive = !declaredTarget
          || declaredTarget === '1'
          || declaredTarget.localeCompare(singleHumanTarget, undefined, { sensitivity: 'base' }) === 0;
        if (targetsActive) {
          return {
            ...action,
            target: declaredTarget || singleHumanTarget,
            authoritativeReminderId: singleReminderId,
          };
        }
      }

      return action;
    }),
  } as T;
}

