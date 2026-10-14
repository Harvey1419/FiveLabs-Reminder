import type { FeatureClient, FeatureRow, FeatureToolUser } from '../../features/read-model-ports.js';
export interface TaskItemInput { title?: unknown; entityName?: string | null; entityCategory?: string | null; dueDate?: unknown; priority?: unknown; description?: string | null; scheduleReminder?: boolean | null }
export interface TaskPatch { title?: unknown; description?: unknown; priority?: unknown; status?: unknown; dueDate?: unknown; append?: unknown }
export interface TaskMutationInput { params?: TaskPatch & { items?: TaskItemInput[]; target?: unknown; entityName?: string | null; entityId?: string | null; updates?: TaskPatch }; user?: FeatureToolUser | null; language?: string; referenceTime?: Date | null }
export interface TaskReferenceItem { type?: string; id?: string; title?: string | null; name?: string | null; content?: string | null; description?: string | null; entities?: { name?: string | null } | null; entity_id?: string | null; internalId?: string; entityId?: string | null; entityName?: string | null; raw?: FeatureRow; summary?: string }
export interface TaskResolution { status: string; taskId?: string; task?: FeatureRow; item?: TaskReferenceItem; candidates?: TaskReferenceItem[] | undefined; entityId?: string | null; entityName?: string | null; reason?: string }
export interface TaskReferenceInput { target?: unknown; entityName?: string | null; entityId?: string | null; userId?: string | undefined; userOrPhone?: unknown; operation?: string; allowedStatuses?: string[] | null }
export interface TaskWriteError { code?: string; message?: string; technicalMessage?: string }
export interface TaskWriteResult extends Partial<FeatureRow> { data?: FeatureRow | null; error?: TaskWriteError | null; success?: boolean }
export interface TaskMutationDependencies {
 supabase: FeatureClient;
 resolveTaskTarget(input: TaskReferenceInput): Promise<TaskResolution>;
 updateTask(taskId: string, updates: Record<string, unknown>, userId: string | undefined): Promise<TaskWriteResult | null>;
 deleteTask(taskId: string, userId: string | undefined): Promise<{ error?: TaskWriteError; success?: boolean } | null>;
 completeTasksByQuery(input: Record<string, unknown>): Promise<{ completedCount?: number; error?: TaskWriteError } | null>;
 acknowledgeRemindersByTaskId(taskId: string, userId: string | undefined): Promise<{ error?: unknown } | null>;
 cancelRemindersByTaskId(taskId: string, userId: string | undefined): Promise<{ error?: unknown } | null>;
 rescheduleRemindersByTaskId(taskId: string, dueDate: unknown, userId: string | undefined): Promise<{ error?: unknown } | null>;
 normalizeTaskPriority: typeof import('../../infrastructure/database/tasks.js').normalizeTaskPriority;
 parseTargetTime: typeof import('../../shared/time.js').parseTargetTime;
 DEFAULT_TIMEZONE: string;
 createTasksBatch(input: { userId: string | undefined; items: Record<string, unknown>[] }): Promise<{ data?: FeatureRow[] | null; error?: TaskWriteError } | null>;
 findOrCreateEntityFuzzy(input: Record<string, unknown>): Promise<FeatureRow | null>;
 findOrCreateProjectFuzzy(input: Record<string, unknown>): Promise<unknown>;
 inspectOwnedEntityReferences(input: Record<string, unknown>): Promise<{ success: boolean; errorCode?: string; error?: string; resolutions: { status: string; candidates?: { name?: string }[] }[] }>;
 saveReminder(input: Record<string, unknown>): Promise<unknown>;
 getReminderConfirmationPreference(userId: string): Promise<{ nudgeIntervalMinutes?: number } | null>;
 formatErrorCard(code: string, message: string, language: string): string;
 getNowMs(): number;
 logger: Pick<Console, 'warn' | 'error'>;
}
