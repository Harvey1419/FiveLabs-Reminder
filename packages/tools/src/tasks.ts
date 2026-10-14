import {
  taskCreateInputSchema, taskReadInputSchema, taskUpdateInputSchema, taskTargetInputSchema,
  taskResultSchema, type TaskRequest, type TaskResult, type TurnContext,
} from '@templelabs/contracts';
import type { ToolOutcome } from './index.js';
import { defineTool } from './define-tool.js';

export interface TaskDomainPort {
  execute(request: TaskRequest, context: TurnContext, operationId: string): Promise<ToolOutcome<TaskResult>>;
}

export function createTaskTools(port: TaskDomainPort) {
  return [
    defineTool({
      name: 'task_create', effect: 'write', requiredCapability: 'tasks.create',
      description: 'Create one owned task. Due time is an explicit ISO instant; project resolution and linked reminders follow existing backend rules. Report only confirmed effects.',
      inputSchema: taskCreateInputSchema, outputSchema: taskResultSchema,
      handler: (input, context, operationId) => port.execute({ operation: 'create', input }, context, operationId),
    }),
    defineTool({
      name: 'task_read', effect: 'read', requiredCapability: 'tasks.read',
      description: 'Read a bounded list of owned tasks by status, date scope, project and content. Use returned UUIDs for subsequent mutations; the list is not a complete inventory.',
      inputSchema: taskReadInputSchema, outputSchema: taskResultSchema,
      handler: (input, context, operationId) => port.execute({ operation: 'read', input }, context, operationId),
    }),
    defineTool({
      name: 'task_update', effect: 'write', requiredCapability: 'tasks.update',
      description: 'Update an owned task by observed UUID. Null description or due date removes that field. Linked reminder reconciliation can yield a partial result.',
      inputSchema: taskUpdateInputSchema, outputSchema: taskResultSchema,
      handler: (input, context, operationId) => port.execute({ operation: 'update', input }, context, operationId),
    }),
    defineTool({
      name: 'task_complete', effect: 'write', requiredCapability: 'tasks.complete',
      description: 'Complete one owned task by observed UUID after the user confirms completion. Linked reminders are acknowledged by the existing backend.',
      inputSchema: taskTargetInputSchema, outputSchema: taskResultSchema,
      handler: (input, context, operationId) => port.execute({ operation: 'complete', input }, context, operationId),
    }),
    defineTool({
      name: 'task_delete', effect: 'destructive', requiredCapability: 'tasks.delete',
      description: 'Delete one owned task by observed UUID only when authorized by the user. Linked reminder cleanup can yield a partial result.',
      inputSchema: taskTargetInputSchema, outputSchema: taskResultSchema,
      handler: (input, context, operationId) => port.execute({ operation: 'delete', input }, context, operationId),
    }),
  ] as const;
}
