import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const { from, complete } = vi.hoisted(() => ({ from: vi.fn(), complete: vi.fn() }));
vi.mock('../../../src/infrastructure/database/index.js', () => ({ supabase: { from } }));
vi.mock('../../../src/agent/providers/client.js', () => ({ callChatCompletion: complete }));
const { getReminderDispatchPolicy, getReminderConfirmationPreference } = await import('../../../src/infrastructure/database/memories.js');
const { compileDispatchPolicy, reduceDispatchRules } = await import('../../../src/features/reminders/dispatch-policy.js');
const rule = (patch = {}) => ({ position: 1, scope: 'global', requiresConfirmation: null, disableButtons: null, disableNudges: null, nudgeIntervalMinutes: null, ...patch });
const response = rules => ({ content: JSON.stringify({ rules }) });
function chain(data, error = null) {
  const value = { select: vi.fn(() => value), eq: vi.fn(() => value), order: vi.fn(() => value), limit: vi.fn(() => value), then: resolve => Promise.resolve({ data, error }).then(resolve) };
  return value;
}
beforeEach(() => { vi.clearAllMocks(); complete.mockResolvedValue(response([])); });
afterEach(() => { vi.useRealTimers(); });
describe('compiled reminder delivery policy', () => {
  it('does not invent an explicit opt-out when there are no preferences', async () => {
    from.mockReturnValue(chain([]));
    const policy = await getReminderDispatchPolicy('empty');
    expect(policy.global.requiresConfirmation).toBe(false);
    expect(policy.explicit.global).toEqual({});
    expect(complete).not.toHaveBeenCalled();
  });
  it('compiles observed preferences into typed rules with tenant-scoped reads', async () => {
    const db = chain([{ id: 'm', content: 'Do not show buttons on recurring reminders' }]); from.mockReturnValue(db);
    complete.mockResolvedValue(response([rule({ scope: 'recurring', disableButtons: true })]));
    const policy = await getReminderDispatchPolicy('buttons');
    expect(policy.recurring.disableButtons).toBe(true);
    expect(policy.recurring.disableNudges).toBe(false);
    expect(db.eq).toHaveBeenCalledWith('user_id', 'buttons');
    expect(db.eq).toHaveBeenCalledWith('category', 'preference');
  });
  it('applies specific exceptions and explicit intervals without interpreting text in the reducer', async () => {
    from.mockReturnValue(chain([{ id: 'm1', content: 'global' }, { id: 'm2', content: 'exception' }]));
    complete.mockResolvedValue(response([
      rule({ requiresConfirmation: true, disableNudges: false, nudgeIntervalMinutes: 20 }),
      rule({ position: 2, scope: 'recurring', disableNudges: true, requiresConfirmation: false }),
    ]));
    const policy = await getReminderDispatchPolicy('hierarchy');
    expect(policy.global.requiresConfirmation).toBe(true);
    expect(policy.recurring.requiresConfirmation).toBe(false);
    expect(await getReminderConfirmationPreference('hierarchy', { isRecurring: true })).toBeNull();
    expect(await getReminderConfirmationPreference('hierarchy')).toMatchObject({ requiresConfirmation: true, nudgeIntervalMinutes: 20 });
    expect(complete).toHaveBeenCalledTimes(1);
  });
  it('uses newest explicit assertion regardless of retrieval order', () => {
    const policy = reduceDispatchRules([{ content: 'new', created_at: '2026-10-02' }, { content: 'old', created_at: '2026-10-01' }], [
      rule({ disableButtons: false }), rule({ position: 2, disableButtons: true }),
    ]);
    expect(policy.global.disableButtons).toBe(false);
  });
  it('deduplicates concurrent compilation but invalidates on content change or tenant change', async () => {
    const preferences = [{ id: 'm', content: 'Original' }];
    const input = { userId: 'revision', preferences };
    await Promise.all([compileDispatchPolicy(input), compileDispatchPolicy(input)]);
    expect(complete).toHaveBeenCalledTimes(1);
    await compileDispatchPolicy({ ...input, preferences: [{ id: 'm', content: 'Changed' }] });
    await compileDispatchPolicy({ ...input, userId: 'other' });
    expect(complete).toHaveBeenCalledTimes(3);
  });
  it('reuses a validated policy beyond five minutes without sharing returned objects', async () => {
    vi.useFakeTimers();
    const input = { userId: 'long-lived', preferences: [{ id: 'm', content: 'Follow up' }] };
    complete.mockResolvedValue(response([rule({ requiresConfirmation: true })]));
    const first = await compileDispatchPolicy(input);
    first.global.requiresConfirmation = false;
    first.explicit.global.requiresConfirmation = false;
    vi.advanceTimersByTime(300001);
    const second = await compileDispatchPolicy(input);
    expect(second.global.requiresConfirmation).toBe(true);
    expect(second.explicit.global.requiresConfirmation).toBe(true);
    second.recurring.requiresConfirmation = false;
    expect((await compileDispatchPolicy(input)).recurring.requiresConfirmation).toBe(true);
    expect(complete).toHaveBeenCalledTimes(1);
  });
  it.each(['tenant', 'content', 'timestamp', 'order', 'removed', 'id'])('invalidates changed %s evidence', async change => {
    const preferences = [
      { id: 'one', content: 'First', created_at: '2026-10-01' },
      { id: 'two', content: 'Second', created_at: '2026-10-02' },
    ];
    const input = { userId: `snapshot-${change}`, preferences };
    complete.mockResolvedValueOnce(response([rule({ disableButtons: true })]));
    expect((await compileDispatchPolicy(input)).global.disableButtons).toBe(true);
    const changed = structuredClone(input);
    if (change === 'tenant') changed.userId += '-other';
    if (change === 'content') changed.preferences[0].content = 'Revised';
    if (change === 'timestamp') changed.preferences[0].created_at = '2026-10-03';
    if (change === 'order') changed.preferences.reverse();
    if (change === 'removed') changed.preferences.pop();
    if (change === 'id') changed.preferences[0].id = 'replacement';
    expect((await compileDispatchPolicy(changed)).global.disableButtons).toBe(false);
    expect(complete).toHaveBeenCalledTimes(2);
  });
  it('filters expired evidence on each database read and recompiles the remaining active snapshot', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-01T00:00:00Z'));
    const db = chain([
      { id: 'lasting', content: 'No buttons', created_at: '2026-09-01', valid_until: null },
      { id: 'temporary', content: 'Show buttons', created_at: '2026-09-02', valid_until: '2026-10-01T00:06:00Z' },
    ]);
    from.mockReturnValue(db);
    complete.mockResolvedValueOnce(response([
      rule({ disableButtons: true }), rule({ position: 2, disableButtons: false }),
    ])).mockResolvedValueOnce(response([rule({ disableButtons: true })]));
    expect((await getReminderDispatchPolicy('expiry-filter')).global.disableButtons).toBe(false);
    vi.advanceTimersByTime(300001);
    expect((await getReminderDispatchPolicy('expiry-filter')).global.disableButtons).toBe(false);
    expect(complete).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(60000);
    expect((await getReminderDispatchPolicy('expiry-filter')).global.disableButtons).toBe(true);
    expect(complete).toHaveBeenCalledTimes(2);
    expect(JSON.parse(complete.mock.calls[1][0][1].content).map(item => item.id)).toEqual(['lasting']);
    expect(db.eq).toHaveBeenCalledWith('is_active', true);
  });
  it('returns defaults when the last active preference expires without compiling empty evidence', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-01T00:00:00Z'));
    from.mockReturnValue(chain([{ id: 'last', content: 'Follow up', valid_until: '2026-10-01T00:01:00Z' }]));
    complete.mockResolvedValue(response([rule({ requiresConfirmation: true })]));
    expect((await getReminderDispatchPolicy('expiry-empty')).global.requiresConfirmation).toBe(true);
    vi.advanceTimersByTime(60000);
    expect(await getReminderDispatchPolicy('expiry-empty')).toEqual(reduceDispatchRules());
    expect(complete).toHaveBeenCalledTimes(1);
  });
  it('shares in-flight work while isolating each concurrent result', async () => {
    let finish;
    complete.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const input = { userId: 'pending-clones', preferences: [{ content: 'No buttons' }] };
    const first = compileDispatchPolicy(input);
    const second = compileDispatchPolicy(input);
    expect(complete).toHaveBeenCalledTimes(1);
    finish(response([rule({ disableButtons: true })]));
    const [a, b] = await Promise.all([first, second]);
    a.global.disableButtons = false;
    expect(b.global.disableButtons).toBe(true);
    expect((await compileDispatchPolicy(input)).global.disableButtons).toBe(true);
  });
  it.each(['unavailable', 'invalid', 'rejected'])('caches %s compilation errors for ten seconds then recovers', async failure => {
    vi.useFakeTimers();
    const input = { userId: `error-recovery-${failure}`, preferences: [{ content: 'Follow up' }] };
    if (failure === 'rejected') complete.mockRejectedValueOnce(new Error('Compilation failed'));
    else complete.mockResolvedValueOnce(failure === 'unavailable' ? { unavailable: true } : response([rule({ position: 2 })]));
    await expect(compileDispatchPolicy(input)).rejects.toThrow();
    vi.advanceTimersByTime(9999);
    await expect(compileDispatchPolicy(input)).rejects.toThrow();
    expect(complete).toHaveBeenCalledTimes(1);
    complete.mockResolvedValue(response([rule({ requiresConfirmation: true })]));
    vi.advanceTimersByTime(1);
    expect((await compileDispatchPolicy(input)).global.requiresConfirmation).toBe(true);
    expect(complete).toHaveBeenCalledTimes(2);
  });
  it('still evicts the oldest cached revision at capacity', async () => {
    const input = { userId: 'capacity-first', preferences: [{ content: 'First' }] };
    await compileDispatchPolicy(input);
    for (let index = 0; index < 1000; index++) {
      await compileDispatchPolicy({ userId: `capacity-${index}`, preferences: [{ content: 'Other' }] });
    }
    await compileDispatchPolicy(input);
    expect(complete).toHaveBeenCalledTimes(1002);
  });
  it('does not turn missing database evidence into default permission', async () => {
    from.mockReturnValue(chain(null, { message: 'database unavailable' }));
    await expect(getReminderDispatchPolicy('read-error')).rejects.toThrow('database unavailable');
    expect(complete).not.toHaveBeenCalled();
  });
  it.each([
    { rules: [rule({ position: 2 })] }, { rules: [rule({ nudgeIntervalMinutes: 0 })] },
    { rules: [rule({ requiresConfirmation: 'false' })] }, { rules: [rule(), rule()] },
  ])('rejects invalid semantic decisions without applying them: %j', async value => {
    complete.mockResolvedValue({ content: JSON.stringify(value) });
    await expect(compileDispatchPolicy({ userId: JSON.stringify(value), preferences: [{ content: 'test' }] })).rejects.toThrow();
  });
  it('fails closed for unavailable compilation and oversized snapshots', async () => {
    complete.mockResolvedValue({ unavailable: true });
    await expect(compileDispatchPolicy({ userId: 'unavailable', preferences: [{ content: 'test' }] })).rejects.toThrow();
    await expect(compileDispatchPolicy({ userId: 'oversized', preferences: Array(101).fill({ content: 'test' }) })).rejects.toThrow();
  });
});
