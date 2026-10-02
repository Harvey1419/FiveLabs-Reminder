import { beforeEach, describe, expect, it, vi } from 'vitest';
const fixture = vi.hoisted(() => ({ filters: [], profile: null }));
vi.mock('@supabase/supabase-js', () => ({ createClient: () => ({ from(table) {
  const query = {
    update: vi.fn(() => query), select: vi.fn(() => query),
    eq: vi.fn((key, value) => { fixture.filters.push([key, value]); return query; }),
    maybeSingle: vi.fn(async () => ({ data: table === 'users' ? fixture.profile : fixture.filters.some(([key, value]) => key === 'user_id' && value === 'user-b') ? null : { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', user_id: 'user-a' }, error: null })),
  };
  return query;
} }) }));
import { acknowledgeReminder } from '../../../src/infrastructure/database/index.js';
import { getOrCreateUserByPhone, userCache } from '../../../src/infrastructure/database/users.js';

beforeEach(() => { fixture.filters = []; fixture.profile = null; userCache.clear(); });
describe('foreground ownership and fresh preferences', () => {
  it('never acknowledges a raw UUID belonging to a different user', async () => {
    const result = await acknowledgeReminder('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'user-b');
    expect(result).toBeNull();
    expect(fixture.filters).toContainEqual(['user_id', 'user-b']);
  });
  it('requires an owner even when the reminder ID is known', async () => {
    expect(await acknowledgeReminder('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')).toBeNull();
    expect(fixture.filters).toEqual([]);
  });
  it('reloads preferences changed by another replica instead of using its stale cache', async () => {
    const phone = '19995550101';
    userCache.set(phone, { timestamp: Date.now(), user: { id: 'user-a', phone_number: phone, timezone: 'America/Bogota' } });
    fixture.profile = { id: 'user-a', phone_number: phone, timezone: 'America/Los_Angeles', locale: 'en-US' };
    const result = await getOrCreateUserByPhone(phone, null, 'es-CO', null, { fresh: true });
    expect(result.timezone).toBe('America/Los_Angeles');
    expect(result.locale).toBe('en-US');
  });
});
