import type { JsonObject, ToolSpecification, TurnContext } from '@templelabs/contracts';

export interface ExecutionReceipt {
  readonly userId: string;
  readonly operationId: string;
  readonly toolName: string;
  readonly resourceIds: readonly string[];
}

export type ToolOutcome<Output> =
  | { readonly status: 'success' | 'partial'; readonly data: Output; readonly receipt: ExecutionReceipt; readonly observation: string }
  | { readonly status: 'validation_failed' | 'denied' | 'approval_required' | 'clarification_required' | 'failed'; readonly code: string; readonly observation: string; readonly data?: Output }
  | { readonly status: 'indeterminate'; readonly operationId: string; readonly observation: string };

/** Callers supply raw arguments; every executable tool validates at its boundary. */
export interface AgentTool<Input, Output> {
  readonly specification: ToolSpecification;
  readonly effect: 'read' | 'write' | 'destructive';
  readonly requiredCapability: string;
  parseInput(value: unknown): Input;
  parseOutput(value: unknown): Output;
  execute(input: unknown, context: TurnContext, operationId: string): Promise<ToolOutcome<Output>>;
}

export interface ToolInvocation {
  readonly callId: string;
  readonly name: string;
  readonly arguments: JsonObject;
}

export * from './define-tool.js';
export * from './registry.js';
export * from './reminders.js';
export * from './tasks.js';
export * from './calendar.js';
