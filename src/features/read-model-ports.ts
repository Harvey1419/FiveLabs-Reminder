/** Consumed domain projections; original SDK rows retain provider extras. */
export interface FeatureRow extends Record<string, unknown> {
  id: string; user_id?: string | null | undefined; entity_id?: string | null; project_id?: string | null; name?: string | null; title?: string | null; content?: string | null; description?: string | null; notes?: string | null;
  due_date?: string | null; completed_at?: string | null; updated_at?: string | null; send_at?: string | null;
  status?: string; phone_number?: string | null; locale?: string | null;
  entities?: { name?: string | null; category?: string | null; action?: string; eventId?: string; eventIds?: string[]; reminderId?: string; reminderIds?: string[] } | null;
  projects?: { name?: string | null } | null; delivery_id?: string | null; recurrence_rule?: string | null; acknowledged_at?: string | null;
  requires_confirmation?: boolean | null; priority?: string | null; isExisting?: boolean;
}
export interface FeatureResult { data: FeatureRow[] | null; error: { message?: string } | null }
export interface FeatureQuery extends PromiseLike<FeatureResult> {
  select(columns: string): FeatureQuery; eq(column: string, value: unknown): FeatureQuery;
  or(expression: string): FeatureQuery; gte(column: string, value: string): FeatureQuery; lt(column: string, value: string): FeatureQuery;
  lte(column: string, value: string): FeatureQuery; like(column: string, value: string): FeatureQuery;
  in(column: string, values: string[]): FeatureQuery; order(column: string, options: { ascending: boolean; nullsFirst?: boolean }): FeatureQuery;
  limit(count: number): FeatureQuery; maybeSingle(): PromiseLike<{ data: FeatureRow | null; error: { message?: string } | null }>;
}
export interface FeatureClient { from(table: 'tasks' | 'entities' | 'projects' | 'reminders' | 'users' | 'messages'): FeatureQuery }
export interface FeatureCalendarEvent extends Record<string, unknown> {
  id: string; summary?: string; title?: string; startIso?: string; start?: string | { dateTime?: string; date?: string };
  sortTimestamp?: number; type?: string; localStartTime?: string; isAllDay?: boolean; recurringEventId?: string | null;
}
export interface FeatureTimePorts {
  resolveCalendarTemporalScope: typeof import('../shared/time.js').resolveCalendarTemporalScope;
  formatLocalDateTime: typeof import('../shared/time.js').formatLocalDateTime;
}
export interface FeatureCalendarPorts {
  getUserIntegration: typeof import('../infrastructure/database/index.js').getUserIntegration;
  hasUsableGoogleCredentials: typeof import('../integrations/google/auth.js').hasUsableGoogleCredentials;
  isGoogleAuthError: typeof import('../integrations/google/auth.js').isGoogleAuthError;
  listCalendarEvents(userId: string, options: { timeMin: Date; timeMax: Date | null; timezone: string; maxResults: number; q?: string | undefined }): Promise<FeatureCalendarEvent[]>;
  normalizeCalendarEvent(event: FeatureCalendarEvent, timezone: string): FeatureCalendarEvent;
}
export interface TaskListInput { userId?: string | null; timezone?: string | null; locale?: string; language?: string; status?: string | null; scope?: string; entityId?: string | null; entityName?: string | null; query?: unknown; limit?: unknown; referenceTime?: Date | null }
export interface AgendaInput { userId?: string | null; phoneNumber?: string | null; timezone?: string | null; scope?: string; date?: string | null; dateFrom?: string | null; dateTo?: string | null; query?: string | null; language?: string }
export interface FeatureToolUser { id?: string; phone_number?: string | null; timezone?: string | null; locale?: string | null }
export interface FeatureToolInput { action?: string; params?: { status?: string; scope?: string; entityId?: string; entityName?: string; query?: string; target?: string; limit?: unknown; date?: string; dateFrom?: string; dateTo?: string }; user?: FeatureToolUser | null; language?: string; referenceTime?: Date | null }
