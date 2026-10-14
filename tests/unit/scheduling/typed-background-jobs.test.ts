import { describe, it, expect, vi } from 'vitest';
import type { BriefingDependencies } from '../../../src/jobs/morning-briefing-core.js';
import type { SchedulerDependencies } from '../../../src/jobs/reminder-scheduler-core.js';
import { createMorningBriefing } from '../../../src/jobs/morning-briefing-core.js';
import { createReminderScheduler } from '../../../src/jobs/reminder-scheduler-core.js';
import { resolveCalendarTemporalScope } from '../../../src/shared/time.js';
const { computeNextRecurringSendAt } = await vi.importActual<{ computeNextRecurringSendAt: SchedulerDependencies['computeNextRecurringSendAt'] }>('../../../src/shared/reminder-recurrence.ts');

const now = new Date('2026-10-13T11:00:00Z');
const user = { id: 'user-1', phone_number: '573000000001', timezone: 'America/Bogota', locale: 'es-CO' };
const reminder = { id: 'rem-1', status: 'processing', user_id: user.id, phone_number: user.phone_number, content: 'Tomar agua', send_at: now.toISOString(), locale: 'es-CO', requires_confirmation: true };
function database(results: { data: unknown; error: unknown }[]) {
  const calls: unknown[][] = [];
  const from = vi.fn((table: string) => {
    const result = results.shift() || { data: [], error: null };
    const query: Record<string, unknown> = { then: (yes: (value: unknown) => unknown, no: (reason: unknown) => unknown) => Promise.resolve(result).then(yes, no), maybeSingle: () => Promise.resolve(result) };
    for (const method of ['select', 'update', 'eq', 'neq', 'not', 'or', 'in', 'gt', 'is', 'limit']) query[method] = (...args: unknown[]) => { calls.push([table, method, ...args]); return query; };
    return query;
  });
  return { from, calls };
}
function briefing(results: { data: unknown; error: unknown }[] = []) {
  const db = database(results);
  const deps = { supabase: db, getNow: () => now, resolveCalendarTemporalScope,
    logger: { log: vi.fn(), warn: vi.fn(), error: vi.fn() }, setInterval: vi.fn(() => ({ unref: vi.fn() })),
    getDailyOverview: vi.fn<BriefingDependencies['getDailyOverview']>(async () => ({})), getUserIntegration: vi.fn(async () => null),
    hasUsableGoogleCredentials: vi.fn(() => false), isGoogleAuthError: vi.fn(() => false), listCalendarEvents: vi.fn<BriefingDependencies['listCalendarEvents']>(async () => []), normalizeCalendarEvent: vi.fn((ev: unknown) => ev),
    isWithin24HourWindow: vi.fn(async () => true), sendReminderConfirmation: vi.fn<BriefingDependencies['sendReminderConfirmation']>(async () => ({ success: true, messageId: 'wamid.brief' })),
    reconcileCalendarCompanionReminders: vi.fn(async () => {}), formatTaskNotesBadge: vi.fn(() => ''), saveWorkingMemory: vi.fn<(key: unknown, payload: { items: { id: string }[] }) => void>(),
  };
  return { deps, db, ...createMorningBriefing(deps as unknown as BriefingDependencies) };
}
function scheduler(results: { data: unknown; error: unknown }[] = []) {
  const db = database(results);
  const deps = { supabase: db, getNow: () => now, getNowMs: () => now.getTime(), workerId: 'test-worker',
    logger: { log: vi.fn(), warn: vi.fn(), error: vi.fn() }, sleep: vi.fn<(ms: number) => Promise<void>>(async () => {}),
    claimNextDueReminder: vi.fn<(worker: string) => Promise<Record<string, unknown> | null>>(async () => null), getNextPendingReminder: vi.fn<() => Promise<{ send_at: string } | null>>(async () => null),
    markReminderAsDispatched: vi.fn(async () => {}), markReminderAsFailed: vi.fn(async () => {}), markReminderAsMissed: vi.fn(async () => {}),
    getRemindersDueForNudge: vi.fn<() => Promise<Record<string, unknown>[]>>(async () => []), incrementReminderNudge: vi.fn(async () => {}), getLatestInboundPhoneNumberId: vi.fn(async () => 'origin'),
    saveMessage: vi.fn(async () => {}), getReminderDispatchPolicy: vi.fn<() => Promise<Record<string, unknown>>>(async () => ({})),
    sendReminderMessage: vi.fn<SchedulerDependencies['sendReminderMessage']>(async () => ({ success: true, messageId: 'wamid.rem' })), stripReminderPrefix: (s: string) => s,
    saveWorkingMemory: vi.fn<(key: unknown, payload: { items: { id: string }[] }) => void>(), computeNextRecurringSendAt, detectLocaleFromPhone: () => 'es-CO', isAdvanceNoticeContent: (s: string) => s.startsWith('advance'),
  };
  return { deps, db, ...createReminderScheduler(deps as unknown as SchedulerDependencies) };
}
describe('typed morning briefing worker', () => {
  it('keeps minute polling, unref and no immediate dispatch', () => {
    const f = briefing(); f.startMorningBriefingWorker(); expect(f.deps.setInterval).toHaveBeenCalledWith(expect.any(Function), 60000); expect(f.deps.setInterval.mock.results[0]!.value.unref).toHaveBeenCalledOnce(); expect(f.db.from).not.toHaveBeenCalled();
  });
  it('preserves the temporal resolver claim bound and task ordinals before sending', async () => {
    const f = briefing([{ data: [user], error: null }, { data: [{ id: user.id }], error: null }]);
    f.deps.getDailyOverview.mockResolvedValue({ tasksDueToday: [{ id: 'due', title: 'Due' }], openTasksByEntity: { Project: [{ id: 'group', title: 'Group' }] }, openTasksGeneral: [{ id: 'general', title: 'General' }] });
    await f.checkAndDispatchBriefings();
    expect(f.db.calls).toContainEqual(['users', 'or', 'last_briefing_at.is.null,last_briefing_at.lt.2026-10-13T11:00:00.000Z']);
    expect(f.deps.sendReminderConfirmation).toHaveBeenCalledOnce();
    expect(f.deps.saveWorkingMemory.mock.calls[0]![1].items.map(item => item.id)).toEqual(['due', 'group', 'general']);
    const message = f.deps.sendReminderConfirmation.mock.calls[0]![1]; expect(message).toContain('1. 🎯'); expect(message).toContain('2. Group'); expect(message).toContain('3. General');
  });
  it.each(['outside-window', 'already-sent', 'claim-lost', 'different-minute'])('skips delivery when %s', async reason => {
    const candidate = { ...user, ...(reason === 'already-sent' ? { last_briefing_at: now.toISOString() } : {}), ...(reason === 'different-minute' ? { morning_briefing_time: '08:00' } : {}) };
    const f = briefing([{ data: [candidate], error: null }, { data: reason === 'claim-lost' ? [] : [{ id: user.id }], error: null }]);
    if (reason === 'outside-window') f.deps.isWithin24HourWindow.mockResolvedValue(false);
    await f.checkAndDispatchBriefings(); expect(f.deps.sendReminderConfirmation).not.toHaveBeenCalled();
  });
  it('does not release the claim or retry an uncertain send', async () => {
    const f = briefing([{ data: [user], error: null }, { data: [{ id: user.id }], error: null }]);
    f.deps.sendReminderConfirmation.mockResolvedValue({ success: false, error: 'uncertain' });
    await f.checkAndDispatchBriefings(); expect(f.deps.sendReminderConfirmation).toHaveBeenCalledOnce(); expect(f.db.from).toHaveBeenCalledTimes(2); expect(f.deps.saveWorkingMemory).not.toHaveBeenCalled();
  });
  it('handles Google authentication failure and nonfatal reconciliation without losing the briefing', async () => {
    const f = briefing(); f.deps.hasUsableGoogleCredentials.mockReturnValue(true); f.deps.listCalendarEvents.mockRejectedValue(Error('auth')); f.deps.isGoogleAuthError.mockReturnValue(true); f.deps.reconcileCalendarCompanionReminders.mockRejectedValue(Error('reconciliation'));
    await f.dispatchBriefingForUser({ ...user, locale: 'en-US' }, '2026-10-13', user.timezone);
    expect(f.deps.sendReminderConfirmation.mock.calls[0]![1]).toContain('Google Calendar connection is required'); expect(f.deps.listCalendarEvents).toHaveBeenCalledWith(user.id, expect.objectContaining({ maxResults: 20, timezone: user.timezone }));
  });
});
describe('typed reminder scheduler', () => {
  it('preserves strict stale threshold and never sends an expired one-off reminder', async () => {
    const f = scheduler(); await f.processReminder({ ...reminder, send_at: new Date(now.getTime() - 7200001).toISOString() }); expect(f.deps.markReminderAsMissed).toHaveBeenCalledExactlyOnceWith(reminder.id); expect(f.deps.sendReminderMessage).not.toHaveBeenCalled();
  });
  it('advances a stale recurrence on the same ID without delivering it', async () => {
    const f = scheduler([{ data: { ...reminder, recurrence_rule: 'daily' }, error: null }]); await f.processReminder({ ...reminder, recurrence_rule: 'daily', send_at: '2026-10-12T11:00:00Z' });
    expect(f.db.calls).toContainEqual(['reminders', 'eq', 'id', reminder.id]); expect(f.db.calls.find(call => call[1] === 'update')![2]).toMatchObject({ status: 'pending', send_at: '2026-10-14T11:00:00.000Z', claimed_by: null, lock_until: null }); expect(f.deps.sendReminderMessage).not.toHaveBeenCalled();
  });
  it.each([{ success: false, error: 'uncertain' }, { success: true }])('requires provider identity before writing memory or history: %j', async receipt => {
    const f = scheduler(); f.deps.sendReminderMessage.mockResolvedValue(receipt); await f.processReminder(reminder); expect(f.deps.sendReminderMessage).toHaveBeenCalledOnce(); expect(f.deps.markReminderAsDispatched).not.toHaveBeenCalled(); expect(f.deps.markReminderAsFailed).toHaveBeenCalledExactlyOnceWith(reminder.id); expect(f.deps.saveWorkingMemory).not.toHaveBeenCalled(); expect(f.deps.saveMessage).not.toHaveBeenCalled();
  });
  it('never replays delivery when persistence fails after provider acceptance', async () => {
    const f = scheduler([{ data: null, error: { message: 'write failed' } }]); await f.processReminder(reminder); expect(f.deps.sendReminderMessage).toHaveBeenCalledOnce(); expect(f.deps.markReminderAsDispatched).toHaveBeenCalledWith(reminder.id, { deliveryId: 'wamid.rem' }); expect(f.deps.markReminderAsFailed).toHaveBeenCalledOnce(); expect(f.deps.saveMessage).not.toHaveBeenCalled();
  });
  it('keeps future snoozes out of nudges and retains inclusive interval boundary', () => {
    const f = scheduler(); const sent = { ...reminder, sent_at: new Date(now.getTime() - 900000).toISOString() }; expect(f.isNudgeDue(sent)).toBe(true); expect(f.isNudgeDue({ ...sent, send_at: new Date(now.getTime() + 1).toISOString() })).toBe(false); expect(f.isNudgeDue({ ...sent, nudge_count: 5 })).toBe(false); expect(f.isNudgeDue({ ...sent, acknowledged_at: now.toISOString() })).toBe(false);
  });
  it('deduplicates legacy and recurring nudge candidates by the stable reminder ID', async () => {
    const sent = { ...reminder, recurrence_rule: 'daily', send_at: now.toISOString(), last_nudged_at: new Date(now.getTime() - 900000).toISOString() };
    const f = scheduler([{ data: [sent], error: null }]); f.deps.getRemindersDueForNudge.mockResolvedValue([sent]); await f.checkAndDispatchNudges(); expect(f.deps.sendReminderMessage).toHaveBeenCalledOnce(); expect(f.deps.incrementReminderNudge).toHaveBeenCalledExactlyOnceWith(reminder.id, 1); expect(f.db.calls).toContainEqual(['reminders', 'limit', 200]);
  });
  it('drains claims with the same worker identity and bounds sleep to 15 seconds', async () => {
    const f = scheduler(); const stop = Error('test stop'); f.deps.claimNextDueReminder.mockResolvedValueOnce({ ...reminder, requires_confirmation: false }).mockResolvedValue(null); f.deps.sleep.mockRejectedValue(stop);
    await expect(f.startScheduler()).rejects.toBe(stop); expect(f.deps.claimNextDueReminder.mock.calls.map(call => call[0])).toEqual(['test-worker', 'test-worker']); expect(f.deps.sendReminderMessage).toHaveBeenCalledOnce(); expect(f.deps.sleep.mock.calls.map(call => call[0])).toEqual([15000, 15000]);
  });
});

