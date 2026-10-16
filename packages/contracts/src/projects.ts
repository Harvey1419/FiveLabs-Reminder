import { z } from 'zod';
import { domainIssueSchema, domainPresentationSchema } from './domain-results.js';

export const projectStatusSchema = z.enum(['active', 'archived', 'deleted']);

export const projectToolNameSchema = z.enum(['project_read', 'project_create', 'project_rename', 'project_delete']);

export const projectRecordSchema = z.strictObject({
  id: z.string().max(128),
  name: z.string().trim().min(1).max(200),
  description: z.string().trim().max(1000).nullable(),
  status: projectStatusSchema.nullable(),
  taskCount: z.number().int().nonnegative().optional(),
});
export type ProjectRecord = z.infer<typeof projectRecordSchema>;

export const projectReadInputSchema = z.strictObject({
  query: z.string().trim().min(1).max(200).optional(),
  status: z.enum(['active', 'archived', 'all']).optional(),
  limit: z.number().int().min(1).max(50).optional(),
});
export type ProjectReadInput = z.infer<typeof projectReadInputSchema>;

export const projectCreateInputSchema = z.strictObject({
  name: z.string().trim().min(1).max(200),
  description: z.string().trim().max(1000).optional(),
});
export type ProjectCreateInput = z.infer<typeof projectCreateInputSchema>;

export const projectRenameInputSchema = z.strictObject({
  oldName: z.string().trim().min(1).max(200),
  newName: z.string().trim().min(1).max(200),
});
export type ProjectRenameInput = z.infer<typeof projectRenameInputSchema>;

export const projectDeleteInputSchema = z.strictObject({
  name: z.string().trim().min(1).max(200).optional(),
  projectId: z.string().max(128).optional(),
  scope: z.enum(['single', 'no_tasks', 'all']).optional(),
  confirmed: z.boolean().optional(),
}).refine(val => val.name !== undefined || val.projectId !== undefined || val.scope === 'no_tasks' || val.scope === 'all', {
  message: 'Either name, projectId, or a bulk scope (no_tasks, all) is required',
});
export type ProjectDeleteInput = z.infer<typeof projectDeleteInputSchema>;

export type ProjectRequest =
  | { operation: 'read'; input: ProjectReadInput }
  | { operation: 'create'; input: ProjectCreateInput }
  | { operation: 'rename'; input: ProjectRenameInput }
  | { operation: 'delete'; input: ProjectDeleteInput };

export const projectResultSchema = z.strictObject({
  operation: z.enum(['create', 'read', 'rename', 'delete']),
  projects: z.array(projectRecordSchema).max(50),
  complete: z.boolean(),
  issues: z.array(domainIssueSchema).max(10),
  presentation: domainPresentationSchema,
  requiresConfirmation: z.boolean().optional(),
  deletedCount: z.number().int().nonnegative().optional(),
  deletedTaskCount: z.number().int().nonnegative().optional(),
  cancelledReminderCount: z.number().int().nonnegative().optional(),
});
export type ProjectResult = z.infer<typeof projectResultSchema>;
