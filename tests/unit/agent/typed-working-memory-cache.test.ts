import { afterEach, describe, expect, it, vi } from 'vitest';
import { createWorkingMemoryStore, sanitizeResponseText } from '../../../src/agent/core/working-memory-cache.js';
const user = { id: 'cache-user', phone_number: '+57 300-123' };
const input = { source: 'task', items: [{ id: 'task-a', title: 'Alpha', entityName: 'Project', raw: { entity_id: 'entity-a' } }] };
afterEach(() => vi.useRealTimers());
describe('typed short-lived working memory cache', () => {
  it('shares identity aliases inside one host instance but isolates host caches', () => {
    const first = createWorkingMemoryStore({ clearAgentRunsForUser: vi.fn() });
    const second = createWorkingMemoryStore({ clearAgentRunsForUser: vi.fn() });
    first.saveWorkingMemory(user, input);
    expect(first.getWorkingMemory('cache-user')).toBe(first.getWorkingMemory('57300123'));
    expect(second.getWorkingMemory(user)).toBeNull();
    expect(first.getWorkingMemory(user)).toMatchObject({ activeEntity: 'Project', activeEntityId: 'entity-a' });
    first.saveWorkingMemory('anonymous', input); expect(first.getWorkingMemory('anonymous')).toBeNull();
  });
  it('keeps positive displayed positions, explicit null time and opaque raw metadata', () => {
    const store = createWorkingMemoryStore({ clearAgentRunsForUser: vi.fn() });
    const raw = { formattedTime: 'stale', recurrenceRule: null, recurrence_rule: 'daily' };
    store.saveWorkingMemory(user, { source: 'reminder', items: [{ id: 'r1', position: 7, time: null, raw }, { id: '', title: 'Discard' }] });
    expect(store.getWorkingMemory(user)?.items).toHaveLength(1);
    expect(store.getWorkingMemory(user)?.items[0]).toMatchObject({ position: 7, time: null, type: 'reminder' });
    expect(store.getWorkingMemory(user)?.items[0]?.raw).toBe(raw);
    expect(store.formatWorkingMemoryPrompt(user)).not.toContain('recurrence=daily');
  });
  it('preserves exact expiry/future tolerance and the restored reference timestamp', () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2027-01-14T12:00:00Z'));
    const store = createWorkingMemoryStore({ clearAgentRunsForUser: vi.fn() });
    const timestamp = Date.now(); store.saveWorkingMemory(user, input, { restoredTimestamp: timestamp });
    vi.setSystemTime(timestamp + 2*3600000); expect(store.getWorkingMemory(user)).not.toBeNull();
    vi.advanceTimersByTime(1); expect(store.getWorkingMemory(user)).toBeNull();
    store.saveWorkingMemory(user, input, { restoredTimestamp: Date.now()+60001 }); expect(store.getWorkingMemory(user)).toBeNull();
  });
  it('retains interactive references and timestamp during recent notification merges', () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2027-01-14T12:00:00Z'));
    const store = createWorkingMemoryStore({ clearAgentRunsForUser: vi.fn() });
    store.saveWorkingMemory(user, input); const prior = store.getWorkingMemory(user)!;
    vi.advanceTimersByTime(9*60000);
    store.saveWorkingMemory(user, { source: 'notification', lastAction: 'nudge', items: [{ id: 'r1' }], notificationContent: 'Ping' });
    expect(store.getWorkingMemory(user)).toMatchObject({ source: 'task', timestamp: prior.timestamp, notificationReminderId: 'r1', notificationContent: 'Ping' });
    expect(store.getWorkingMemory(user)?.items).toBe(prior.items);
  });
  it('ignores older history after an explicit tombstone and prefers current cache', () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2027-01-14T12:00:00Z'));
    const store = createWorkingMemoryStore({ clearAgentRunsForUser: vi.fn() });
    const old = { entities: { _workingMemory: { ...input, timestamp: Date.now() } } };
    expect(store.hydrateWorkingMemoryFromHistory(user, [old, { entities: { _workingMemory: null } }])).toBeNull();
    store.saveWorkingMemory(user, input); const current = store.getWorkingMemory(user);
    expect(store.hydrateWorkingMemoryFromHistory(user, [{ entities: { _workingMemory: null } }])).toBe(current);
  });
  it('restores valid latest snapshots without extending expiry, but rejects stale state', () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2027-01-14T12:00:00Z'));
    const store = createWorkingMemoryStore({ clearAgentRunsForUser: vi.fn() });
    const timestamp = Date.now()-3600000;
    const history = [{ entities: { _workingMemory: { ...input, timestamp } } }];
    expect(store.hydrateWorkingMemoryFromHistory(user, history)?.timestamp).toBe(timestamp);
    store.clearWorkingMemory(user); vi.advanceTimersByTime(3600001);
    expect(store.hydrateWorkingMemoryFromHistory(user, history)).toBeNull();
  });
  it('clones persistable state, guards cyclic snapshots and bounds prompt references without IDs', () => {
    const store = createWorkingMemoryStore({ clearAgentRunsForUser: vi.fn() });
    store.saveWorkingMemory(user, { source: 'task', items: Array.from({ length: 12 }, (_, i) => ({ id: `private-${i}`, title: `Task ${i}`, position: i+1 })) });
    const snapshot = store.getWorkingMemorySnapshot(user)!;
    snapshot.items[0]!.title = 'Changed'; expect(store.getWorkingMemory(user)?.items[0]?.title).toBe('Task 0');
    const prompt = store.formatWorkingMemoryPrompt(user); expect(prompt).toContain('position:10'); expect(prompt).not.toContain('position:11'); expect(prompt).not.toContain('private-');
    const raw: Record<string, unknown> = {}; raw.self = raw;
    store.saveWorkingMemory(user, { items: [{ id: 'cycle', raw }] }); expect(store.getWorkingMemorySnapshot(user)).toBeNull();
  });
  it('clears host-owned runs through the injected boundary and preserves sanitization', () => {
    const clear = vi.fn(); const store = createWorkingMemoryStore({ clearAgentRunsForUser: clear });
    store.saveWorkingMemory(user, input); store.clearWorkingMemory(user);
    expect(clear).toHaveBeenCalledWith(user); expect(store.getWorkingMemory('57300123')).toBeNull();
    expect(sanitizeResponseText('Ready [id: secret]  550e8400-e29b-41d4-a716-446655440000')).toBe('Ready');
    expect(sanitizeResponseText(null)).toBe('');
  });
});
