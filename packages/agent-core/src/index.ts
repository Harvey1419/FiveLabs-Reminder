import type { EngineVersion } from '@templelabs/contracts';

export interface EngineRoutingPolicy {
  readonly enabled: boolean;
  readonly userIds: ReadonlySet<string>;
}

/** Pin active runs; a rollback changes admission, not execution ownership. */
export function selectEngine(
  authenticatedUserId: string,
  policy: EngineRoutingPolicy,
  activeRunEngine?: EngineVersion,
): EngineVersion {
  if (!authenticatedUserId.trim()) throw new Error('Authenticated user ID is required');
  if (activeRunEngine) return activeRunEngine;
  return policy.enabled && policy.userIds.has(authenticatedUserId) ? 'v2' : 'legacy';
}

export interface TurnLimits {
  readonly maxModelSteps: number;
  readonly maxToolCalls: number;
  readonly deadlineMs: number;
  readonly maxTotalTokens: number;
  readonly maxCostUsd: number;
}

export type { AIProvider, CompletionRequest } from '@templelabs/ai';
export type { AgentTool, ExecutionReceipt, ToolOutcome } from '@templelabs/tools';
export * from './reminder-turn.js';
export * from './context-manager.js';
export * from './operational-context.js';
export * from './agent-loop.js';
export * from './productivity-turn.js';
