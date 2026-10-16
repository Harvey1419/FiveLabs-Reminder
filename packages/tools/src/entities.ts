import {
  entityReadInputSchema, entityCreateInputSchema, entityUpdateInputSchema,
  entityMergeInputSchema, entityDeleteInputSchema, entityResultSchema,
  type EntityRequest, type EntityResult, type TurnContext,
} from '@templelabs/contracts';
import type { ToolOutcome } from './index.js';
import { defineTool } from './define-tool.js';

export interface EntityDomainPort {
  execute(request: EntityRequest, context: TurnContext, operationId: string): Promise<ToolOutcome<EntityResult>>;
}

export function createEntityTools(port: EntityDomainPort) {
  return [
    defineTool({
      name: 'entity_read', effect: 'read', requiredCapability: 'entities.read',
      description: 'Read or search owned entities, contacts, categories or custom lists with optional query and category filter.',
      inputSchema: entityReadInputSchema, outputSchema: entityResultSchema,
      handler: (input, context, operationId) => port.execute({ operation: 'read', input }, context, operationId),
    }),
    defineTool({
      name: 'entity_create', effect: 'write', requiredCapability: 'entities.create',
      description: 'Create or register an owned entity, contact, category or list.',
      inputSchema: entityCreateInputSchema, outputSchema: entityResultSchema,
      handler: (input, context, operationId) => port.execute({ operation: 'create', input }, context, operationId),
    }),
    defineTool({
      name: 'entity_update', effect: 'write', requiredCapability: 'entities.update',
      description: 'Rename or update an existing entity by name or entityId.',
      inputSchema: entityUpdateInputSchema, outputSchema: entityResultSchema,
      handler: (input, context, operationId) => port.execute({ operation: 'update', input }, context, operationId),
    }),
    defineTool({
      name: 'entity_merge', effect: 'write', requiredCapability: 'entities.update',
      description: 'Merge a source entity into a target entity, repointing all connected tasks and records.',
      inputSchema: entityMergeInputSchema, outputSchema: entityResultSchema,
      handler: (input, context, operationId) => port.execute({ operation: 'merge', input }, context, operationId),
    }),
    defineTool({
      name: 'entity_delete', effect: 'destructive', requiredCapability: 'entities.delete',
      description: 'Delete an owned entity. Requires user confirmation when linked records exist.',
      inputSchema: entityDeleteInputSchema, outputSchema: entityResultSchema,
      handler: (input, context, operationId) => port.execute({ operation: 'delete', input }, context, operationId),
    }),
  ] as const;
}
