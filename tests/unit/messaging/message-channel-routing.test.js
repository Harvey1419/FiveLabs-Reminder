import { beforeEach, describe, expect, it, vi } from 'vitest';

const queryState = vi.hoisted(() => ({
  response: { data: [], error: null },
  filters: [],
}));

const supabaseMock = vi.hoisted(() => ({
  from: vi.fn(() => {
    const query = {
      select: vi.fn(() => query),
      eq: vi.fn((column, value) => {
        queryState.filters.push(['eq', column, value]);
        return query;
      }),
      order: vi.fn(() => query),
      limit: vi.fn(() => query),
      lte: vi.fn((column, value) => {
        queryState.filters.push(['lte', column, value]);
        return query;
      }),
      then: (resolve, reject) => Promise.resolve(queryState.response).then(resolve, reject),
    };
    return query;
  }),
}));

vi.mock('../../../src/infrastructure/database/index.js', () => ({ supabase: supabaseMock }));

const { getLatestInboundPhoneNumberId } = await import('../../../src/infrastructure/database/messages.js');

describe('migration-free reminder channel lookup', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    queryState.filters = [];
    queryState.response = { data: [], error: null };
  });

  it('finds the latest inbound transport channel recorded before reminder creation', async () => {
    queryState.response = {
      data: [
        { entities: null, created_at: '2026-09-04T23:00:00.000Z' },
        {
          entities: {
            _transport: {
              provider: 'whatsapp',
              phoneNumberId: '597907523413541',
            },
          },
          created_at: '2026-09-04T22:59:00.000Z',
        },
      ],
      error: null,
    };

    const phoneNumberId = await getLatestInboundPhoneNumberId(
      '19164158325',
      '2026-09-04T23:01:00.000Z',
    );

    expect(phoneNumberId).toBe('597907523413541');
    expect(queryState.filters).toContainEqual(['eq', 'phone_number', '19164158325']);
    expect(queryState.filters).toContainEqual(['eq', 'role', 'user']);
    expect(queryState.filters).toContainEqual([
      'lte',
      'created_at',
      '2026-09-04T23:01:00.000Z',
    ]);
  });

  it('falls back cleanly when older messages have no transport metadata', async () => {
    queryState.response = {
      data: [{ entities: null, created_at: '2026-09-04T22:59:00.000Z' }],
      error: null,
    };

    await expect(getLatestInboundPhoneNumberId('19164158325')).resolves.toBeNull();
  });
});
