import type { JsonObject } from '@templelabs/contracts';
import type { DomainPersistenceQuery } from './domain-persistence-client.js';
export { domainErrorMessage,type DomainStorageError } from './domain-persistence-client.js';
export interface UserProfileRow { id: string | null; phone_number: string; display_name?: string | null;
  timezone?: string; locale?: string; created_at?: string; updated_at?: string; is_new?: boolean; last_user_message_at?: string | null;
  is_admin?: boolean; country?: string | null; subscription?: JsonObject | null }
export interface IntegrationRow { id: string; user_id: string; provider: string; access_token: string;
  refresh_token?: string | null; token_expiry?: string | null; scopes?: string[]; account_email?: string | null;
  metadata?: JsonObject | null; updated_at?: string }
export interface UserPersistenceClient { from(table: 'users'): DomainPersistenceQuery<UserProfileRow> }
export interface IntegrationQuery extends DomainPersistenceQuery<IntegrationRow> {
  select(columns?: string): IntegrationQuery;
  eq(column: string,value: unknown): IntegrationQuery;
  not(column: string,operator: 'is',value: null): IntegrationQuery;
}
export interface IntegrationPersistenceClient { from(table: 'user_integrations'): IntegrationQuery }
