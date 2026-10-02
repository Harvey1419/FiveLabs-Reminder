import { beforeEach, describe, expect, it, vi } from 'vitest';
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
