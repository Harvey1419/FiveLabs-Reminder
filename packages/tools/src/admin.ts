import {
  adminMetricsInputSchema, adminMetricsResultSchema,
  type AdminRequest, type AdminMetricsResult, type TurnContext,
} from '@templelabs/contracts';
import type { ToolOutcome } from './index.js';
import { defineTool } from './define-tool.js';

export interface AdminDomainPort {
  execute(request: AdminRequest, context: TurnContext, operationId: string): Promise<ToolOutcome<AdminMetricsResult>>;
}

export function createAdminTools(port: AdminDomainPort) {
  return [
    defineTool({
      name: 'admin_metrics', effect: 'read', requiredCapability: 'admin.metrics',
      description: 'Consult administrative business metrics (total users, active subscriptions, MRR, pending reminders and tasks). Restricted to admin users.',
      inputSchema: adminMetricsInputSchema, outputSchema: adminMetricsResultSchema,
      handler: (input, context, operationId) => port.execute({ operation: 'metrics', input }, context, operationId),
    }),
  ] as const;
}
