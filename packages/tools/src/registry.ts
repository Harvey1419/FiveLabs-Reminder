import type { ToolSpecification, TurnContext } from '@templelabs/contracts';
import type { ToolOutcome } from './index.js';

export interface RegisteredTool {
  readonly specification: ToolSpecification;
  readonly effect: 'read' | 'write' | 'destructive';
  readonly requiredCapability: string;
  execute(input: unknown, context: TurnContext, operationId: string): Promise<ToolOutcome<unknown>>;
}

export class ToolRegistry {
  private readonly tools = new Map<string, RegisteredTool>();

  constructor(tools: readonly RegisteredTool[]) {
    for (const tool of tools) {
      const name = tool.specification.name;
      if (this.tools.has(name)) throw new Error(`Duplicate tool: ${name}`);
      this.tools.set(name, tool);
    }
  }

  available(context: TurnContext): readonly ToolSpecification[] {
    return [...this.tools.values()].filter(tool => context.capabilities.has(tool.requiredCapability))
      .map(tool => structuredClone(tool.specification));
  }

  effect(name: string): RegisteredTool['effect'] | undefined {
    return this.tools.get(name)?.effect;
  }

  async execute(name: string, input: unknown, context: TurnContext, operationId: string): Promise<ToolOutcome<unknown>> {
    const tool = this.tools.get(name);
    if (!tool || !context.capabilities.has(tool.requiredCapability)) {
      return { status: 'denied', code: 'TOOL_UNAVAILABLE', observation: 'This tool is not available for this turn.' };
    }
    return tool.execute(input, context, operationId);
  }
}
