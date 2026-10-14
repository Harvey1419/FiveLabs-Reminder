import { z } from 'zod';
import { jsonObjectSchema } from './provider.js';
import { activeRunActionSnapshotSchema, suspendedRunSnapshotSchema } from './active-run-decision.js';

const id = z.string().min(1).max(256);
const storedAction = z.object({
  id: z.uuid(), run_id: id, call_id: id, domain: id, action: id,
  target_id: id.nullable(), target_name: z.string().nullable(), payload: jsonObjectSchema,
  status: activeRunActionSnapshotSchema.shape.status, execution_fact: jsonObjectSchema.nullable(),
  created_at: z.string().min(1), executed_at: z.string().nullable(),
}).catchall(z.json());
const common = {
  version: z.literal(1), runId: id, userId: id, inboundRunId: id, requestId: id,
  snapshot: suspendedRunSnapshotSchema, decision: jsonObjectSchema, claimId: z.uuid(),
  actions: z.record(id, storedAction).optional(),
};
/** Durable execution evidence is separate from a new model proposal or tool grant. */
export const activeRunCheckpointSchema = z.discriminatedUnion('stage', [
  z.strictObject({ ...common, stage: z.literal('claimed') }),
  z.strictObject({ ...common, stage: z.literal('final'), result: jsonObjectSchema }),
]).superRefine((checkpoint, ctx) => {
  const snapshot = checkpoint.snapshot;
  if (!snapshot.executionState || snapshot.actions.some(action => !Object.hasOwn(action, 'executionFact'))
    || snapshot.runId !== checkpoint.runId || snapshot.userId !== checkpoint.userId) {
    ctx.addIssue({ code: 'custom', message: 'Complete owned execution snapshot required' });
  }
  const initial = new Map(snapshot.actions.map(action => [action.callId, action]));
  for (const [callId, action] of Object.entries(checkpoint.actions ?? {})) {
    const source = initial.get(callId);
    if (!source || action.call_id !== callId || action.run_id !== checkpoint.runId
      || action.domain !== source.domain || action.action !== source.action
      || action.target_id !== source.targetId || action.target_name !== source.targetName) {
      ctx.addIssue({ code: 'custom', message: 'Action receipt changed its immutable identity' });
    }
  }
  if (checkpoint.stage === 'final' && (typeof checkpoint.result.success !== 'boolean'
    || !['completed', 'cancelled', 'failed', 'waiting_for_input'].includes(String(checkpoint.result.status)))) {
    ctx.addIssue({ code: 'custom', message: 'Final execution receipt required' });
  }
});
export const activeRunRecoverySnapshotSchema = z.strictObject({
  anchor: z.strictObject({ id, message_id: id, thread_id: id,
    sequence_id: z.number().int().positive().refine(Number.isSafeInteger) }),
  prior: z.strictObject({ id, message_id: id, thread_id: id,
    sequence_id: z.number().int().positive().refine(Number.isSafeInteger),
    status: z.enum(['completed', 'unknown']), response: jsonObjectSchema }),
  run: z.strictObject({ id, user_id: id, thread_id: id,
    status: z.enum(['running', 'completed', 'cancelled', 'failed', 'expired', 'waiting_for_input', 'waiting_for_approval']),
    kind: z.enum(['reminder_creation', 'entity_destructive_batch', 'task_mutation', 'generic_operation']),
    context: jsonObjectSchema, waiting_for: jsonObjectSchema.nullable(), expires_at: z.iso.datetime({ offset: true }) }),
  actions: z.array(activeRunActionSnapshotSchema).min(1).max(12),
});
export type ActiveRunCheckpoint = z.infer<typeof activeRunCheckpointSchema>;
export type ActiveRunRecoverySnapshot = z.infer<typeof activeRunRecoverySnapshotSchema>;
