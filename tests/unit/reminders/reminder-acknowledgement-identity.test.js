import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ rows: [] }));

vi.mock('../../../src/infrastructure/database/index.js', () => ({
  supabase: {
    from: vi.fn(() => {
      let selectedId = null;
      const chain = {
        select: vi.fn(() => chain),
        neq: vi.fn(() => chain),
        or: vi.fn(() => chain),
        eq: vi.fn((field, value) => {
          if (field === 'id') selectedId = value;
          return chain;
        }),
        in: vi.fn(() => chain),
        order: vi.fn(() => chain),
        limit: vi.fn(async () => ({ data: state.rows, error: null })),
        maybeSingle: vi.fn(async () => ({
          data: state.rows.find((row) => row.id === selectedId) || null,
          error: null,
        })),
      };
      return chain;
    }),
  },
  acknowledgeReminder: vi.fn(),
}));

vi.mock('../../../src/integrations/whatsapp/kapso-client.js', () => ({
  normalizePhoneNumber: vi.fn((value) => String(value || '').replace(/^\+/, '')),
  stripReminderPrefix: vi.fn((value) => value),
}));

const { acknowledgeReminder } = await import('../../../src/infrastructure/database/index.js');
const { executeReminderAcknowledgement } = await import('../../../src/agent/tools/reminder-acknowledge.js');

const user = { id: 'user-1', phone_number: '+573001112233' };

describe('authoritative reminder acknowledgement identity', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.rows = [];
  });

  it('uses the bound notification identity instead of another reminder with the same title', async () => {
    state.rows = [
      { id: 'reminder-old', user_id: 'user-1', phone_number: null, content: 'Llamar a Julieth', acknowledged_at: null },
      { id: 'reminder-active', user_id: 'user-1', phone_number: null, content: 'Llamar a Julieth', acknowledged_at: null },
    ];
    acknowledgeReminder.mockResolvedValue({
      ...state.rows[1],
      acknowledged_at: '2026-09-11T15:00:00.000Z',
    });

    const result = await executeReminderAcknowledgement({
      params: { action: 'acknowledge', target: 'Llamar a Julieth', reminderId: 'reminder-active' },
      user,
    });

    expect(result.success).toBe(true);
    expect(result.reminderId).toBe('reminder-active');
    expect(acknowledgeReminder).toHaveBeenCalledWith('reminder-active', 'user-1');
  });

  it('rejects a bound notification identity that is outside the tenant boundary', async () => {
    state.rows = [{
      id: 'other-tenant-reminder',
      user_id: 'user-2',
      phone_number: '+573009999999',
      content: 'Llamar a Julieth',
      acknowledged_at: null,
    }];

    const result = await executeReminderAcknowledgement({
      params: { action: 'acknowledge', target: 'Llamar a Julieth', reminderId: 'other-tenant-reminder' },
      user,
    });

    expect(result).toMatchObject({ success: false, errorCode: 'NOT_FOUND' });
    expect(acknowledgeReminder).not.toHaveBeenCalled();
  });

  it('returns idempotent success without a second mutation when already acknowledged', async () => {
    state.rows = [{
      id: 'reminder-active',
      user_id: 'user-1',
      phone_number: null,
      content: 'Llamar a Julieth',
      acknowledged_at: '2026-09-11T15:00:00.000Z',
    }];

    const result = await executeReminderAcknowledgement({
      params: { action: 'acknowledge', target: 'Llamar a Julieth', reminderId: 'reminder-active' },
      user,
    });

    expect(result).toMatchObject({ success: true, reminderId: 'reminder-active' });
    expect(acknowledgeReminder).not.toHaveBeenCalled();
  });
});
