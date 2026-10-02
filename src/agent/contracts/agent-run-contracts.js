import { TURN_CONTEXT_PROPERTIES, validateTurnContext } from './turn-context.js';
import { matchesSchema } from './schema-value.js';
import { strictProviderSchema, stripStructuredNulls } from './foreground-turn-schema.js';
import { typedSchedule, TURN_INTENT_SCHEMA } from './intent-contracts.js';

export const RUN_STATUSES = Object.freeze([
  'running',
  'waiting_for_input',
  'waiting_for_approval',
  'completed',
  'cancelled',
  'failed',
  'expired',
]);

export const RUN_KINDS = Object.freeze([
  'reminder_creation',
  'entity_destructive_batch',
  'task_mutation',
  'generic_operation',
]);

export const PREPARED_ACTION_STATUSES = Object.freeze([
  'prepared',
  'executed',
  'skipped',
  'failed',
]);

export const APPROVAL_RELATIONS = Object.freeze(['approval', 'unrelated', 'cancel', 'supersede']);
export const APPROVAL_DECISIONS = Object.freeze(['approve_all', 'approve_subset', 'reject']);

export const CONTINUATION_RELATIONS = Object.freeze(['resume', 'unrelated', 'cancel', 'supersede']);

export const APPROVAL_DECISION_SCHEMA = Object.freeze(strictProviderSchema({
  type: 'object',
  additionalProperties: false,
  properties: {
    ...TURN_CONTEXT_PROPERTIES,
    relation: {
      type: 'string',
      enum: APPROVAL_RELATIONS,
      description: 'Relation to the pending approval: "approval" if responding to the prompt, "unrelated" if user changes topic, "cancel" if declining; "supersede" when correcting/replacing the proposed operation (never approve its old payload).',
    },
    decision: {
      type: 'string',
      enum: APPROVAL_DECISIONS,
      description: 'Specific choice when relation="approval": "approve_all" for entire batch, "approve_subset" for selective confirmation, "reject" for rejection.',
    },
    selectedCallIds: {
      type: 'array',
      items: { type: 'string' },
      description: 'The exact callId items (e.g. ["call-1", "call-2"]) approved by the user when decision="approve_subset".',
    },
    reply: {
      type: 'string',
      description: 'Direct conversational explanation or acknowledgement to the user. Do not claim execution: the runtime renders the observed result.',
    },
  },
  required: ['relation', 'responseLanguage'],
}));

const continuationSchedule = structuredClone(typedSchedule);
continuationSchedule.properties.clockMode = {
  type: 'string',
  enum: ['explicit_24h', 'ambiguous_12h'],
  description: 'For an explicit AM/PM or 24h time, output hour 0..23 and explicit_24h (3 PM = 15, noon = 12, midnight = 0). For a genuinely ambiguous 12h time keep hour 1..12 and ambiguous_12h. Do not invent AM/PM.',
};
// Document immediate-time shortcuts: "ya", "ahora", "de una", "right now", "now", "immediately"
// must resolve to { kind: "relative_offset", offsetMinutes: 0 } — starting from the current moment.
// Never ask the user again when they express an immediate temporal intent.
continuationSchedule.description = [
  continuationSchedule.description,
  'Immediate-time expressions ("ya", "ahora", "de una vez", "en este momento", "right now", "now", "immediately") resolve to: { "kind": "relative_offset", "offsetMinutes": 0 }.',
].filter(Boolean).join(' ');

export const CONTINUATION_DECISION_SCHEMA = Object.freeze(strictProviderSchema({
  type: 'object',
  additionalProperties: false,
  properties: {
    ...TURN_CONTEXT_PROPERTIES,
    relation: {
      type: 'string',
      enum: CONTINUATION_RELATIONS,
      description: 'Relation to the suspended operation: "resume" if supplying missing fields or correcting fields within its draft; "supersede" if the current message explicitly replaces that request and must be interpreted as a new canonical turn; "unrelated" if changing topic; "cancel" if aborting.',
    },
    actionInputs: {
      type: 'array', maxItems: 12,
      description: 'Delta per exact prepared callId. Use this as the only delta representation. For shared values, repeat them in each affected callId. Include explicit corrections to existing fields as well as missing data. Preserve all other known fields. Never address an executed action; use supersede for a replacement request.',
      items: { type: 'object', additionalProperties: false, properties: {
        callId: { type: 'string' },
        fields: { type: 'object', additionalProperties: false, properties: Object.fromEntries(
          Object.entries(TURN_INTENT_SCHEMA.properties.actions.items.properties)
            .filter(([key]) => !['domain', 'action', 'missingFields', 'question'].includes(key))
            .map(([key, schema]) => [key, key === 'schedule' ? continuationSchedule : schema]),
        ), required: [] },
      }, required: ['callId', 'fields'] },
    },
    reply: {
      type: 'string',
      description: 'Direct conversational explanation or acknowledgement to the user.',
    },
  },
  required: ['relation', 'responseLanguage'],
}));

