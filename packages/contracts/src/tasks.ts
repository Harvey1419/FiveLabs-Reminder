import { z } from 'zod';
import { domainIssueSchema, domainPresentationSchema, temporalScopeSchema } from './domain-results.js';

const title = z.string().trim().min(1).max(2000);
const description = z.string().trim().max(10000);
const instant = z.iso.datetime({ offset: true });
export const taskPrioritySchema = z.enum(['low', 'medium', 'high', 'urgent']);
export const taskCreateInputSchema = z.strictObject({
  title, description: description.optional(), priority: taskPrioritySchema.optional(),
  dueDateIso: instant.optional(), scheduleReminder: z.boolean().optional(),
  entityName: z.string().trim().min(1).max(200).optional(),
  entityCategory: z.enum(['project', 'person', 'company', 'place', 'asset', 'other']).optional(),
}).refine(value => value.entityCategory === undefined || value.entityName !== undefined, {
  message: 'Entity category requires an entity name',
});
export const taskReadInputSchema = z.strictObject({
  status: z.enum(['pending', 'completed', 'all']).optional(),
  scope: z.union([temporalScopeSchema, z.literal('all_pending'), z.iso.date()]).optional(),
  query: z.string().trim().min(1).max(200).optional(), entityId: z.uuid().optional(),
  entityName: z.string().trim().min(1).max(200).optional(), limit: z.number().int().min(1).max(50).optional(),
});
export const taskUpdateInputSchema = z.strictObject({
  taskId: z.uuid(), title: title.optional(), description: description.nullable().optional(),
  appendDescription: z.boolean().optional(), priority: taskPrioritySchema.optional(),
  dueDateIso: instant.nullable().optional(),
}).refine(value => value.title !== undefined || value.description !== undefined
  || value.priority !== undefined || value.dueDateIso !== undefined, { message: 'At least one update is required' })
  .refine(value => !value.appendDescription || (typeof value.description === 'string' && value.description.length > 0), {
    message: 'Appending requires a nonempty description',
  });
export const taskTargetInputSchema = z.strictObject({ taskId: z.uuid() });
export const taskRecordSchema = z.strictObject({
  id: z.uuid(), title: z.string().max(2000).nullable(),
  description: z.string().max(10000).nullable(), priority: taskPrioritySchema.nullable(),
  status: z.enum(['pending', 'completed', 'deleted']).nullable(),
  dueDateIso: instant.nullable(), entityId: z.string().max(128).nullable(),
  entityName: z.string().max(200).nullable(),
});
export const taskFlowSchema = z.strictObject({
  flowId: z.string().max(200), buttonText: z.string().max(200), flowToken: z.string().max(200),
  flowAction: z.literal('navigate'), screen: z.string().max(200), mode: z.enum(['draft', 'published']),
  data: z.strictObject({ tasks: z.array(z.strictObject({
    id: z.string().max(128), title: z.string().max(200), description: z.string().max(200),
  })).max(20) }),
});
export const taskResultSchema = z.strictObject({
  operation: z.enum(['create', 'read', 'update', 'complete', 'delete']), records: z.array(taskRecordSchema).max(50),
  complete: z.boolean(), coverage: z.enum(['operation', 'bounded_list']),
  issues: z.array(domainIssueSchema).max(10), presentation: domainPresentationSchema,
  flow: taskFlowSchema.nullable(),
});
export type TaskResult = z.infer<typeof taskResultSchema>;
export type TaskRecord = z.infer<typeof taskRecordSchema>;
export type TaskRequest =
  | { readonly operation: 'create'; readonly input: z.infer<typeof taskCreateInputSchema> }
  | { readonly operation: 'read'; readonly input: z.infer<typeof taskReadInputSchema> }
  | { readonly operation: 'update'; readonly input: z.infer<typeof taskUpdateInputSchema> }
  | { readonly operation: 'complete' | 'delete'; readonly input: z.infer<typeof taskTargetInputSchema> };

