import { z } from 'zod';
import { domainPresentationSchema } from './domain-results.js';

export const adminToolNameSchema = z.enum(['admin_metrics']);

export const adminMetricsInputSchema = z.strictObject({
  scope: z.enum(['overview', 'subscriptions', 'funnel', 'churn']).optional(),
});
export type AdminMetricsInput = z.infer<typeof adminMetricsInputSchema>;

export type AdminRequest = {
  operation: 'metrics';
  input: AdminMetricsInput;
};

export const adminMetricsResultSchema = z.strictObject({
  operation: z.literal('metrics'),
  scope: z.enum(['overview', 'subscriptions', 'funnel', 'churn']),
  totalUsers: z.number().int().nonnegative().optional(),
  activeSubscriptions: z.number().int().nonnegative().optional(),
  totalMRR: z.number().nonnegative().optional(),
  pendingReminders: z.number().int().nonnegative().optional(),
  pendingTasks: z.number().int().nonnegative().optional(),
  complete: z.boolean(),
  presentation: domainPresentationSchema,
});
export type AdminMetricsResult = z.infer<typeof adminMetricsResultSchema>;
