import { describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/integrations/whatsapp/kapso-client.js', () => ({
  normalizePhoneNumber: vi.fn((value) => String(value || '').replace(/^\+/, '')),
}));

const {
  buildReminderOwnerContext,
  isReminderOwned,
  scopeReminderQueryToOwner,
} = await import('../../../src/agent/tools/reminder-owner.js');

describe('Reminder owner context', () => {
  it('builds one canonical owner identity with normalized phone variants', () => {
    const owner = buildReminderOwnerContext({ id: 'user-1', phone_number: '+573001112233' });

    expect(owner).toEqual({
      userId: 'user-1',
      phoneNumber: '+573001112233',
      phoneVariants: ['+573001112233', '573001112233'],
      hasOwner: true,
    });
  });

  it('recognizes ownership by either user id or a canonical phone variant', () => {
    const owner = buildReminderOwnerContext({ id: 'user-1', phone_number: '+573001112233' });

    expect(isReminderOwned({ user_id: 'user-1', phone_number: null }, owner)).toBe(true);
    expect(isReminderOwned({ user_id: 'other', phone_number: '573001112233' }, owner)).toBe(true);
    expect(isReminderOwned({ user_id: 'other', phone_number: '+573009999999' }, owner)).toBe(false);
  });

  it('applies the same tenant boundary to reminder queries', () => {
    const calls = [];
    const query = {
      or(value) { calls.push(['or', value]); return this; },
      eq(...args) { calls.push(['eq', ...args]); return this; },
      in(...args) { calls.push(['in', ...args]); return this; },
    };
    const owner = buildReminderOwnerContext({ id: 'user-1', phone_number: '+573001112233' });

    expect(scopeReminderQueryToOwner(query, owner)).toBe(query);
    expect(calls).toEqual([
      ['or', 'user_id.eq.user-1,phone_number.eq.+573001112233,phone_number.eq.573001112233'],
    ]);
  });

  it('refuses to scope a query when no owner identity exists', () => {
    expect(scopeReminderQueryToOwner({}, buildReminderOwnerContext(null))).toBeNull();
  });
});
