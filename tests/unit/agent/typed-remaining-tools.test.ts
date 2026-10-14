import { describe, expect, it, vi } from 'vitest';
import { createToolDispatch, type Dependencies as DispatchDeps } from '../../../src/agent/tools/tool-dispatch.js';
import { createSubscriptionTool, type Dependencies as BillingDeps } from '../../../src/agent/tools/subscription-tool.js';
import { createAdminTool } from '../../../src/agent/tools/admin-tool.js';
import { createReminderAcknowledgementTool, type Dependencies as AckDeps } from '../../../src/agent/tools/reminder-acknowledgement-tool.js';
import { createProjectTool, type Dependencies as ProjectDeps } from '../../../src/agent/tools/project-tool.js';
import { createEntityTool, type Dependencies as EntityDeps } from '../../../src/agent/tools/entity-tool.js';
import { normalizeReminderQuery } from '../../../src/agent/contracts/reminder-query-contract.js';
import { computeNextRecurringSendAt, isIntradayRecurrence } from '../../../src/shared/reminder-recurrence-policy.js';
import { TOOL_NAMES } from '../../../src/agent/contracts/tool-names.js';
import type { ToolHandler } from '../../../src/agent/tools/remaining-tool-ports.js';
const logger = { log: vi.fn(), warn: vi.fn(), error: vi.fn() };
function dispatcher(handler: ToolHandler, lease = vi.fn(async () => undefined)) {
 const names = ['executeReminderCreate','executeReminderUpdate','executeReminderReadTool','executeSingleReminderCancellation','executeBulkReminderCancellation','executeReminderAcknowledgement','executeTaskCreate','executeTaskComplete','executeTaskUpdate','executeTaskDelete','executeTaskReadTool','executeEntityTool','executeProjectTool','executeMemoryTool','executeSubscriptionTool','executeCalendarTool','executeAdminTool','executeUnifiedAgendaTool'];
 const deps = { ...Object.fromEntries(names.map(name => [name, handler])), TOOL_NAMES, assertTurnLease: lease, formatErrorCard: (_code: string, message: unknown) => String(message), logger } as unknown as DispatchDeps;
 return createToolDispatch(deps);
}
describe('typed remaining tools and dispatch contracts', () => {
 it('checks lease before dispatch and does not swallow lost authority', async () => {
  const handle = vi.fn<ToolHandler>(); const lease = vi.fn(async () => { throw new Error('lease lost'); });
  await expect(dispatcher(handle, lease).executeTool({ toolName: TOOL_NAMES.MANAGE_TASK })).rejects.toThrow('lease lost'); expect(handle).not.toHaveBeenCalled();
 });
 it('keeps thrown writes unknown and never repeats the domain call', async () => {
  const handle = vi.fn<ToolHandler>().mockRejectedValue(new Error('socket after possible commit'));
  const result = await dispatcher(handle).executeTool({ toolName: TOOL_NAMES.MANAGE_TASK, params: { action: 'create' }, language: 'en' });
  expect(result).toMatchObject({ outcome: 'unknown', complete: false, errorCode: 'WRITE_OUTCOME_UNKNOWN' }); expect(handle).toHaveBeenCalledTimes(1); expect(result.rawSummary).not.toContain('socket');
 });
 it('keeps explicit unknown receipts without converting them into success', async () => {
  const result = await dispatcher(async () => ({ success: true, outcome: 'unknown', data: { receipts: ['observed'] } })).executeTool({ toolName: TOOL_NAMES.MANAGE_PROJECT });
  expect(result).toMatchObject({ success: false, outcome: 'unknown', complete: false, data: { receipts: ['observed'] } });
 });
 it('preserves positional calls and removes echoed calendar target only from update patch', async () => {
  const handle = vi.fn<ToolHandler>().mockResolvedValue({ success: true, rawSummary: 'Done' }); const service = dispatcher(handle);
  const params = { action: 'update_event', target: 'Appointment', summary: 'Appointment' };
  await service.executeTool(TOOL_NAMES.MANAGE_GOOGLE_CALENDAR, params, { id: 'owner', locale: 'en-US' });
  expect(handle.mock.calls[0]![0]).toMatchObject({ language: 'en', params: { target: 'Appointment' } }); expect(handle.mock.calls[0]![0].params).not.toHaveProperty('summary'); expect(params.summary).toBe('Appointment');
 });
 it('does not classify unavailable reads as uncertain writes', async () => {
  const result = await dispatcher(async () => { throw new Error('read unavailable'); }).executeTool({ toolName: TOOL_NAMES.MANAGE_TASK, params: { action: 'list' } });
  expect(result).toMatchObject({ errorCode: 'UNEXPECTED_EXCEPTION', complete: false }); expect(result).not.toHaveProperty('outcome');
 });
 it('keeps informational billing free of checkout and uses supplied null entitlement', async () => {
  const checkout = vi.fn(() => 'https://stripe.test/pay'); const subscription = vi.fn(async () => null);
  const service = createSubscriptionTool({ logger, getUserSubscription: subscription, hasProAccess: () => false, cancelUserSubscription: async () => ({ success: true }), selectReminderProProvider: () => 'Stripe', resolveReminderProUpgradeContext: vi.fn(), buildStripeCheckoutUrl: checkout } as BillingDeps);
  expect(await service.executeSubscriptionTool({ action: 'info', user: { id: 'owner', subscription: null } })).toMatchObject({ success: true, data: { provider: 'Stripe', paymentOutcome: null } });
  expect(checkout).not.toHaveBeenCalled();
  expect(await service.executeSubscriptionTool({ action: 'info', params: { scope: 'plan' }, user: { id: 'owner', subscription: null } })).toMatchObject({ ctaUrl: 'https://stripe.test/pay' }); expect(subscription).not.toHaveBeenCalled();
 });
 it('rejects non-admin before reading any metric', async () => {
  const from = vi.fn(); const service = createAdminTool({ supabase: { from }, isAdminUser: () => false, logger });
  expect(await service.executeAdminTool({ action: 'get_overview', user: { id: 'owner' } })).toMatchObject({ errorCode: 'AUTHORIZATION_ERROR' }); expect(from).not.toHaveBeenCalled();
 });
 it('does not acknowledge a foreign authoritative reminder or switch to fuzzy candidates', async () => {
  const acknowledge = vi.fn(); const maybeSingle = vi.fn(async () => ({ data: { id: 'foreign', user_id: 'another' }, error: null }));
  const query = { select: () => query, eq: () => query, neq: () => query, maybeSingle };
  const service = createReminderAcknowledgementTool({ supabase: { from: () => query }, buildReminderOwnerContext: () => ({ userId: 'owner', phoneNumber: null, phoneVariants: [], hasOwner: true }), scopeReminderQueryToOwner: (q: Parameters<AckDeps['scopeReminderQueryToOwner']>[0]) => q, isReminderOwned: (row: Parameters<AckDeps['isReminderOwned']>[0]) => row?.user_id === 'owner', acknowledgeReminder: acknowledge, logger } as unknown as AckDeps);
  expect(await service.executeReminderAcknowledgement({ params: { reminderId: 'foreign', target: 'anything' } })).toMatchObject({ errorCode: 'NOT_FOUND' }); expect(acknowledge).not.toHaveBeenCalled(); expect(maybeSingle).toHaveBeenCalledTimes(1);
 });
 it('keeps project deletion preview IDs in the proposed confirmed operation', async () => {
  const remove = vi.fn(async () => ({ success: true, projects: [{ id: 'p1', name: 'Alpha' }], pendingTaskCount: 2, activeReminderCount: 1, preservedCompletedTaskCount: 3 }));
  const service = createProjectTool({ deleteProjects: remove, logger } as unknown as ProjectDeps);
  const result = await service.executeProjectTool({ action: 'delete', params: { target: 'Alpha' }, user: { id: 'owner' } });
  expect(remove.mock.calls[0]).toEqual([{ userId: 'owner', targetName: 'Alpha', targetNames: null, scope: 'single', preserveNames: [], dryRun: true, projectIds: null }]);
  expect(result).toMatchObject({ errorCode: 'CONFIRMATION_REQUIRED', pendingClarifications: [{ proposedOperation: { projectIds: ['p1'] } }] });
 });
 it('keeps incomplete entity cascades unknown', async () => {
  const mutate = vi.fn(async () => ({ success: false, outcome: 'unknown', tasksMovedCount: 2 }));
  const service = createEntityTool({ renameEntityCascade: mutate, logger } as unknown as EntityDeps);
  expect(await service.executeEntityTool({ action: 'rename', params: { oldName: 'A', newName: 'B' }, user: { id: 'owner' }, language: 'en' })).toMatchObject({ success: false, outcome: 'unknown', complete: false, partialSuccess: true }); expect(mutate).toHaveBeenCalledTimes(1);
 });
 it('escapes literal search wildcards and rejects PostgREST star aliases', () => {
  expect(normalizeReminderQuery('  50%_\\  ')).toMatchObject({ valid: true, value: '50%_\\', pattern: '%50\\%\\_\\\\%' });
  expect(normalizeReminderQuery('*', 'en')).toMatchObject({ valid: false, errorCode: 'INVALID_QUERY' });
  expect(normalizeReminderQuery(undefined)).toEqual({ valid: true, value: undefined });
 });
 it('keeps recurrence fallback and terminates non-advancing intervals', () => {
  const date = new Date('2099-10-13T12:00:00Z');
  expect(computeNextRecurringSendAt(date, 'legacy-unknown', date)?.toISOString()).toBe('2099-10-14T12:00:00.000Z');
  expect(computeNextRecurringSendAt(date, 'hourly:-1', date)).toBeNull();
  expect(isIntradayRecurrence(' interval:30m ')).toBe(true);
 });
});
