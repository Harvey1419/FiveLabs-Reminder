import { strictProviderSchema, stripStructuredNulls } from './foreground-turn-schema.js';
import { typedSchedule } from './intent-contracts.js';

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

export const APPROVAL_RELATIONS = Object.freeze(['approval', 'unrelated', 'cancel']);
export const APPROVAL_DECISIONS = Object.freeze(['approve_all', 'approve_subset', 'reject']);

export const CONTINUATION_RELATIONS = Object.freeze(['resume', 'unrelated', 'cancel']);

export const APPROVAL_DECISION_SCHEMA = Object.freeze(strictProviderSchema({
  type: 'object',
  additionalProperties: false,
  properties: {
    relation: {
      type: 'string',
      enum: APPROVAL_RELATIONS,
      description: 'Relation to the pending approval: "approval" if responding to the prompt, "unrelated" if user changes topic, "cancel" if declining.',
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
      description: 'Direct conversational explanation or acknowledgement to the user. For approvals, write in immediate confirmation/past tense (e.g. "Listo, eliminé los proyectos seleccionados."), never future tense ("eliminaré").',
    },
  },
  required: ['relation'],
}));

const continuationSchedule = structuredClone(typedSchedule);
continuationSchedule.properties.clockMode = {
  type: 'string',
  enum: ['explicit_24h', 'ambiguous_12h'],
  description: 'For an explicit AM/PM or 24h time, output hour 0..23 and explicit_24h (3 PM = 15, noon = 12, midnight = 0). For a genuinely ambiguous 12h time keep hour 1..12 and ambiguous_12h. Do not invent AM/PM.',
};

export const CONTINUATION_DECISION_SCHEMA = Object.freeze(strictProviderSchema({
  type: 'object',
  additionalProperties: false,
  properties: {
    relation: {
      type: 'string',
      enum: CONTINUATION_RELATIONS,
      description: 'Relation to the suspended operation: "resume" if providing missing fields, "unrelated" if changing topic, "cancel" if aborting.',
    },
    suppliedFields: {
      type: 'object',
      additionalProperties: false,
      description: 'Structured delta supplied by the user. Node merges these fields deterministically.',
      properties: {
        schedule: continuationSchedule,
        content: { type: 'string', description: 'Updated or supplied text content.' },
        target: { type: 'string', description: 'Target entity or reference if supplied.' },
      },
      required: [],
    },
    reply: {
      type: 'string',
      description: 'Direct conversational explanation or acknowledgement to the user.',
    },
  },
  required: ['relation'],
}));

/**
 * Validate an approval decision produced by the model.
 */
export function validateApprovalDecision(rawPayload) {
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
export function validateContinuationDecision(rawPayload) {
  const payload = stripStructuredNulls(rawPayload);
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return { valid: false, errorCode: 'INVALID_CONTINUATION_DECISION', error: 'Continuation decision must be an object.' };
  }

  const relation = String(payload.relation || '').trim();
  if (!CONTINUATION_RELATIONS.includes(relation)) {
    return { valid: false, errorCode: 'INVALID_CONTINUATION_RELATION', error: `relation must be one of: ${CONTINUATION_RELATIONS.join(', ')}` };
  }

  if (relation === 'resume') {
    const suppliedFields = payload.suppliedFields && typeof payload.suppliedFields === 'object' && !Array.isArray(payload.suppliedFields)
      ? payload.suppliedFields
      : {};
    return { valid: true, decision: { relation, suppliedFields, reply: payload.reply || null } };
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
