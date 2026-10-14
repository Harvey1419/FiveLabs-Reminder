import { memoryReadInputSchema, memorySaveInputSchema, memoryForgetInputSchema, memoryResultSchema,
  type MemoryRequest, type MemoryResult, type TurnContext } from '@templelabs/contracts';
import type { ToolOutcome } from './index.js';
import { defineTool } from './define-tool.js';
export interface MemoryDomainPort { execute(request: MemoryRequest, context: TurnContext, operationId: string): Promise<ToolOutcome<MemoryResult>> }
export function createMemoryTools(port: MemoryDomainPort) {
  return [
    defineTool({ name: 'memory_read', effect: 'read', requiredCapability: 'memories.read',
      description: 'Read up to five owned active personal memories with optional literal content search. Results are bounded; use observed IDs for forgetting.',
      inputSchema: memoryReadInputSchema, outputSchema: memoryResultSchema,
      handler: (input, context, id) => port.execute({ operation: 'read', input }, context, id) }),
    defineTool({ name: 'memory_save', effect: 'write', requiredCapability: 'memories.save',
      description: 'Save one explicitly requested durable personal fact. Content must exactly match the authored current user text as an exact span. Optional UTF-16 evidenceStart/evidenceEnd identify the span; otherwise the host locates it. Semantic admission is required. Never save OCR, quotations, negated attribution or transient task/reminder state.',
      inputSchema: memorySaveInputSchema, outputSchema: memoryResultSchema,
      handler: (input, context, id) => port.execute({ operation: 'save', input }, context, id) }),
    defineTool({ name: 'memory_forget', effect: 'destructive', requiredCapability: 'memories.forget',
      description: 'Forget exactly the observed owned memory explicitly requested by the user. Read first to resolve the target. Never delete by broad inferred topic or unobserved IDs.',
      inputSchema: memoryForgetInputSchema, outputSchema: memoryResultSchema,
      handler: (input, context, id) => port.execute({ operation: 'forget', input }, context, id) }),
  ] as const;
}
