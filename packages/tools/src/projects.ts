import {
  projectReadInputSchema, projectCreateInputSchema, projectRenameInputSchema, projectDeleteInputSchema,
  projectResultSchema, type ProjectRequest, type ProjectResult, type TurnContext,
} from '@templelabs/contracts';
import type { ToolOutcome } from './index.js';
import { defineTool } from './define-tool.js';

export interface ProjectDomainPort {
  execute(request: ProjectRequest, context: TurnContext, operationId: string): Promise<ToolOutcome<ProjectResult>>;
}

export function createProjectTools(port: ProjectDomainPort) {
  return [
    defineTool({
      name: 'project_read', effect: 'read', requiredCapability: 'projects.read',
      description: 'Read owned operational containers/projects with optional text query and status filter. Use returned names and IDs for task assignment or project updates.',
      inputSchema: projectReadInputSchema, outputSchema: projectResultSchema,
      handler: (input, context, operationId) => port.execute({ operation: 'read', input }, context, operationId),
    }),
    defineTool({
      name: 'project_create', effect: 'write', requiredCapability: 'projects.create',
      description: 'Create one owned project container or list. Tasks can be grouped into this project.',
      inputSchema: projectCreateInputSchema, outputSchema: projectResultSchema,
      handler: (input, context, operationId) => port.execute({ operation: 'create', input }, context, operationId),
    }),
    defineTool({
      name: 'project_rename', effect: 'write', requiredCapability: 'projects.update',
      description: 'Rename an existing owned project by name. Associated tasks and references are preserved.',
      inputSchema: projectRenameInputSchema, outputSchema: projectResultSchema,
      handler: (input, context, operationId) => port.execute({ operation: 'rename', input }, context, operationId),
    }),
    defineTool({
      name: 'project_delete', effect: 'destructive', requiredCapability: 'projects.delete',
      description: 'Delete one or more owned projects. Deleting projects with pending tasks requires user confirmation or explicit scope (e.g. no_tasks).',
      inputSchema: projectDeleteInputSchema, outputSchema: projectResultSchema,
      handler: (input, context, operationId) => port.execute({ operation: 'delete', input }, context, operationId),
    }),
  ] as const;
}
