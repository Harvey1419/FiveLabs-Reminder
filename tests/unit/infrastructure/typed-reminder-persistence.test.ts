import { describe, expect, it, vi } from 'vitest';
import { createReminderPersistence } from '../../../src/infrastructure/database/reminder-persistence.js';
import { createReminderDeliveryPersistence } from '../../../src/infrastructure/database/reminder-delivery-persistence.js';
import { createReminderOverview } from '../../../src/infrastructure/database/reminder-overview.js';
import type { ReminderDependencies, ReminderQuery, ReminderResult, ReminderRow, ReminderStorageError } from '../../../src/infrastructure/database/reminder-persistence-client.js';
const NOW = Date.parse('2026-10-13T15:00:00Z');
const UUID = '11111111-1111-4111-8111-111111111111';
const row: ReminderRow = { id: UUID, content: 'Reminder', status: 'pending', user_id: 'owner', send_at: '2026-10-13T15:00:00Z' };
interface Step { data: unknown; error: ReminderStorageError | null }
function fixture(steps: (Step | Error)[] = []) {
  const calls: { method: string; args: unknown[] }[] = [];
  const consume = async <T>(): Promise<ReminderResult<T>> => { const step = steps.shift() || { data: null, error: null }; if (step instanceof Error) throw step; return step as ReminderResult<T>; };
  const from = vi.fn((table: string): ReminderQuery => {
    calls.push({ method: 'from', args: [table] }); const query = {} as ReminderQuery;
    for (const name of ['select', 'insert', 'update', 'eq', 'neq', 'is', 'in', 'ilike', 'or', 'lte', 'limit', 'order'] as const) Object.assign(query, { [name]: (...args: unknown[]) => { calls.push({ method: name, args }); return query; } });
    query.single = () => consume<ReminderRow>(); query.maybeSingle = () => consume<ReminderRow>(); query.then = (resolve, reject) => consume<ReminderRow[]>().then(resolve, reject); return query;
  });
  const rpc = vi.fn(async (...args: unknown[]) => { calls.push({ method: 'rpc', args }); return consume<ReminderRow[]>(); });
  const deps: ReminderDependencies = { getClient: vi.fn(() => ({ from, rpc })), getNow: () => new Date(NOW), getNowMs: () => NOW, assertTurnLease: vi.fn(async () => {}), isStrictUUID: value => /^[a-f0-9-]{36}$/i.test(value), formatLocalDateTime: date => date.toISOString(), logger: { log: vi.fn(), warn: vi.fn(), error: vi.fn() } };
  return { calls, from, rpc, deps, ...createReminderPersistence(deps), ...createReminderDeliveryPersistence(deps), ...createReminderOverview(deps) };
}
const ok = (data: unknown): Step => ({ data, error: null });
const updates = (f: ReturnType<typeof fixture>) => f.calls.filter(call => call.method === 'update').map(call => call.args[0]);
describe('typed reminder CRUD and companion persistence', () => {
  it('constructs without accessing storage and keeps alias identity', () => {
    const f = fixture(); expect(f.deps.getClient).not.toHaveBeenCalled(); expect(f.cancelPendingRemindersByContent).toBe(f.cancelReminders);
  });
  it('uses owner-scoped exact deduplication and delivery identity before inserting', async () => {
    const f = fixture([ok(null), ok(row)]); expect(await f.saveReminder({ userId: 'owner', content: 'Reminder', sendAt: row.send_at!, deliveryId: 'gcal:event' })).toEqual({ ...row, isExisting: true }); expect(f.calls).toContainEqual({ method: 'eq', args: ['user_id', 'owner'] }); expect(f.calls).toContainEqual({ method: 'eq', args: ['delivery_id', 'gcal:event'] }); expect(f.calls.some(call => call.method === 'insert')).toBe(false);
  });
  it('preserves schema-cache insert fallback payload and exact final error identity', async () => {
    const schema = { message: 'column missing from schema cache' }; const f = fixture([ok(null), ok(null), { data: null, error: schema }, ok(row)]); const result = await f.saveReminder({ phoneNumber: '+57', content: 'Reminder', sendAt: row.send_at!, requiresConfirmation: true, maxNudges: '2' }); expect(result).toMatchObject({ requires_confirmation: true, max_nudges: 2, nudge_count: 0 }); const inserted = f.calls.filter(call => call.method === 'insert'); expect(inserted).toHaveLength(2); expect(inserted[1]!.args[0]).not.toHaveProperty('requires_confirmation');
    const error = { code: 'WRITE_FAILED' }; const failed = fixture([ok(null), { data: null, error }]); await expect(failed.saveReminder({ content: 'Reminder', sendAt: row.send_at! })).rejects.toBe(error);
  });
  it('keeps acknowledgement lease assertion before validation and owner-bound prefix resolution/update', async () => {
    const f = fixture([ok([{ id: UUID }]), ok(row)]); expect(await f.acknowledgeReminder(UUID.slice(0, 8), 'owner')).toBe(row); expect(f.deps.assertTurnLease).toHaveBeenCalledTimes(1); expect(f.calls.filter(call => call.method === 'eq' && call.args[0] === 'user_id')).toHaveLength(2); expect(f.calls).toContainEqual({ method: 'limit', args: [100] }); expect(updates(f)).toEqual([{ acknowledged_at: new Date(NOW).toISOString(), status: 'sent' }]); await f.acknowledgeReminder(null); expect(f.deps.assertTurnLease).toHaveBeenCalledTimes(2);
  });
  it('retains acknowledgement schema fallback and returned observations after legacy update failure', async () => {
    const f = fixture([ok([{ ...row, status: 'sent', requires_confirmation: true }]), { data: null, error: { message: 'column schema cache' } }, ok(null)]); const result = await f.acknowledgeReminders({ userId: 'owner' }); expect(result.acknowledgedCount).toBe(1); expect(updates(f)).toEqual([{ acknowledged_at: new Date(NOW).toISOString() }, { status: 'sent' }]); expect(result.acknowledgedReminders[0]).toMatchObject({ acknowledged_at: new Date(NOW).toISOString() });
  });
  it('cancels the selected pending rows while retaining latest and reporting original remaining count', async () => {
    const older = { ...row, id: 'older' }; const f = fixture([ok([row, older]), ok(null)]); expect(await f.cancelReminders({ userId: 'owner', keepLatest: true })).toEqual({ cancelledCount: 1, cancelledReminders: [older], remainingCount: 1 }); expect(f.calls).toContainEqual({ method: 'in', args: ['id', ['older']] }); expect(updates(f)).toEqual([{ status: 'cancelled' }]);
  });
  it('retains scoped prefix update/null failure and prevents write after failed lease assertion', async () => {
    const f = fixture([ok([{ id: UUID }]), ok([row])]); expect(await f.updateReminder(UUID.slice(0, 8), { content: 'Changed' }, 'owner')).toBe(row); expect(f.calls).toContainEqual({ method: 'eq', args: ['user_id', 'owner'] }); const error = Error('lease lost'); vi.mocked(f.deps.assertTurnLease).mockRejectedValue(error); const count = f.calls.length; await expect(f.updateReminder(UUID, { content: 'Blocked' }, 'owner')).rejects.toBe(error); expect(f.calls).toHaveLength(count);
  });
  it('preserves companion cancellation direct-event/summary fallback and error reporting', async () => {
    const f = fixture([{ data: null, error: { code: 'DIRECT_FAILURE' } }, ok([{ id: UUID }])]); expect(await f.cancelCalendarCompanionReminders({ userId: 'owner', eventId: 'event', summary: ' Meeting ' })).toEqual({ cancelled: 1 }); expect(f.calls).toContainEqual({ method: 'eq', args: ['delivery_id', 'gcal:event'] }); expect(f.calls).toContainEqual({ method: 'ilike', args: ['content', '%Meeting%'] }); expect(f.calls.filter(call => call.method === 'eq' && call.args[0] === 'user_id')).toHaveLength(2);
  });
  it('reschedules calendar companion using the original advance offset and exact selected row', async () => {
    const f = fixture([ok(row), ok([{ id: UUID }])]); const result = await f.rescheduleCalendarCompanionReminders({ userId: 'owner', eventId: 'event', summary: 'Meeting', newStartDateTime: NOW + 3600000, advanceMinutes: 15 }); expect(result).toEqual({ rescheduled: 1, newSendAt: new Date(NOW + 2700000).toISOString() }); expect(updates(f)).toEqual([{ send_at: new Date(NOW + 2700000).toISOString(), content: '🔔 [Google Calendar] Meeting en 15 minutos', delivery_id: 'gcal:event' }]); expect(f.calls).toContainEqual({ method: 'eq', args: ['id', UUID] });
  });
  it('preserves task companion ownership, pending/ack predicates and storage errors', async () => {
    const f = fixture([ok([{ id: UUID }]), { data: null, error: { code: 'FAILED' } }, ok([{ id: UUID }])]); expect(await f.acknowledgeRemindersByTaskId('task', 'owner')).toEqual({ acknowledgedCount: 1 }); expect(await f.cancelRemindersByTaskId('task', 'owner')).toEqual({ cancelledCount: 0, error: { code: 'FAILED' } }); expect(await f.rescheduleRemindersByTaskId('task', NOW, 'owner')).toEqual({ rescheduledCount: 1, newSendAt: new Date(NOW).toISOString() }); expect(f.calls.filter(call => call.method === 'eq' && call.args[0] === 'user_id')).toHaveLength(3); expect(f.calls).toContainEqual({ method: 'is', args: ['acknowledged_at', null] });
  });
});
describe('typed delivery-worker persistence compatibility', () => {
  it('keeps database status callback error distinct from unmatched/invalid callbacks', async () => {
    const error = { code: 'FAILED' }; const f = fixture([{ data: null, error }, ok(null)]); await expect(f.updateReminderDeliveryStatus({ deliveryId: 'delivery', deliveryStatus: 'DELIVERED' })).rejects.toBe(error); expect(await f.updateReminderDeliveryStatus({ deliveryId: 'delivery', deliveryStatus: 'read' })).toBeNull(); const count = f.calls.length; expect(await f.updateReminderDeliveryStatus({ deliveryId: 'delivery', deliveryStatus: 'bad' })).toBeNull(); expect(f.calls).toHaveLength(count); expect(updates(f)).toEqual([{ status: 'sent' }, { status: 'sent' }]);
  });
  it('keeps nudge limits and exact interval boundary using the existing projected predicates', async () => {
    const f = fixture([ok([{ ...row, status: 'sent', sent_at: NOW - 900000, nudge_count: 1, max_nudges: 2 }, { ...row, id: 'early', sent_at: NOW - 899999 }, { ...row, id: 'exhausted', sent_at: NOW - 900000, nudge_count: 2, max_nudges: 2 }])]); expect((await f.getRemindersDueForNudge()).map(r => r.id)).toEqual([UUID]); expect(f.calls).toContainEqual({ method: 'is', args: ['acknowledged_at', null] });
  });
  it('returns RPC claims without executing fallback queries', async () => {
    const f = fixture([ok([row])]); expect(await f.claimNextDueReminder('worker', 120)).toBe(row); expect(f.rpc).toHaveBeenCalledWith('claim_next_pending_reminder', { p_worker_id: 'worker', p_lock_duration_sec: 120 }); expect(f.from).not.toHaveBeenCalled();
  });
  it('preserves atomic fallback competition and expired-processing lease predicates', async () => {
    const expired = { ...row, id: 'expired', status: 'processing' }; const f = fixture([{ data: null, error: { code: 'RPC_UNAVAILABLE' } }, ok([row, expired]), ok([]), ok([expired])]); expect(await f.claimNextDueReminder('worker', 120)).toBe(expired); expect(f.calls).toContainEqual({ method: 'limit', args: [10] }); expect(f.calls).toContainEqual({ method: 'eq', args: ['status', 'pending'] }); expect(f.calls).toContainEqual({ method: 'eq', args: ['status', 'processing'] }); expect(f.calls).toContainEqual({ method: 'lte', args: ['lock_until', new Date(NOW).toISOString()] }); expect(updates(f)).toHaveLength(2); expect(updates(f)[1]).toMatchObject({ lock_until: new Date(NOW + 120000).toISOString(), claimed_by: 'worker' });
  });
  it('keeps RPC/fallback exceptions terminal at null without replay', async () => {
    const f = fixture([Error('RPC unavailable'), Error('database unavailable')]); expect(await f.claimNextDueReminder()).toBeNull(); expect(f.rpc).toHaveBeenCalledTimes(1); expect(f.from).toHaveBeenCalledTimes(1); expect(f.deps.logger.error).toHaveBeenCalledTimes(1);
  });
  it('keeps due-read errors, no-row peek semantics and nudge optimistic fallback', async () => {
    const error = { code: 'FAILED' }; const f = fixture([{ data: null, error }, { data: null, error: { code: 'PGRST116' } }, Error('nudge update failed')]); await expect(f.getDueReminders()).rejects.toBe(error); expect(await f.getNextPendingReminder()).toBeNull(); expect(await f.incrementReminderNudge(UUID, 2)).toEqual({ id: UUID, nudge_count: 2, last_nudged_at: new Date(NOW).toISOString() });
  });
});
describe('typed reminder agenda', () => {
  it('separates scheduled future reminders from dispatched follow-ups and preserves 48-hour cutoff', () => {
    const f = fixture(); const active = { ...row, status: 'pending', requires_confirmation: true, sent_at: NOW - 172800000, nudge_count: 1, max_nudges: 3 }; expect(f.isReminderAwaitingAcknowledgement({ ...active, sent_at: null }, NOW)).toBe(false); expect(f.isReminderAwaitingAcknowledgement(active, NOW)).toBe(true); expect(f.isReminderAwaitingAcknowledgement({ ...active, sent_at: NOW - 172800001 }, NOW)).toBe(false);
  });
  it('keeps user ownership on reminders and tasks and groups undated tasks without inventing dates', async () => {
    const f = fixture([ok([row]), ok([{ ...row, send_at: null, title: 'Task', due_date: null, entities: { name: ' Project ', category: 'project' } }])]); const result = await f.getDailyOverview({ userId: 'owner', timezone: 'America/Bogota' }); expect(result.todayDate).toBe('2026-10-13'); expect(result.timedRemindersToday).toHaveLength(1); expect(result.openTasksByEntity.Project).toHaveLength(1); expect(result.openTasks[0]).toMatchObject({ localDate: null, localTime: null, localFormatted: '(Sin fecha límite)' }); expect(f.calls.filter(call => call.method === 'eq' && call.args[0] === 'user_id')).toHaveLength(2);
  });
  it('does not query unowned tasks for phone-only agenda requests', async () => {
    const f = fixture([ok([row])]); const result = await f.getDailyOverview({ phoneNumber: '+57' }); expect(f.from).toHaveBeenCalledExactlyOnceWith('reminders'); expect(f.calls).toContainEqual({ method: 'eq', args: ['phone_number', '+57'] }); expect(result.openTasks).toEqual([]); expect(result.tasksDueToday).toEqual([]); expect(result.timedRemindersToday).toHaveLength(1);
  });
  it('performs no read without identity and retains recent-history bounds/error fallback', async () => {
    const f = fixture([{ data: null, error: { code: 'FAILED' } }]); await f.getDailyOverview({}); expect(f.from).not.toHaveBeenCalled(); expect(await f.getRecentRemindersForPhone('+57', 999)).toEqual([]); expect(f.calls).toContainEqual({ method: 'limit', args: [50] });
  });
});
