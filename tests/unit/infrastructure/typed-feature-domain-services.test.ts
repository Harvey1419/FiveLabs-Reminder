import { createRequire } from 'node:module';
import { describe, expect, it, vi } from 'vitest';
import { createTaskReadService, type Dependencies as TaskDependencies } from '../../../src/features/tasks/task-read-service.js';
import { createAgendaReadService, type Dependencies as AgendaDependencies } from '../../../src/features/agenda/agenda-read-service.js';
import { createCalendarReconciliation, type Dependencies as ReconciliationDependencies } from '../../../src/features/calendar/calendar-reconciliation.js';
import { createTaskTargetResolution } from '../../../src/agent/tools/task-target-resolution.js';
import { createTaskCreateTool } from '../../../src/agent/tools/task-create-tool.js';
import { createTaskUpdateTool } from '../../../src/agent/tools/task-update-tool.js';
import type { TaskMutationDependencies } from '../../../src/agent/tools/task-tool-ports.js';
import * as time from '../../../src/shared/time.js';
import { parseTaskScope, normalizeAgendaScope, isAllPendingScope } from '../../../src/shared/agenda-scopes.js';
const { createClient } = createRequire(import.meta.url)('@supabase/supabase-js');
const now = new Date('2026-10-13T11:00:00Z'); const owner = 'owner';
function sdk(rows: Record<string, unknown[]>, failures: string[] = []) {
  const calls: URL[] = [];
  const client = createClient('https://synthetic.supabase.co', 'synthetic', { auth: { persistSession: false, autoRefreshToken: false }, global: { fetch: async (url: string) => { const parsed = new URL(String(url)); calls.push(parsed); const table = parsed.pathname.split('/').at(-1)!; return new Response(JSON.stringify(failures.includes(table) ? { message: 'synthetic failed' } : rows[table] || []), { status: failures.includes(table) ? 500 : 200, headers: { 'Content-Type': 'application/json' } }); } } });
  return { client, calls };
}
const logger = { error: vi.fn(), warn: vi.fn(), log: vi.fn() };
const temporal = { resolveCalendarTemporalScope: time.resolveCalendarTemporalScope, formatLocalDateTime: time.formatLocalDateTime };
function taskService(client: unknown) { return createTaskReadService({ ...temporal, supabase: client, parseTaskScope, selectEntityCandidate: () => ({ status: 'NOT_FOUND', candidates: [] }), getNow: () => now, logger } as TaskDependencies); }
function agendaService(client: unknown, connected = false) { return createAgendaReadService({ ...temporal, supabase: client, normalizeAgendaScope, isAllPendingScope, getUserIntegration: async () => null, hasUsableGoogleCredentials: () => connected, isGoogleAuthError: () => false, listCalendarEvents: async () => [], normalizeCalendarEvent: event => event, getNow: () => now, logger } as AgendaDependencies); }
describe('typed read models with real SDK and synthetic transport', () => {
  it('avoids any task query without a user and bounds owned task reads', async () => {
    const f = sdk({ tasks: [{ id: 'task', title: 'Comprar cafés', description: 'Café especial', status: 'pending', due_date: null }] }); const service = taskService(f.client);
    expect((await service.getTaskList({ userId: null })).tasks).toEqual([]); expect(f.calls).toHaveLength(0);
    const result = await service.getTaskList({ userId: owner, limit: 1000, query: 'cafes' }); expect(result.tasks).toHaveLength(1); expect(f.calls[0]!.searchParams.get('user_id')).toBe('eq.owner'); expect(f.calls[0]!.searchParams.get('limit')).toBe('100'); expect(result.items[0]).toMatchObject({ position: 1, internalId: 'task', entityName: null });
  });
  it('uses completion dates and preserves dateless-task inclusion for all pending scope', async () => {
    const f = sdk({ tasks: [] }); const service = taskService(f.client); await service.getTaskList({ userId: owner, status: 'completed', scope: 'today', referenceTime: now }); expect(f.calls[0]!.searchParams.get('completed_at')).toContain('gte.'); expect(f.calls[0]!.searchParams.has('due_date')).toBe(false); await service.getTaskList({ userId: owner, scope: 'all_pending' }); expect(f.calls[1]!.searchParams.has('due_date')).toBe(false);
  });
  it('preserves task read failures instead of promoting unavailable data to an empty success', async () => {
    const f = sdk({}, ['tasks']); await expect(taskService(f.client).getTaskList({ userId: owner })).rejects.toMatchObject({ message: 'synthetic failed' });
  });
  it('keeps phone-only agenda reads out of the task table and marks calendar disconnected', async () => {
    const f = sdk({ reminders: [] }); const result = await agendaService(f.client).getUnifiedAgenda({ phoneNumber: '573000000001' }); expect(f.calls.map(url => url.pathname)).toEqual(['/rest/v1/reminders']); expect(f.calls[0]!.searchParams.get('phone_number')).toBe('eq.573000000001'); expect(result.calendar.state).toBe('DISCONNECTED'); expect(result.complete).toBe(false);
  });
  it('retains partial source availability and stable item ordering', async () => {
    const f = sdk({ reminders: [{ id: 'rem', content: 'Water', send_at: now.toISOString() }], tasks: [{ id: 'task', title: 'Task' }] }, ['tasks']); const result = await agendaService(f.client, true).getUnifiedAgenda({ userId: owner, phoneNumber: '573000000001', scope: 'all_pending' }); expect(result.sources).toEqual({ calendar: 'CONNECTED', reminders: 'AVAILABLE', tasks: 'ERROR' }); expect(result.items.map(item => item.internalId)).toEqual(['rem']); expect(result.complete).toBe(false); expect(f.calls.find(url => url.pathname.endsWith('/reminders'))!.searchParams.get('or')).toContain('user_id.eq.owner');
  });
});
function reconciliationFixture(events: { id: string; summary: string; startIso: string }[], existing: unknown[] = []) {
  const f = sdk({ users: [{ id: owner, phone_number: '573000000001', locale: 'en-US' }], reminders: existing, messages: [] });
  const saveReminder = vi.fn<ReconciliationDependencies['saveReminder']>(async () => ({ id: 'new-rem' })); const updateReminder = vi.fn<ReconciliationDependencies['updateReminder']>(async () => ({})); const sendWhatsAppText = vi.fn<ReconciliationDependencies['sendWhatsAppText']>(async () => ({}));
  const deps = { supabase: f.client, getUserIntegration: async () => null, hasUsableGoogleCredentials: () => true, getReminderConfirmationPreference: async () => null, listCalendarEvents: vi.fn(async () => events), normalizeCalendarEvent: (event: unknown) => event, saveReminder, updateReminder, saveMessage: vi.fn(async () => ({})), sendWhatsAppText, formatHumanFriendlyDateTime: time.formatHumanFriendlyDateTime, getNow: () => now, getNowMs: () => now.getTime(), logger };
  return { ...f, deps, ...createCalendarReconciliation(deps as ReconciliationDependencies) };
}
describe('typed companion reminder reconciliation', () => {
  it('scopes rolling-window reads and inserts one companion per future timed event', async () => {
    const f = reconciliationFixture([{ id: 'event', summary: 'Meeting', startIso: '2026-10-13T12:00:00Z' }]); const result = await f.reconcileCalendarCompanionReminders({ userId: owner, notifyOnDiscovery: true }); expect(result.createdCount).toBe(1); expect(f.deps.saveReminder).toHaveBeenCalledWith(expect.objectContaining({ userId: owner, deliveryId: 'gcal:event', sendAt: '2026-10-13T11:45:00.000Z', requiresConfirmation: true })); const url = f.calls.find(url => url.pathname.endsWith('/reminders'))!; expect(url.searchParams.get('user_id')).toBe('eq.owner'); expect(url.searchParams.get('send_at')).toContain('gte.'); expect(f.deps.sendWhatsAppText).toHaveBeenCalledOnce();
  });
  it('does not cancel companions when the calendar read cannot establish the event snapshot', async () => {
    const f = reconciliationFixture([], [{ id: 'rem', delivery_id: 'gcal:event', send_at: '2026-10-13T12:00:00Z', status: 'pending' }]); f.deps.listCalendarEvents.mockRejectedValue(Error('unavailable')); expect((await f.reconcileCalendarCompanionReminders({ userId: owner })).synced).toBe(false); expect(f.deps.updateReminder).not.toHaveBeenCalled();
  });
  it('keeps an existing companion ID on reschedule and scopes the mutation owner', async () => {
    const f = reconciliationFixture([{ id: 'event', summary: 'Meeting', startIso: '2026-10-13T12:00:00Z' }], [{ id: 'rem', delivery_id: 'gcal:event', send_at: '2026-10-13T11:30:00Z', status: 'pending' }]); const result = await f.reconcileCalendarCompanionReminders({ userId: owner }); expect(result.updatedCount).toBe(1); expect(f.deps.updateReminder).toHaveBeenCalledExactlyOnceWith('rem', { send_at: '2026-10-13T11:45:00.000Z' }, owner); expect(f.deps.saveReminder).not.toHaveBeenCalled();
  });
});
describe('typed task mutation boundaries', () => {
  it('checks ownership after direct ID lookup before admitting a task target', async () => {
    const f = sdk({ tasks: [{ id: '00000000-0000-4000-8000-000000000001', user_id: 'foreign', status: 'pending' }] });
    const resolver = createTaskTargetResolution({ supabase: f.client, isStrictUUID: () => true } as unknown as Parameters<typeof createTaskTargetResolution>[0]); const result = await resolver.resolveTaskTarget({ target: '00000000-0000-4000-8000-000000000001', userId: owner }); expect(result.status).toBe('NOT_FOUND'); expect(f.calls[0]!.searchParams.get('id')).toBe('eq.00000000-0000-4000-8000-000000000001');
  });
  it('does not schedule reminders after an unconfirmed atomic task batch', async () => {
    const saveReminder = vi.fn(); const tool = createTaskCreateTool({ inspectOwnedEntityReferences: async () => ({ success: true, resolutions: [] }), normalizeTaskPriority: () => 'medium', createTasksBatch: async () => ({ data: [] }), saveReminder, formatErrorCard: () => 'Error', DEFAULT_TIMEZONE: 'America/Bogota' } as unknown as Parameters<typeof createTaskCreateTool>[0]); const result = await tool.executeTaskCreate({ user: { id: owner }, params: { items: [{ title: 'Task' }] } }); expect(result.success).toBe(false); expect(saveReminder).not.toHaveBeenCalled();
  });
  it('reports a saved task with failed companion cleanup as partial success', async () => {
    const deps = { resolveTaskTarget: async () => ({ status: 'RESOLVED', taskId: 'task' }), updateTask: async () => ({ id: 'task', title: 'Task' }), acknowledgeRemindersByTaskId: async () => ({ error: 'failed' }), DEFAULT_TIMEZONE: 'America/Bogota' };
    const tool = createTaskUpdateTool(deps as unknown as TaskMutationDependencies); const result = await tool.executeTaskUpdate({ user: { id: owner }, params: { target: 'Task', status: 'completed' } }); expect(result).toMatchObject({ success: true, partialSuccess: true, complete: false, action: 'updated_task_partial', errorCode: 'COMPANION_CLEANUP_FAILED' });
  });
});
