import { aiResponseSchema, jsonObjectSchema, type JsonObject } from '@templelabs/contracts';
import type { StructuredAIProvider, StructuredCompletionRequest, StructuredCompletionResult } from '@templelabs/ai';
import { getStructuredTurnSchema } from '../../agent/contracts/foreground-turn-schema.js';
import { validateForegroundContent } from '../../agent/contracts/foreground-turn-validation.js';

export interface ForegroundDecisionContext {
  readonly isAdmin: boolean; readonly hasHistoricalEvidence: boolean; readonly currentUserText: string;
  readonly attachmentOnly?: boolean;
}
/** Pure compatibility boundary. The authenticated host supplies authority and current-user evidence. */
export async function completeForegroundDecision(provider: StructuredAIProvider,
  request: Omit<StructuredCompletionRequest, 'output' | 'validate'>, context: ForegroundDecisionContext): Promise<StructuredCompletionResult> {
  const schema = jsonObjectSchema.parse(getStructuredTurnSchema({ isAdmin: context.isAdmin,
    ...(context.attachmentOnly !== undefined ? { attachmentOnly: context.attachmentOnly } : {}) }));
  const properties = jsonObjectSchema.parse(schema.properties);
  const actions = jsonObjectSchema.parse(jsonObjectSchema.parse(properties.actions).items);
  const allowed = jsonObjectSchema.parse(jsonObjectSchema.parse(actions.properties).operation).enum;
  if (!Array.isArray(allowed)) throw new Error('Invalid foreground operation contract');
  const allowedOperations = new Set(allowed);
  // Snapshot policy before asynchronous model work; no model arguments can elevate authority.
  const attachmentOnly = context.attachmentOnly === true;
  const policy = { isAdmin: context.isAdmin, hasHistoricalEvidence: context.hasHistoricalEvidence, currentUserText: context.currentUserText };
  const validateCanonical = (value: JsonObject): JsonObject => {
    if (attachmentOnly && (value.profileUpdate !== undefined && value.profileUpdate !== null
      || !Array.isArray(value.learningCandidates) || value.learningCandidates.length > 0)) throw new Error('Attachment evidence cannot grant durable metadata authority');
    const validation = validateForegroundContent(JSON.stringify(value), policy);
    if (!validation.valid || !validation.intent) throw new Error('Invalid foreground decision');
    const intent = jsonObjectSchema.parse(validation.intent);
    if (!Array.isArray(intent.actions) || intent.actions.some(action => action === null || typeof action !== 'object'
      || Array.isArray(action) || !allowedOperations.has(`${action.domain}.${action.action}`))) throw new Error('Invalid canonical operation scope');
    return intent;
  };
  const result = await provider.completeStructured({ ...request, output: { name: 'hermes_turn_decision', schema },
    validate: value => {
      if (!Array.isArray(value.actions) || value.actions.some(action =>
        action === null || typeof action !== 'object' || Array.isArray(action)
        || typeof action.operation !== 'string' || !allowedOperations.has(action.operation)
        || action.domain !== undefined || action.action !== undefined)) throw new Error('Invalid provider operation');
      return validateCanonical(value);
    } });
  const usage = aiResponseSchema.shape.usage.parse(result.usage);
  if (result.status === 'refused' && result.data === null) return { status: 'refused', data: null, usage };
  if (result.status !== 'success') throw new Error('Invalid structured provider result');
  // A new vendor adapter cannot skip host authority by ignoring the eager validator.
  return { status: 'success', data: validateCanonical(jsonObjectSchema.parse(result.data)), usage };
}
