/** Consumed reminder domain shapes; adapters retain unprojected row fields. */
export interface CardRow {
 internalId?: string; summary?: string; time?: string | null; localTime?: string | null;
 id?: string | undefined; content?: string | null | undefined; title?: string | null | undefined;
 send_at?: string | null | undefined; sendAt?: string | null | undefined; formattedTime?: string | null | undefined;
 displayContent?: string | null | undefined; isAdvanceNotice?: boolean; recurrence_rule?: string | null | undefined;
 recurrenceRule?: string | null | undefined; requires_confirmation?: boolean; requiresConfirmation?: boolean;
 acknowledged_at?: string | null; acknowledgedAt?: string | null; entityName?: string | null;
 entities?: { name?: string | null } | null; name?: string | null; category?: string | null;
 completedCount?: number; dueDate?: string | null; due_date?: string | null; priority?: string | null;
}
export interface ReminderRow extends CardRow {
 id: string; send_at: string; status?: string | null; user_id?: string | null;
 phone_number?: string | null; delivery_id?: string | null; source?: string | null;
 parent_reminder_id?: string | null; created_at?: string | null;
}
export interface ReminderOwner { userId: string | null; phoneNumber: string | null; phoneVariants: string[]; hasOwner: boolean }
export interface ReminderQueryResult { data: ReminderRow[] | null; error: { message?: string } | null }
export interface ReminderQuery extends PromiseLike<ReminderQueryResult> {
 select(columns?: string): ReminderQuery; eq(column: string, value: unknown): ReminderQuery;
 neq(column: string, value: unknown): ReminderQuery; in(column: string, values: unknown[]): ReminderQuery;
 or(filter: string): ReminderQuery; is(column: string, value: unknown): ReminderQuery;
 not(column: string, operator: string, value: unknown): ReminderQuery;
 lt(column: string, value: unknown): ReminderQuery; gte(column: string, value: unknown): ReminderQuery;
 ilike(column: string, value: unknown): ReminderQuery;
 textSearch(column: string, value: string, options: { type: string; config: string }): ReminderQuery;
 order(column: string, options: { ascending: boolean }): ReminderQuery; limit(count: number): ReminderQuery;
 update(patch: Record<string, unknown>): ReminderQuery;
 maybeSingle(): PromiseLike<{ data: ReminderRow | null; error: { message?: string } | null }>;
}
export interface ReminderClient { from(table: string): ReminderQuery }
export interface ReminderItem {
 content?: string; targetTime?: string; advanceMinutes?: number | null; advanceNoticeTime?: string | null;
 recurrence?: string | null; recurrenceRule?: string | null; requiresConfirmation?: boolean | null;
 nudgeIntervalMinutes?: number | null; maxNudges?: number | null; replacePending?: boolean;
 checklist?: (string | { title?: string })[] | null;
}
export interface ReminderToolInput {
 params?: { items?: ReminderItem[]; target?: unknown; updates?: ReminderItem; query?: unknown; filter?: string;
 scope?: string; cutoffAt?: string | null; advanceMinutes?: number; deliveryPolicy?: { advanceNotice: string; advanceMinutes?: number | null } | null };
 user?: { id?: string; phone_number?: string; timezone?: string; locale?: string; country?: string; subscription?: unknown; is_admin?: boolean } | null;
 language?: string; isPro?: boolean; referenceTime?: Date | string | number | null;
 correlationId?: string | null; clarificationResolution?: boolean;
}
export interface ReminderResolution { status: string; item?: (CardRow & { internalId?: string; raw?: ReminderRow }) | null; candidates?: (CardRow & { internalId?: string; time?: string | null; localTime?: string | null })[] }
export interface DispatchPolicy { global?: { requiresConfirmation?: boolean; nudgeIntervalMinutes?: number }; recurring?: { requiresConfirmation?: boolean; nudgeIntervalMinutes?: number } }
export interface RejectedReminder extends ReminderItem {
 type: string; code: string; reason: string; question?: string; proFeature?: string; sourceTimeText?: string;
 formattedTime?: string; proposedReminder?: unknown;
}
export interface CreatedReminder extends CardRow { parentReminderId?: string }
export interface CardOutcome { created?: CreatedReminder[]; rejected?: RejectedReminder[];
 proUpgrade?: { checkoutUrl?: string; shortCheckoutUrl?: string; fallbackCheckoutUrl?: string; amount?: number; currency?: string; provider?: string } | null }
export interface EntityDeletion { deletedCount?: number; entities?: CardRow[] | null; deletedTaskCount?: number; cancelledReminderCount?: number; preservedCompletedTaskCount?: number; reminderCleanupError?: unknown; taskCleanupError?: unknown }
