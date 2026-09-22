import { beforeEach, describe, expect, it, vi } from 'vitest';

const db = vi.hoisted(() => ({ from: vi.fn() }));
vi.mock('@supabase/supabase-js', () => ({ createClient: vi.fn(() => db) }));

const { saveReminder } = await import('../../../src/infrastructure/database/index.js');

describe('saveReminder supersede scope invariant', () => {
  let updateCalls = [];

  beforeEach(() => {
    vi.clearAllMocks();
    updateCalls = [];

    db.from.mockImplementation((table) => {
      let currentPayload = null;
      const builder = {
        _table: table,
        _action: null,
        _filters: {},
        select: vi.fn().mockReturnThis(),
        insert: vi.fn().mockImplementation((payload) => {
          builder._action = 'insert';
          currentPayload = payload;
          return builder;
        }),
        update: vi.fn().mockImplementation((payload) => {
          builder._action = 'update';
          currentPayload = payload;
          builder._payload = payload;
          updateCalls.push(builder);
          return builder;
        }),
        eq: vi.fn().mockImplementation((field, val) => {
          builder._filters[field] = val;
          return builder;
        }),
        is: vi.fn().mockImplementation((field, val) => {
          builder._filters[`${field}_is`] = val;
          return builder;
        }),
        ilike: vi.fn().mockImplementation((field, val) => {
          builder._filters[`${field}_ilike`] = val;
          return builder;
        }),
        single: vi.fn().mockImplementation(async () => ({
          data: { id: 'new-reminder-id', status: 'pending', ...(currentPayload || {}) },
          error: null,
        })),
        maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
      };
      return builder;
    });
  });

  it('never executes supersede cancellation when saving a companion reminder with deliveryId', async () => {
    const res = await saveReminder({
      userId: 'user-gcal-1',
      phoneNumber: '+573046154163',
      content: '🔔 [Google Calendar] CCS Daily interna en 15 minutos',
      sendAt: '2026-09-23T13:45:00.000Z',
      deliveryId: 'gcal:series-instance-2',
      requiresConfirmation: true,
    });

    expect(res).toBeDefined();
    expect(res.id).toBe('new-reminder-id');

    // No update query should have been run to cancel other reminders
    const supersedeUpdate = updateCalls.find(
      (c) => c._payload?.status === 'cancelled',
    );
    expect(supersedeUpdate).toBeUndefined();
  });

  it('restricts supersede cancellation to sent unacknowledged nudge loops without deliveryId', async () => {
    const res = await saveReminder({
      userId: 'user-standard-1',
      phoneNumber: '+573046154163',
      content: 'Tomar la pastilla',
      sendAt: '2026-09-22T15:00:00.000Z',
      requiresConfirmation: true,
    });

    expect(res).toBeDefined();

    // An update query MUST have run, but restricted to status='sent' and delivery_id=null
    const supersedeUpdate = updateCalls.find(
      (c) => c._payload?.status === 'cancelled',
    );
    expect(supersedeUpdate).toBeDefined();
    expect(supersedeUpdate._filters.requires_confirmation).toBe(true);
    expect(supersedeUpdate._filters.status).toBe('sent');
    expect(supersedeUpdate._filters.acknowledged_at_is).toBeNull();
    expect(supersedeUpdate._filters.delivery_id_is).toBeNull();
    expect(supersedeUpdate._filters.content_ilike).toBe('Tomar la pastilla');
    expect(supersedeUpdate._filters.user_id).toBe('user-standard-1');
  });
});
