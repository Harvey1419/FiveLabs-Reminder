export type ReminderDate = string | number | Date;
export interface ReminderRow extends Record<string, unknown> {
  id: string;
  content: string;
  status: string;
  user_id?: string | null;
  phone_number?: string | null;
  send_at?: ReminderDate | null;
  sent_at?: ReminderDate | null;
  last_nudged_at?: ReminderDate | null;
  acknowledged_at?: ReminderDate | null;
  completed_at?: ReminderDate | null;
  requires_confirmation?: boolean | null;
  nudge_interval_minutes?: number | null;
  max_nudges?: number | null;
  nudge_count?: number | null;
  delivery_id?: string | null;
  task_id?: string | null;
  title?: string | null;
  due_date?: ReminderDate | null;
  description?: string | null;
  recurrence_rule?: string | null;
  project_id?: string | null;
  entities?: { name?: string | null; category?: string | null } | null;
  projects?: { id?: string | null; name?: string | null } | null;
}
export interface ReminderStorageError { code?: string; message?: string }
export interface ReminderResult<T> { data: T | null; error: ReminderStorageError | null }
/** Exact query shape consumed by legacy reminders; this port adds no new authorization. */
export interface ReminderQuery extends PromiseLike<ReminderResult<ReminderRow[]>> {
  select(columns?: string): ReminderQuery;
  insert(payload: unknown): ReminderQuery;
  update(payload: unknown): ReminderQuery;
  eq(column: string, value: unknown): ReminderQuery;
  neq(column: string, value: unknown): ReminderQuery;
  is(column: string, value: null): ReminderQuery;
  in(column: string, values: readonly string[]): ReminderQuery;
  ilike(column: string, value: string): ReminderQuery;
  or(expression: string): ReminderQuery;
  lte(column: string, value: unknown): ReminderQuery;
  limit(count: number): ReminderQuery;
  order(column: string, options: { ascending: boolean }): ReminderQuery;
  single(): PromiseLike<ReminderResult<ReminderRow>>;
  maybeSingle(): PromiseLike<ReminderResult<ReminderRow>>;
}
export interface ReminderClient {
  from(table: 'reminders' | 'tasks'): ReminderQuery;
  rpc(name: 'claim_next_pending_reminder', params: { p_worker_id: string; p_lock_duration_sec: number }): PromiseLike<ReminderResult<ReminderRow[]>>;
}
export interface ReminderDependencies {
  getClient(): ReminderClient;
  getNow(): Date;
  getNowMs(): number;
  assertTurnLease(): Promise<void>;
  isStrictUUID(value: string): boolean;
  formatLocalDateTime(value: Date, timezone: string, locale: string): string;
  logger: Pick<Console, 'log' | 'warn' | 'error'>;
}
export interface OwnerInput { userId?: string | null; phoneNumber?: string | null }
export interface SaveReminderInput extends OwnerInput {
  content: string;
  sendAt: ReminderDate;
  taskId?: string | null;
  deliveryId?: string | null;
  parentReminderId?: string | null;
  recurrenceRule?: string | null;
  requiresConfirmation?: unknown;
  nudgeIntervalMinutes?: unknown;
  maxNudges?: unknown;
  source?: string | null;
}
export interface CalendarCompanionInput { userId?: string | null; eventId?: string | null; summary?: string | null }
export interface CalendarRescheduleInput extends CalendarCompanionInput { newStartDateTime?: ReminderDate | null; advanceMinutes?: unknown }
export interface OverviewItem {
  id: string;
  content: string | null | undefined;
  title: string | null | undefined;
  localDate: string | null;
  localTime: string | null;
  localFormatted: string;
  recurrenceRule: string | null;
  status: string;
  description: string | null;
  isTask: boolean;
  entityName: string | null;
  entityCategory: string | null;
  nudgeCount?: number;
  maxNudges?: number;
  lastNotificationAt?: ReminderDate | null;
}
