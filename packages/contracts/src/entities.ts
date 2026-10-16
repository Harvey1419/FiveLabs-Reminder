import { z } from 'zod';
import { domainIssueSchema, domainPresentationSchema } from './domain-results.js';
import { jsonObjectSchema } from './provider.js';

export const entityRecordSchema = z.strictObject({
  id: z.string().max(128),
  name: z.string().trim().min(1).max(200),
  category: z.string().trim().max(100).nullable().optional(),
  metadata: jsonObjectSchema.nullable().optional(),
  status: z.enum(['active', 'deleted', 'archived']).optional(),
});
export type EntityRecord = z.infer<typeof entityRecordSchema>;

export const entityReadInputSchema = z.strictObject({
  query: z.string().trim().min(1).max(200).optional(),
  category: z.string().trim().max(100).optional(),
  limit: z.number().int().min(1).max(50).optional(),
});
export type EntityReadInput = z.infer<typeof entityReadInputSchema>;

export const entityCreateInputSchema = z.strictObject({
  name: z.string().trim().min(1).max(200),
  category: z.string().trim().max(100).optional(),
  metadata: jsonObjectSchema.optional(),
});
export type EntityCreateInput = z.infer<typeof entityCreateInputSchema>;

export const entityUpdateInputSchema = z.strictObject({
  entityId: z.string().max(128).optional(),
  oldName: z.string().trim().min(1).max(200).optional(),
  newName: z.string().trim().min(1).max(200),
  category: z.string().trim().max(100).optional(),
}).refine(val => val.entityId !== undefined || val.oldName !== undefined, {
  message: 'Either entityId or oldName is required to update/rename an entity',
});
export type EntityUpdateInput = z.infer<typeof entityUpdateInputSchema>;

export const entityMergeInputSchema = z.strictObject({
  sourceName: z.string().trim().min(1).max(200),
  targetName: z.string().trim().min(1).max(200),
  category: z.string().trim().max(100).optional(),
});
export type EntityMergeInput = z.infer<typeof entityMergeInputSchema>;

export const entityDeleteInputSchema = z.strictObject({
  name: z.string().trim().min(1).max(200).optional(),
  entityId: z.string().max(128).optional(),
  category: z.string().trim().max(100).optional(),
  scope: z.enum(['single', 'all']).optional(),
  confirmed: z.boolean().optional(),
}).refine(val => val.name !== undefined || val.entityId !== undefined, {
  message: 'Either name or entityId is required to delete an entity',
});
export type EntityDeleteInput = z.infer<typeof entityDeleteInputSchema>;

export type EntityRequest =
  | { operation: 'read'; input: EntityReadInput }
  | { operation: 'create'; input: EntityCreateInput }
  | { operation: 'update'; input: EntityUpdateInput }
  | { operation: 'merge'; input: EntityMergeInput }
  | { operation: 'delete'; input: EntityDeleteInput };

export const entityResultSchema = z.strictObject({
  operation: z.enum(['create', 'read', 'update', 'merge', 'delete']),
  entities: z.array(entityRecordSchema).max(50),
  complete: z.boolean(),
  issues: z.array(domainIssueSchema).max(10),
  presentation: domainPresentationSchema,
  requiresConfirmation: z.boolean().optional(),
  deletedCount: z.number().int().nonnegative().optional(),
  mergedCount: z.number().int().nonnegative().optional(),
  tasksMovedCount: z.number().int().nonnegative().optional(),
});
export type EntityResult = z.infer<typeof entityResultSchema>;
