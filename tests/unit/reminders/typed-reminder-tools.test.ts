import { describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import { createReminderOwnerTools } from '../../../src/agent/tools/reminder-owner-tools.js';
import { createReminderAdvanceTools } from '../../../src/agent/tools/reminder-advance-tools.js';
import { createFormattersTools } from '../../../src/agent/tools/formatters-tools.js';
import { createReminderCreateTools, type Dependencies as CreateDependencies } from '../../../src/agent/tools/reminder-create-tools.js';
import { createReminderBulkCancelTools } from '../../../src/agent/tools/reminder-bulk-cancel-tools.js';
import type { ReminderClient, ReminderRow } from '../../../src/agent/tools/reminder-tool-ports.js';
import * as time from '../../../src/shared/time.js';
const logger = { log: vi.fn(), warn: vi.fn(), error: vi.fn() };
const ownership = createReminderOwnerTools({ normalizePhoneNumber: value => String(value).replace(/\D/g, ''), logger });
const advance = createReminderAdvanceTools({ logger });
const cards = createFormattersTools({ ...time, stripReminderPrefix: text => String(text), logger });
const owner = { id: 'owner-1', phone_number: '+573001112233', timezone: 'America/Bogota' };
const reference = new Date('2026-10-13T17:00:00Z');
function creator(overrides: Partial<CreateDependencies> = {}) {
 const deps: CreateDependencies = {
  ...time, ...cards, ...advance, logger,
  saveReminder: async input => ({ id: 'primary', send_at: (input as { sendAt: string }).sendAt }),
  cancelPendingRemindersByContent: async () => null, createTask: async () => null,
  getUserSubscription: async () => null, hasProAccess: () => true, shouldEnforceBillingForUser: () => false,
  getReminderConfirmationPreference: async () => null, getReminderDispatchPolicy: async () => null,
  computeNextRecurringSendAt: () => null,
  resolveReminderProUpgradeContext: async () => ({ checkoutUrl: 'https://example.test/stripe', shortCheckoutUrl: '', amount: 14.99, currency: 'USD', ctaHeader: 'Pro', ctaButtonText: 'Pay', fallbackCheckoutUrl: '', provider: 'Stripe', planId: null }),
  ...overrides,
 };
 return createReminderCreateTools(deps);
}
const require = createRequire(import.meta.url);
const sdk = require('@supabase/supabase-js') as { createClient(url: string, key: string, options: unknown): ReminderClient };
function fixtureClient(rows: ReminderRow[], error = false) {
 const requests: URL[] = [];
 const client = sdk.createClient('https://offline.supabase.test', 'synthetic-key', { auth: { persistSession: false, autoRefreshToken: false }, global: { fetch: async (url: string) => {
  requests.push(new URL(url));
  return new Response(JSON.stringify(error ? { message: 'synthetic read error' } : rows), { status: error ? 500 : 200, headers: { 'Content-Type': 'application/json' } });
 } } });
 return { client, requests };
}
const row: ReminderRow = { id: 'r1', user_id: owner.id, phone_number: owner.phone_number, content: 'Cita', status: 'pending', send_at: '2026-10-13T20:00:00Z' };
function bulk(client: ReminderClient, mutate = vi.fn<(...args: unknown[]) => Promise<ReminderRow | null>>(async () => row)) {
 return { service: createReminderBulkCancelTools({ supabase: client, ...ownership, ...cards, logger, markReminderAsCancelled: mutate }), mutate };
}
describe('typed reminder operation boundaries', () => {
 it('normalizes immediate intent one second into the future without throwing', async () => {
  const save = vi.fn(async () => row);
  const result = await creator({ saveReminder: save }).executeReminderCreate({ user: owner, referenceTime: reference, params: { items: [{ content: 'Salir', targetTime: reference.toISOString() }] } });
  expect(result.success).toBe(true);
  expect(save.mock.calls[0]).toEqual([{ userId: owner.id, phoneNumber: owner.phone_number, content: 'Salir', sendAt: '2026-10-13T17:00:01.000Z', recurrenceRule: null, requiresConfirmation: false, nudgeIntervalMinutes: null, maxNudges: null, source: 'user' }]);
 });
 it('never creates a child when the primary write fails', async () => {
  const save = vi.fn(async () => null);
  const result = await creator({ saveReminder: save }).executeReminderCreate({ user: owner, referenceTime: reference, params: { items: [{ content: 'Cita', targetTime: 'PT2H', advanceMinutes: 15 }] } });
  expect(result.success).toBe(false); expect(save).toHaveBeenCalledTimes(1);
 });
 it('reports successful primary and failed child separately without replay', async () => {
  const save = vi.fn<CreateDependencies['saveReminder']>().mockResolvedValueOnce(row).mockRejectedValueOnce(new Error('offline unavailable'));
  const result = await creator({ saveReminder: save }).executeReminderCreate({ user: owner, referenceTime: reference, language: 'en', params: { items: [{ content: 'Cita', targetTime: 'PT2H', advanceMinutes: 15 }] } });
  expect(result).toMatchObject({ success: true, partialSuccess: true, complete: false });
  expect(save).toHaveBeenCalledTimes(2); expect(result.formattedCard).toContain('its advance notice could not be saved');
 });
 it('reads the confirmed elapsed scope through real SDK serialization without mutating beforehand', async () => {
  const { client, requests } = fixtureClient([row]); const { service, mutate } = bulk(client);
  const result = await service.executeBulkReminderCancellation({ user: owner, referenceTime: reference, params: { scope: 'elapsed', cutoffAt: '2026-10-12T17:00:00Z' } });
  expect(result).toMatchObject({ errorCode: 'CONFIRMATION_REQUIRED', requiresClarification: true }); expect(mutate).not.toHaveBeenCalled();
  expect(requests[0]!.searchParams.get('send_at')).toBe('lt.2026-10-12T17:00:00.000Z');
  expect(requests[0]!.searchParams.get('limit')).toBe('500');
  expect(requests[0]!.searchParams.get('or')).toContain('user_id.eq.owner-1');
  expect(requests[0]!.searchParams.get('or')).toContain('phone_number.eq.573001112233');
 });
 it('rebinds mutations to the selected row owner and reports mixed outcomes', async () => {
  const historical = { ...row, id: 'historical', user_id: 'old-user', phone_number: '573001112233' };
  const { client } = fixtureClient([row, historical]);
  const mutate = vi.fn<(...args: unknown[]) => Promise<ReminderRow | null>>().mockResolvedValueOnce(row).mockResolvedValueOnce(null);
  const { service } = bulk(client, mutate);
  const result = await service.executeBulkReminderCancellation({ user: owner, params: { scope: 'all' }, clarificationResolution: true });
  expect(mutate.mock.calls).toEqual([['r1', owner.id, null], ['historical', null, '573001112233']]);
  expect(result).toMatchObject({ success: true, partialSuccess: true, complete: false, data: { cancelledCount: 1, failedCount: 1 } });
 });
 it('fails closed on missing owner and database errors', async () => {
  const { client, requests } = fixtureClient([row], true); const { service, mutate } = bulk(client);
  expect(await service.executeBulkReminderCancellation({ params: { scope: 'all' } })).toMatchObject({ errorCode: 'ACCESS_DENIED' });
  expect(requests).toHaveLength(0);
  expect(await service.executeBulkReminderCancellation({ user: owner, params: { scope: 'all' }, clarificationResolution: true })).toMatchObject({ errorCode: 'DATABASE_ERROR' });
  expect(mutate).not.toHaveBeenCalled();
 });
 it('uses explicit parent identity before legacy content/time matching', () => {
  expect(advance.belongsToMainReminder({ ...row, id: 'notice', parent_reminder_id: 'other', content: advance.buildAdvanceNoticeContent(row.content, 15) }, row)).toBe(false);
  expect(advance.belongsToMainReminder({ ...row, id: 'notice', parent_reminder_id: row.id, content: 'changed' }, row)).toBe(true);
 });
 it('keeps linked-notice presentation order and sanitizes SQL diagnostics', () => {
  const card = cards.formatReminderCreatedCard([{ content: 'Cita', displayContent: 'Cita', isAdvanceNotice: true }, { content: 'Cita' }], 'America/Bogota', 'en');
  expect(card).toBe('✅ *Scheduled Reminders*\n\n🔔 *Advance notice: Cita*\n\n⏰ *Cita*');
  expect(cards.formatErrorCard('DATABASE_ERROR', 'duplicate key violates unique constraint private_owner', 'en')).not.toContain('private_owner');
 });
});
