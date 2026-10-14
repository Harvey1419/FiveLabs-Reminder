import type { DomainPersistenceQuery,DomainStorageError } from './domain-persistence-client.js';
export interface MemoryRow {
  id: string;
  content: string;
  user_id?: string;
  topic_key?: string | null;
  category?: string;
  confidence?: number;
  is_active?: boolean;
  valid_from?: string | null;
  valid_until?: string | null;
  superseded_by?: string | null;
  last_accessed_at?: string | null;
  created_at?: string;
  similarity?: number;
}
export interface MemoryQuery<T> extends DomainPersistenceQuery<T> {
  select(columns?: string): MemoryQuery<T>;
  insert(payload: unknown): MemoryQuery<T>;
  update(payload: unknown): MemoryQuery<T>;
  delete(): MemoryQuery<T>;
  eq(column: string,value: unknown): MemoryQuery<T>;
  in(column: string,values: readonly string[]): MemoryQuery<T>;
  ilike(column: string,value: string): MemoryQuery<T>;
  is(column: string,value: null): MemoryQuery<T>;
  or(expression: string): MemoryQuery<T>;
  order(column: string,options: { ascending: boolean; nullsFirst?: boolean }): MemoryQuery<T>;
  limit(count: number): MemoryQuery<T>;
  not(column: string,operator: 'is',value: null): MemoryQuery<T>;
  neq(column: string,value: unknown): MemoryQuery<T>;
  textSearch(column: string,query: string,options: { config: string; type: 'websearch' }): MemoryQuery<T>;
}
export interface MemoryPersistenceClient {
  from(table: 'memories'): MemoryQuery<MemoryRow>;
  from(table: 'reminders'): MemoryQuery<{ id: string }>;
  rpc(name: 'match_memories',parameters: { p_user_id: string; p_query_embedding: number[]; p_match_threshold: number; p_match_count: number }): PromiseLike<{ data: MemoryRow[] | null; error: DomainStorageError | null }>;
}
export interface DispatchScope { requiresConfirmation: boolean; disableButtons: boolean; disableNudges: boolean; nudgeIntervalMinutes: number }
export interface DispatchPolicy {
  global: DispatchScope;
  recurring: DispatchScope;
  explicit?: { global?: Partial<DispatchScope>; recurring?: Partial<DispatchScope> };
  disableButtonsForRecurring: boolean;
  disableNudgesForRecurring: boolean;
  requiresConfirmation: boolean;
  nudgeIntervalMinutes: number;
  preferenceText?: string | null;
}
export interface MemoryPersistenceDependencies {
  isConfigured(): boolean;
  generateEmbedding(content: string,options?: { queryOwner: string }): Promise<number[] | null>;
  compileDispatchPolicy(options: { userId: string; preferences: MemoryRow[] }): Promise<DispatchPolicy>;
  reduceDispatchRules(): DispatchPolicy;
}
export interface MemoryReadOptions { userId: string; category?: string | null; limit?: number; withStatus?: boolean; throwOnError?: boolean }
export interface MemorySearchOptions extends MemoryReadOptions { query?: string | null; topicKey?: string | null }
export interface MemoryReadResult { status: 'available' | 'partial' | 'unavailable'; memories: MemoryRow[] }
export interface ForgetMemoryOptions { userId: string; topicKey?: string | null; query?: string | null; correlationId?: string | null;
  selectCandidates?: ((candidates: MemoryRow[]) => Promise<readonly string[] | null>) | null }
export interface ForgetMemoryResult { success: boolean; deletedCount: number; deletedMemories: MemoryRow[]; errorCode?: string; outcome?: 'unknown' }
