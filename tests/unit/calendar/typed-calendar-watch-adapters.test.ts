import { describe, expect, it, vi } from 'vitest';
import { createGoogleCalendarWebhook, type CalendarWebhookDependencies } from '../../../src/http/webhooks/google-calendar-handler.js';
import { createUserWebhookQueue } from '../../../src/http/webhooks/user-webhook-queue.js';
import { createCalendarWatchRenewal, type CalendarWatchRenewalDependencies } from '../../../src/jobs/calendar-watch-renewal-core.js';
const NOW = Date.parse('2026-10-13T15:00:00Z');
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
function fixture() {
  const integration = { user_id: 'owner', metadata: { channelId: 'channel', calendarSyncToken: 'sync' } };
  const deps = {
    getUserIntegration: vi.fn(async () => integration), getUserIntegrationByChannelId: vi.fn(async () => integration),
    listIncrementalCalendarEvents: vi.fn(async () => ({ items: [{ id: 'new', status: 'confirmed' }], nextSyncToken: 'next', fullSync: false })),
    updateUserIntegrationMetadata: vi.fn(async () => ({})), reconcileCalendarCompanionReminders: vi.fn(async () => ({})), stopGoogleCalendarWatch: vi.fn(async () => true), getNow: () => new Date(NOW), logger: { log: vi.fn(), warn: vi.fn(), error: vi.fn() },
  } satisfies CalendarWebhookDependencies;
  const res = { status: vi.fn((_status: number) => res), send: vi.fn((_body: string) => undefined) };
  const req = { headers: { 'x-goog-channel-id': 'channel', 'x-goog-resource-state': 'exists', 'x-goog-channel-token': 'userId=owner' } };
  return { deps, res, req, ...createGoogleCalendarWebhook(deps) };
}
describe('typed per-user webhook queue', () => {
  it('serializes the same user, retains a queued successor and removes only the final tail', async () => {
    const queues = new Map<string, Promise<void>>(); const run = createUserWebhookQueue(queues); const first = deferred<void>(); const second = deferred<void>(); const order: number[] = [];
    const a = run('owner', async () => { order.push(1); await first.promise; return 'first'; }); const b = run('owner', async () => { order.push(2); await second.promise; return 'second'; }); await Promise.resolve(); expect(order).toEqual([1]); first.resolve(); await expect(a).resolves.toBe('first'); expect(queues.has('owner')).toBe(true); second.resolve(); await expect(b).resolves.toBe('second'); expect(order).toEqual([1, 2]); expect(queues.size).toBe(0);
  });
  it('allows independent users to proceed and releases a rejected task without poisoning its successor', async () => {
    const queues = new Map<string, Promise<void>>(); const run = createUserWebhookQueue(queues); const blocker = deferred<void>(); const error = Error('failed');
    const a = run('one', async () => { await blocker.promise; throw error; }); const observed = a.catch(value => value); const b = run('one', async () => 'recovered'); await expect(run('two', async () => 'independent')).resolves.toBe('independent'); expect(queues.has('two')).toBe(false); blocker.resolve(); expect(await observed).toBe(error); await expect(b).resolves.toBe('recovered'); expect(queues.size).toBe(0);
  });
  it('does not retain idle users after many isolated notifications or identity-free work', async () => {
    const queues = new Map<string, Promise<void>>(); const run = createUserWebhookQueue(queues); await Promise.all(Array.from({ length: 100 }, (_, index) => run(`user-${index}`, async () => index))); expect(queues.size).toBe(0); await expect(run(null, async () => 42)).resolves.toBe(42); expect(queues.size).toBe(0);
  });
});
describe('typed Google Calendar webhook', () => {
  it('acknowledges before integration work and rejects missing channel before any side effect', async () => {
    const f = fixture(); const pending = deferred<Awaited<ReturnType<typeof f.deps.getUserIntegration>>>(); f.deps.getUserIntegration.mockReturnValueOnce(pending.promise); const work = f.handleGoogleCalendarWebhook(f.req, f.res); expect(f.res.status).toHaveBeenCalledWith(200); expect(f.res.send).toHaveBeenCalledWith('OK'); expect(f.deps.listIncrementalCalendarEvents).not.toHaveBeenCalled(); pending.resolve({ user_id: 'owner', metadata: { channelId: 'channel', calendarSyncToken: 'sync' } }); await work;
    const invalid = fixture(); await invalid.handleGoogleCalendarWebhook({ headers: {} }, invalid.res); expect(invalid.res.status).toHaveBeenCalledWith(400); expect(invalid.deps.getUserIntegration).not.toHaveBeenCalled();
  });
  it('establishes a silent baseline before discovering new events', async () => {
    const f = fixture(); f.deps.getUserIntegration.mockResolvedValue({ user_id: 'owner', metadata: { channelId: 'channel', calendarSyncToken: '' } }); await f.handleGoogleCalendarWebhook(f.req, f.res); expect(f.deps.listIncrementalCalendarEvents).toHaveBeenCalledExactlyOnceWith('owner'); expect(f.deps.reconcileCalendarCompanionReminders).toHaveBeenCalledExactlyOnceWith({ userId: 'owner', notifyOnDiscovery: false }); expect(f.deps.updateUserIntegrationMetadata).toHaveBeenCalledWith('owner', 'google', { calendarSyncToken: 'next', calendarSyncBaselineAt: new Date(NOW).toISOString() });
  });
  it('isolates changed/cancelled events, excludes Hermes events and persists the delta after reconciliation', async () => {
    const f = fixture(); f.deps.listIncrementalCalendarEvents.mockResolvedValue({ items: [{ id: 'new', status: 'confirmed' }, { id: 'cancelled', status: 'cancelled' }, { id: 'hermes-generated', status: 'confirmed' }], nextSyncToken: 'next', fullSync: false }); await f.handleGoogleCalendarWebhook(f.req, f.res); expect(f.deps.reconcileCalendarCompanionReminders).toHaveBeenCalledWith({ userId: 'owner', notifyOnDiscovery: true, notifyEventIds: ['new'], cancelledEventIds: ['cancelled'], extraEvents: [{ id: 'new', status: 'confirmed' }] }); expect(f.deps.updateUserIntegrationMetadata).toHaveBeenCalledWith('owner', 'google', { calendarSyncToken: 'next', lastWebhookReceivedAt: new Date(NOW).toISOString() }); expect(f.deps.reconcileCalendarCompanionReminders.mock.invocationCallOrder[0]).toBeLessThan(f.deps.updateUserIntegrationMetadata.mock.invocationCallOrder[0]!);
  });
  it('suppresses discovery during full sync recovery and stops obsolete channels without running a delta', async () => {
    const f = fixture(); f.deps.listIncrementalCalendarEvents.mockResolvedValue({ items: [{ id: 'existing', status: 'confirmed' }], nextSyncToken: 'next', fullSync: true }); await f.handleGoogleCalendarWebhook(f.req, f.res); expect(f.deps.reconcileCalendarCompanionReminders).toHaveBeenCalledWith({ userId: 'owner', notifyOnDiscovery: false, notifyEventIds: [], cancelledEventIds: [], extraEvents: [] });
    const obsolete = fixture(); await obsolete.handleGoogleCalendarWebhook({ headers: { ...obsolete.req.headers, 'x-goog-channel-id': 'old', 'x-goog-resource-id': 'resource' } }, obsolete.res); expect(obsolete.deps.stopGoogleCalendarWatch).toHaveBeenCalledWith({ userId: 'owner', channelId: 'old', resourceId: 'resource' }); expect(obsolete.deps.listIncrementalCalendarEvents).not.toHaveBeenCalled();
  });
  it('does not persist a new token after reconciliation failure and permits a later notification', async () => {
    const f = fixture(); f.deps.reconcileCalendarCompanionReminders.mockRejectedValueOnce(Error('uncertain reconciliation')); await f.handleGoogleCalendarWebhook(f.req, f.res); expect(f.deps.updateUserIntegrationMetadata).not.toHaveBeenCalled(); expect(f.deps.logger.error).toHaveBeenCalledTimes(1); await f.handleGoogleCalendarWebhook(f.req, f.res); expect(f.deps.updateUserIntegrationMetadata).toHaveBeenCalledTimes(1);
  });
});
function renewalFixture() {
  const f = fixture(); let callback: (() => void) | undefined;
  const deps = { ...f.deps, getAllActiveIntegrations: vi.fn(async () => [{ user_id: 'owner', metadata: { channelId: 'old', resourceId: 'resource', calendarSyncToken: 'sync', channelExpiration: NOW + 86400000 } }]), setupGoogleCalendarWatch: vi.fn(async () => ({ channelId: 'new' })), getNowMs: () => NOW, setInterval: vi.fn((fn: () => void, _interval: number) => { callback = fn; return {}; }) } satisfies CalendarWatchRenewalDependencies;
  return { deps, tick: () => callback!(), ...createCalendarWatchRenewal(deps) };
}
describe('typed Calendar watch renewal worker', () => {
  it('has no startup effects until explicitly started, then schedules the exact interval and initial pass', async () => {
    const f = renewalFixture(); expect(f.deps.getAllActiveIntegrations).not.toHaveBeenCalled(); expect(f.deps.setInterval).not.toHaveBeenCalled(); await f.startCalendarWatchWorker(); expect(f.deps.setInterval).toHaveBeenCalledWith(expect.any(Function), 21600000); expect(f.deps.getAllActiveIntegrations).toHaveBeenCalledTimes(1); f.tick(); expect(f.deps.getAllActiveIntegrations).toHaveBeenCalledTimes(2);
  });
  it('renews at the exact threshold, stops the old channel first and keeps rejected stop non-fatal', async () => {
    const f = renewalFixture(); f.deps.stopGoogleCalendarWatch.mockRejectedValueOnce(Error('obsolete stop')); expect(await f.renewExpiringGoogleCalendarWatches()).toEqual({ checked: 1, baselined: 0, established: 1, errors: 0 }); expect(f.deps.stopGoogleCalendarWatch.mock.invocationCallOrder[0]).toBeLessThan(f.deps.setupGoogleCalendarWatch.mock.invocationCallOrder[0]!);
    const healthy = renewalFixture(); expect(await healthy.renewExpiringGoogleCalendarWatches({ thresholdMs: 86399999 })).toMatchObject({ established: 0 }); expect(healthy.deps.setupGoogleCalendarWatch).not.toHaveBeenCalled();
  });
  it('counts baseline reconciliation failure independently and still attempts watch renewal', async () => {
    const f = renewalFixture(); f.deps.getAllActiveIntegrations.mockResolvedValue([{ user_id: 'owner', metadata: { channelId: '', resourceId: '', calendarSyncToken: '', channelExpiration: 0 } }]); f.deps.reconcileCalendarCompanionReminders.mockRejectedValueOnce(Error('baseline failed')); expect(await f.renewExpiringGoogleCalendarWatches()).toEqual({ checked: 1, baselined: 0, established: 1, errors: 1 }); expect(f.deps.updateUserIntegrationMetadata).toHaveBeenCalledTimes(1); expect(f.deps.setupGoogleCalendarWatch).toHaveBeenCalledTimes(1);
  });
  it('reports initial and periodic scan errors without leaking rejections or adding retries', async () => {
    const f = renewalFixture(); f.deps.getAllActiveIntegrations.mockRejectedValue(Error('scan failure')); await f.startCalendarWatchWorker(1234); await Promise.resolve(); expect(f.deps.logger.error).toHaveBeenCalledWith('[calendarWatchRenewal] Initial watch pass error:', expect.any(Error)); f.tick(); await vi.waitFor(() => expect(f.deps.logger.error).toHaveBeenCalledWith('[calendarWatchRenewal] Periodic watch renewal error:', expect.any(Error))); expect(f.deps.getAllActiveIntegrations).toHaveBeenCalledTimes(2);
  });
});
