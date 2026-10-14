import { z } from 'zod';
import { jsonObjectSchema, type TurnContext } from '@templelabs/contracts';
import type { AgentTool, ToolOutcome } from './index.js';

interface ToolDefinition<Input, Output> {
  readonly name: string;
  readonly description: string;
  readonly effect: AgentTool<Input, Output>['effect'];
  readonly requiredCapability: string;
  readonly inputSchema: z.ZodType<Input>;
  readonly outputSchema: z.ZodType<Output>;
  readonly handler: (input: Input, context: TurnContext, operationId: string) => Promise<ToolOutcome<Output>>;
}

const metadataSchema = z.strictObject({
  userId: z.string().trim().min(1), runId: z.string().trim().min(1), requestId: z.string().trim().min(1),
  language: z.enum(['es', 'en']), timezone: z.string().min(1), referenceTimeIso: z.iso.datetime({ offset: true }),
});

export function defineTool<Input, Output>(definition: ToolDefinition<Input, Output>): AgentTool<Input, Output> {
  return {
    specification: {
      name: definition.name, description: definition.description,
      inputSchema: jsonObjectSchema.parse(z.toJSONSchema(definition.inputSchema, { io: 'input' })),
    },
    effect: definition.effect,
    requiredCapability: definition.requiredCapability,
    parseInput: value => definition.inputSchema.parse(value),
    parseOutput: value => definition.outputSchema.parse(value),
    async execute(rawInput, context, operationId) {
      if (!operationId.trim() || !context.capabilities.has(definition.requiredCapability)) {
        return { status: 'denied', code: 'ACCESS_DENIED', observation: 'Required execution capability or identity is missing.' };
      }
      const metadata = metadataSchema.safeParse({
        userId: context.userId, runId: context.runId, requestId: context.requestId,
        language: context.language, timezone: context.timezone, referenceTimeIso: context.referenceTimeIso,
      });
      if (!metadata.success) return { status: 'validation_failed', code: 'INVALID_TURN_CONTEXT', observation: 'Trusted turn metadata is incomplete or invalid.' };
      if (context.signal.aborted) return { status: 'failed', code: 'CANCELLED', observation: 'Cancelled before execution; no action was dispatched.' };
      const input = definition.inputSchema.safeParse(rawInput);
      if (!input.success) {
        const fields = input.error.issues.map(issue => ({ path: issue.path.join('.'), code: issue.code }));
        return { status: 'validation_failed', code: 'INVALID_ARGUMENTS', observation: JSON.stringify({ error: 'Invalid arguments', fields }) };
      }
      try {
        const outcome = await definition.handler(input.data, context, operationId);
        if ('receipt' in outcome && (outcome.receipt.userId !== context.userId
          || outcome.receipt.operationId !== operationId || outcome.receipt.toolName !== definition.name)) {
          throw new Error('Receipt identity mismatch');
        }
        if ('data' in outcome) {
          const data = definition.outputSchema.parse(outcome.data);
          return { ...outcome, data };
        }
        return outcome;
      } catch {
        // A handler/output failure after a write may conceal a committed effect.
        return definition.effect === 'read'
          ? { status: 'failed', code: 'TOOL_EXECUTION_ERROR', observation: 'The read result could not be verified.' }
          : { status: 'indeterminate', operationId, observation: 'The action outcome could not be verified. Reconcile before retrying.' };
      }
    },
  };
}
