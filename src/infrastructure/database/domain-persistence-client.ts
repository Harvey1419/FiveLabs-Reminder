import type { JsonObject } from '@templelabs/contracts';
export interface DomainStorageError { readonly code?: string; readonly message?: string; readonly details?: unknown }
export interface TaskContainerRow { id: string; name: string; category?: string; status?: string; user_id?: string | undefined; description?: string | null; metadata?: JsonObject | null;
  created_at?: string | undefined; updated_at?: string | undefined; taskCount?: number }
export interface TaskRow { id: string; title: string; user_id?: string; description?: string | null;
  priority?: string; status?: string; completed_at?: string | null; created_at?: string; updated_at?: string; entity_id?: string | null; project_id?: string | null; due_date?: string | null;
  entities?: TaskContainerRow | null; projects?: TaskContainerRow | null; }
export interface MessageRow { id: string; role: 'user' | 'assistant' | 'system'; content: string;
  intent?: string | null; entities?: JsonObject | null; created_at: string; user_id?: string | null; phone_number?: string; message_id?: string | null; }
export interface ReminderPersistenceRow { id: string; content?: string; send_at?: string; status?: string; task_id?: string | null }
interface DomainRows { tasks: TaskRow; entities: TaskContainerRow; projects: TaskContainerRow;
  memories: { id: string; content: string; topic_key: string }; reminders: ReminderPersistenceRow; messages: MessageRow }
interface Result<T> { readonly data: T | null; readonly error: DomainStorageError | null }
/** Backend SDK boundary; row fields reflect each domain's consumed projections. */
export interface DomainPersistenceQuery<T> extends PromiseLike<Result<T[]>> {
  select(columns?: string): DomainPersistenceQuery<T>;
  insert(payload: unknown): DomainPersistenceQuery<T>;
  upsert(payload: unknown,options: { onConflict: string }): DomainPersistenceQuery<T>;
  update(payload: unknown): DomainPersistenceQuery<T>;
  delete(): DomainPersistenceQuery<T>;
  eq(column: string,value: unknown): DomainPersistenceQuery<T>;
  ilike(column: string,value: string): DomainPersistenceQuery<T>;
  is(column: string,value: null): DomainPersistenceQuery<T>;
  in(column: string,values: readonly string[]): DomainPersistenceQuery<T>;
  or(expression: string): DomainPersistenceQuery<T>;
  lte(column: string,value: string): DomainPersistenceQuery<T>;
  limit(count: number): DomainPersistenceQuery<T>;
  order(column: string,options: { ascending: boolean; nullsFirst?: boolean }): DomainPersistenceQuery<T>;
  single(): PromiseLike<Result<T>>;
  maybeSingle(): PromiseLike<Result<T>>;
}
export interface DomainPersistenceClient { from<K extends keyof DomainRows>(table: K): DomainPersistenceQuery<DomainRows[K]> }
export function domainErrorMessage(error: unknown): string | undefined {
  return error !== null && (typeof error === 'object' || typeof error === 'function') && 'message' in error
    && typeof error.message === 'string' ? error.message : undefined;
}
