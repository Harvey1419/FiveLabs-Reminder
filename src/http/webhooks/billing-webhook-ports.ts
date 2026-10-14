import { KapsoValidationError } from '../../integrations/whatsapp/kapso-errors.js';
export interface BillingUser extends Record<string, unknown> { id: string; phone_number?: string | null; locale?: string | null }
export interface BillingRow extends Record<string, unknown> { id: string }
export interface BillingResult<T> { data: T | null; error?: unknown }
export interface BillingQuery<T> extends PromiseLike<BillingResult<T[]>> {
  select(columns?: string): BillingQuery<T>;
  eq(column: string, value: unknown): BillingQuery<T>;
  or(expression: string): BillingQuery<T>;
  order(column: string, options: { ascending: boolean }): BillingQuery<T>;
  limit(count: number): BillingQuery<T>;
  update(payload: unknown): BillingQuery<T>;
  insert(payload: unknown): BillingQuery<T>;
  maybeSingle(): PromiseLike<BillingResult<T>>;
}
export interface BillingClient {
  from(table: 'users'): BillingQuery<BillingUser>;
  from(table: 'subscriptions'): BillingQuery<BillingRow>;
}
export interface StripeSession extends Record<string, unknown> {
  id?: unknown; subscription?: unknown; client_reference_id?: unknown; amount_total?: unknown;
  customer_details?: { phone?: unknown; email?: unknown } | null;
  customer_email?: unknown; metadata?: { phone?: unknown; email?: unknown } | null;
  status?: unknown; current_period_end?: number | null;
  lines?: { data?: ({ period?: { end?: number | null } | null } | null)[] | null } | null;
}
export interface BillingBody extends Record<string, unknown> {
  id?: unknown; type?: unknown; topic?: unknown;
  meta?: { event_name?: unknown; custom_data?: Record<string, unknown> | null } | null;
  data?: { id?: unknown; object?: StripeSession | null; attributes?: Record<string, unknown> | null } | null;
}
export interface BillingRequest { headers?: Readonly<Record<string, unknown>>; query?: Readonly<Record<string, unknown>>; body?: BillingBody | null; rawBody?: unknown }
export interface BillingResponse { status(code: number): BillingResponse; json(body: unknown): unknown }
export interface BillingMessagePorts {
  sendWhatsAppText(input: { phoneNumber: string; text: string }): Promise<unknown>;
  sendWhatsAppTemplate(input: { phoneNumber: string; templateName: string; parameters: string[] }): Promise<unknown>;
  logger: Pick<Console, 'log' | 'warn' | 'error'>;
}
export interface BillingStorePorts extends BillingMessagePorts {
  getClient(): BillingClient;
  normalizeUserPhone(value: unknown): string | null;
  verifySignature(req: BillingRequest): boolean;
  getNow(): Date;
  getNowMs(): number;
}
/** A returned SDK error is a failed write, not an observed subscription update. */
export async function ensureBillingWrite(operation: PromiseLike<{ error?: unknown }>): Promise<void> {
  const { error } = await operation;
  if (error) throw error;
}
/** An uncertain text outcome cannot safely be replaced by another message format. */
export function canFallbackBillingMessage(error: unknown): boolean {
  return error instanceof KapsoValidationError && error.status !== undefined && [400, 404, 422].includes(error.status);
}