/**
 * Validate an approval decision produced by the model.
 */
function validateApprovalDecisionPayload(rawPayload) {
  const payload = stripStructuredNulls(rawPayload);
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return { valid: false, errorCode: 'INVALID_APPROVAL_DECISION', error: 'Approval decision must be an object.' };
  }

  const relation = String(payload.relation || '').trim();
  if (!APPROVAL_RELATIONS.includes(relation)) {
    return { valid: false, errorCode: 'INVALID_APPROVAL_RELATION', error: `relation must be one of: ${APPROVAL_RELATIONS.join(', ')}` };
  }

  if (relation === 'approval') {
    const decision = String(payload.decision || '').trim();
    if (!APPROVAL_DECISIONS.includes(decision)) {
      return { valid: false, errorCode: 'INVALID_APPROVAL_CHOICE', error: `decision must be one of: ${APPROVAL_DECISIONS.join(', ')}` };
    }
    if (decision === 'approve_subset') {
      const selected = Array.isArray(payload.selectedCallIds) ? payload.selectedCallIds.map(String).filter(Boolean) : [];
      if (selected.length === 0) {
        return { valid: false, errorCode: 'MISSING_SELECTED_CALL_IDS', error: 'approve_subset requires at least one selected callId.' };
      }
      return { valid: true, decision: { relation, decision, selectedCallIds: selected, reply: payload.reply || null } };
    }
    return { valid: true, decision: { relation, decision, selectedCallIds: [], reply: payload.reply || null } };
  }

  return {
    valid: true,
    decision: {
      relation,
      decision: null,
      selectedCallIds: [],
      reply: payload.reply || null,
    },
  };
}

/**
 * Validate a continuation decision produced by the model.
 */
function validateContinuationDecisionPayload(rawPayload) {
  const payload = stripStructuredNulls(rawPayload);
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return { valid: false, errorCode: 'INVALID_CONTINUATION_DECISION', error: 'Continuation decision must be an object.' };
  }

  const relation = String(payload.relation || '').trim();
  if (!CONTINUATION_RELATIONS.includes(relation)) {
    return { valid: false, errorCode: 'INVALID_CONTINUATION_RELATION', error: `relation must be one of: ${CONTINUATION_RELATIONS.join(', ')}` };
  }

  if (relation === 'resume') {
    if (payload.actionInputs !== undefined && (!Array.isArray(payload.actionInputs) || payload.actionInputs.length > 12)) {
      return { valid: false, errorCode: 'INVALID_ACTION_INPUT', error: 'actionInputs must be a bounded list.' };
    }
    const suppliedFields = payload.suppliedFields === undefined ? {} : payload.suppliedFields;
    const actionInputs = Array.isArray(payload.actionInputs) ? payload.actionInputs : [];
    const fieldSchema = { type: 'object', additionalProperties: false,
      properties: Object.fromEntries(Object.entries(TURN_INTENT_SCHEMA.properties.actions.items.properties)
        .filter(([key]) => !['domain', 'action', 'missingFields', 'question'].includes(key))) };
    const sharedSchema = { type: 'object', additionalProperties: false, properties: Object.fromEntries(
      Object.entries(fieldSchema.properties).filter(([key]) => ['content', 'target', 'schedule'].includes(key))) };
    if (!matchesSchema(suppliedFields, sharedSchema)) return { valid: false, errorCode: 'INVALID_ACTION_INPUT', error: 'Invalid shared input fields.' };
    const ids = new Set();
    for (const input of actionInputs) {
      if (!input || typeof input.callId !== 'string' || ids.has(input.callId) || !input.fields || typeof input.fields !== 'object' || Array.isArray(input.fields)
        || !matchesSchema(input.fields, fieldSchema)) {
        return { valid: false, errorCode: 'INVALID_ACTION_INPUT', error: 'Each input requires a unique callId and canonical action fields.' };
      }
      ids.add(input.callId);
    }
    if (actionInputs.length && Object.keys(suppliedFields).length) return { valid: false, errorCode: 'CONFLICTING_ACTION_INPUT', error: 'Use per-action fields or shared fields, not both.' };
    return { valid: true, decision: { relation, suppliedFields, actionInputs, reply: payload.reply || null } };
  }

  return {
    valid: true,
    decision: {
      relation,
      suppliedFields: {},
      reply: payload.reply || null,
    },
  };
}

export function validateApprovalDecision(rawPayload) {
  const payload = stripStructuredNulls(rawPayload);
  const context = validateTurnContext(payload);
  if (!context.valid) return context;
  const result = validateApprovalDecisionPayload(payload);
  return result.valid ? { ...result, decision: { ...result.decision, ...context.context } } : result;
}

export function validateContinuationDecision(rawPayload) {
  const payload = stripStructuredNulls(rawPayload);
  const context = validateTurnContext(payload);
  if (!context.valid) return context;
  const result = validateContinuationDecisionPayload(payload);
  return result.valid ? { ...result, decision: { ...result.decision, ...context.context } } : result;
}