describe('worker storage and timing boundaries', () => {
  it('keeps due-row wake-up delay below polling cap and backs off after claim failure', async () => {
    const stop = Error('stop');
    const f = scheduler(); f.deps.getNextPendingReminder.mockResolvedValue({ send_at: new Date(now.getTime() + 2500).toISOString() }); f.deps.sleep.mockRejectedValue(stop); await expect(f.startScheduler()).rejects.toBe(stop); expect(f.deps.sleep.mock.calls.map(call => call[0])).toEqual([2500, 15000]);
    const failed = scheduler(); failed.deps.claimNextDueReminder.mockRejectedValue(Error('claim unavailable')); failed.deps.sleep.mockRejectedValue(stop); await expect(failed.startScheduler()).rejects.toBe(stop); expect(failed.deps.sendReminderMessage).not.toHaveBeenCalled(); expect(failed.deps.sleep).toHaveBeenCalledExactlyOnceWith(15000);
  });
  it('keeps per-user target minutes instead of forcing the default time', async () => {
    const f = briefing([{ data: [{ ...user, morning_briefing_time: '08:00' }], error: null }, { data: [{ id: user.id }], error: null }]); f.deps.getNow = () => new Date('2026-10-13T13:00:00Z'); const worker = createMorningBriefing(f.deps as unknown as BriefingDependencies); await worker.checkAndDispatchBriefings(); expect(f.deps.sendReminderConfirmation).toHaveBeenCalledOnce();
  });
  it('does not deliver nudges when preferences are unreadable or explicitly disabled', async () => {
    for (const mode of ['unknown', 'disabled']) {
      const f = scheduler(); f.deps.getRemindersDueForNudge.mockResolvedValue([reminder]); if (mode === 'unknown') f.deps.getReminderDispatchPolicy.mockRejectedValue(Error('unavailable')); else f.deps.getReminderDispatchPolicy.mockResolvedValue({ global: { disableNudges: true } });
      await f.checkAndDispatchNudges(); expect(f.deps.sendReminderMessage).not.toHaveBeenCalled(); expect(f.deps.incrementReminderNudge).not.toHaveBeenCalled();
      if (mode === 'disabled') expect(f.db.calls).toContainEqual(['reminders', 'update', { requires_confirmation: false, nudge_count: 0, last_nudged_at: null }]);
    }
  });
  it('keeps user locale lookup owner-scoped and rejects unsuccessful claims', async () => {
    const f = scheduler([{ data: { locale: 'en-US' }, error: null }]); expect(await f.resolveReminderLocale({ ...reminder, locale: null })).toBe('en-US'); expect(f.db.calls).toContainEqual(['users', 'eq', 'id', user.id]);
    const failed = briefing([{ data: null, error: { message: 'claim unavailable' } }]); expect(await failed.claimMorningBriefing(user.id)).toBe(false); expect(failed.deps.sendReminderConfirmation).not.toHaveBeenCalled();
  });
  it('retains exact conditional claims and stable recurrence updates through the real SDK with synthetic fetch', async () => {
    const { createRequire } = await import('node:module'); const { createClient } = createRequire(import.meta.url)('@supabase/supabase-js');
    const requests: { url: URL; init: RequestInit; body: Record<string, unknown> }[] = [];
    const sdk = createClient('https://synthetic.supabase.co', 'synthetic', { auth: { persistSession: false, autoRefreshToken: false }, global: { fetch: async (url: string, init: RequestInit) => {
      requests.push({ url: new URL(String(url)), init, body: JSON.parse(init.body as string) });
      return new Response(JSON.stringify(String(url).includes('/users') ? [{ id: user.id }] : { ...reminder, recurrence_rule: 'daily' }), { headers: { 'Content-Type': 'application/json' } });
    } } });
    const a = briefing(); expect(await createMorningBriefing({ ...a.deps, supabase: sdk } as unknown as BriefingDependencies).claimMorningBriefing(user.id, user.timezone, now)).toBe(true);
    expect(requests[0]!.url.searchParams.get('id')).toBe('eq.user-1'); expect(requests[0]!.url.searchParams.get('or')).toBe('(last_briefing_at.is.null,last_briefing_at.lt.2026-10-13T11:00:00.000Z)'); expect(requests[0]!.init.method).toBe('PATCH');
    const b = scheduler(); await createReminderScheduler({ ...b.deps, supabase: sdk } as unknown as SchedulerDependencies).processReminder({ ...reminder, recurrence_rule: 'daily' });
    expect(requests[1]!.url.searchParams.get('id')).toBe('eq.rem-1'); expect(requests[1]!.body).toMatchObject({ send_at: '2026-10-14T11:00:00.000Z', status: 'pending', delivery_id: 'wamid.rem', sent_at: now.toISOString(), last_nudged_at: now.toISOString(), acknowledged_at: null, nudge_count: 0, claimed_by: null, claimed_at: null, lock_until: null }); expect(b.deps.sendReminderMessage).toHaveBeenCalledOnce();
  });
});
