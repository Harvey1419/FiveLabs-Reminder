import { z } from 'zod';
import { jsonObjectSchema } from './provider.js';
const id = z.string().min(1).max(256);
export const activeRunActionSnapshotSchema = z.strictObject({ callId: id, domain: id, action: id,
  targetId: id.nullable(), targetName: z.string().max(2000).nullable(),
  payload: jsonObjectSchema, status: z.enum(['prepared', 'executed', 'skipped', 'failed']),
  executionFact: jsonObjectSchema.nullable().optional() });
export const suspendedRunSnapshotSchema = z.strictObject({
  runId: id, userId: id, threadId: id,
  status: z.enum(['waiting_for_approval', 'waiting_for_input']),
  expiresAtIso: z.iso.datetime({ offset: true }),
  actions: z.array(activeRunActionSnapshotSchema).min(1).max(12),
  executionState: z.strictObject({ kind: z.enum(['reminder_creation', 'entity_destructive_batch', 'task_mutation', 'generic_operation']),
    context: jsonObjectSchema, waitingFor: jsonObjectSchema.nullable() }).optional(),
}).refine(run => new Set(run.actions.map(action => action.callId)).size === run.actions.length, { message: 'Prepared identities must be unique' });
const context = {
  responseLanguage: z.enum(['es', 'en']).optional(),
  profileUpdate: z.strictObject({ sourceQuote: z.string().min(1), language: z.enum(['es', 'en']).optional(),
    timezone: z.string().optional() }).optional(),
  reply: z.string().max(4000).nullable(),
};
export const approvalDecisionSchema = z.strictObject({
  ...context, relation: z.enum(['approval', 'unrelated', 'cancel', 'supersede']),
  decision: z.enum(['approve_all', 'approve_subset', 'reject']).nullable(),
  selectedCallIds: z.array(id).max(12),
}).superRefine((value, ctx) => {
  if (value.relation === 'approval' && value.decision === null
    || value.relation !== 'approval' && value.decision !== null
    || value.decision === 'approve_subset' && !value.selectedCallIds.length
    || new Set(value.selectedCallIds).size !== value.selectedCallIds.length) {
    ctx.addIssue({ code: 'custom', message: 'Invalid approval relation/selection' });
  }
});
export const continuationDecisionSchema = z.strictObject({
  ...context, relation: z.enum(['resume', 'unrelated', 'cancel', 'supersede']),
  suppliedFields: jsonObjectSchema,
  actionInputs: z.array(z.strictObject({ callId: id, fields: jsonObjectSchema })).max(12).optional(),
});
export type SuspendedRunSnapshot = z.infer<typeof suspendedRunSnapshotSchema>;
export type ApprovalDecision = z.infer<typeof approvalDecisionSchema>;
export type ContinuationDecision = z.infer<typeof continuationDecisionSchema>;
