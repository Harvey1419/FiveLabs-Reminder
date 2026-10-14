/** Fields consumed at the remaining domain tool and dispatch boundaries. */
export interface ToolUser { id?: string; phone_number?: string; timezone?: string; locale?: string; country?: string; isPro?: boolean; is_admin?: boolean; subscription?: unknown }
export interface ToolParams extends Record<string, unknown> { action?: string; scope?: string; target?: string; summary?: string }
export interface DomainParams extends ToolParams {
 name?: string; category?: string | null; metadata?: Record<string, unknown>; description?: string;
 oldName?: string; newName?: string; sourceName?: string; targetName?: string; targetNames?: string[];
 projectIds?: string[]; entityIds?: string[]; preserveNames?: string[]; filter?: string;
 query?: string | null; status?: string; limit?: number; userId?: string; phoneNumber?: string; phone?: string;
}
export interface DomainInput { action?: string; params?: DomainParams; user?: ToolUser | null; language?: string; clarificationResolution?: boolean }
export interface DomainRow extends Record<string, unknown> { id: string; name: string }
export interface EntityMutationResult extends Record<string, unknown> { success?: boolean; errorCode?: string; error?: string; complete?: boolean; partialSuccess?: boolean; outcome?: string; tasksMovedCount?: number; mergedCount?: number }
export interface DeletionResult extends EntityMutationResult { projects: DomainRow[]; pendingTaskCount: number; preservedCompletedTaskCount: number; activeReminderCount: number; deletedCount?: number; deletedTaskCount?: number; cancelledReminderCount?: number }
export interface EntityDeletionResult extends EntityMutationResult { entities: DomainRow[]; pendingTaskCount: number; preservedCompletedTaskCount: number; activeReminderCount: number }
export interface SubscriptionRow extends Record<string, unknown> { plan?: string | null; status?: string | null }
export interface MetricsQuery extends PromiseLike<{ count?: number | null; data?: { amount?: unknown }[] | null; error?: unknown }> {
 select(columns: string, options?: { count: 'exact'; head: boolean }): MetricsQuery;
 eq(column: string, value: unknown): MetricsQuery; order(column: string, options: { ascending: boolean }): MetricsQuery;
}
export interface MetricsClient { from(table: string): MetricsQuery }
export interface ToolResult {
 success: boolean; action?: string; errorCode?: string; error?: string; rawSummary?: string; formattedCard?: string;
 confirmation?: string; data?: unknown; outcome?: string; partialSuccess?: boolean; complete?: boolean;
 isProFeature?: boolean; ctaUrl?: string | null; ctaHeader?: string | null; ctaButtonText?: string | null;
 flow?: unknown; requiresClarification?: boolean; pendingClarifications?: unknown;
}
export interface ToolOptions { toolName?: string; action?: string; params?: ToolParams; user?: ToolUser | null; isPro?: boolean; language?: string; correlationId?: string | null; referenceTime?: Date | string | number | null; clarificationResolution?: boolean; memoryTurn?: unknown }
export type ToolHandler = (input: ToolOptions) => Promise<ToolResult>;
/** Compatibility names consumed by the agent-core domain adapters. */
export interface LegacyToolUser extends ToolUser { id: string }
export interface LegacyToolRequest extends ToolOptions { toolName: string; params: import('@templelabs/contracts').JsonObject; user: LegacyToolUser }
