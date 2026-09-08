import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/infrastructure/database/index.js', () => ({
  supabase: { from: vi.fn() },
}));

vi.mock('../../../src/integrations/whatsapp/kapso-client.js', () => ({
  normalizePhoneNumber: vi.fn((value) => String(value || '').replace(/\D/g, '')),
}));

import { supabase } from '../../../src/infrastructure/database/index.js';
import { executeSingleReminderCancellation } from '../../../src/agent/tools/reminder-cancel.js';

const user = {
  id: 'user-1',
  phone_number: '573001112233',
  timezone: 'America/Bogota',
};

function setupSupabase(rows) {
  const selectBuilder = {};
  selectBuilder.select = vi.fn(() => selectBuilder);
  selectBuilder.or = vi.fn(() => selectBuilder);
  selectBuilder.eq = vi.fn(() => selectBuilder);
  selectBuilder.in = vi.fn(() => selectBuilder);
  selectBuilder.order = vi.fn(() => selectBuilder);
  selectBuilder.limit = vi.fn(async () => ({ data: rows, error: null }));

  const updateSelect = vi.fn(async () => ({ data: [], error: null }));
  const updateIn = vi.fn((field, ids) => {
    updateSelect.mockResolvedValueOnce({ data: ids.map((id) => ({ id })), error: null });
    return { select: updateSelect };
  });
  const update = vi.fn(() => ({ in: updateIn }));

  supabase.from
    .mockReturnValueOnce(selectBuilder)
    .mockReturnValueOnce({ update });

  return { update, updateIn, updateSelect };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('series-aware reminder cancellation', () => {
  it('cancels the active recurring sibling when the referenced occurrence is already cancelled', async () => {
    const oldId = '11111111-1111-4111-8111-111111111111';
    const activeId = '22222222-2222-4222-8222-222222222222';
    const rows = [
      {
        id: oldId,
        user_id: user.id,
        phone_number: user.phone_number,
        status: 'cancelled',
        acknowledged_at: null,
        content: 'Me amo mucho',
        recurrence_rule: 'daily',
        send_at: '2026-09-08T13:00:00.000Z',
      },
      {
        id: activeId,
        user_id: user.id,
        phone_number: user.phone_number,
        status: 'pending',
        acknowledged_at: null,
        content: 'Me amo mucho',
        recurrence_rule: 'daily',
        send_at: '2026-09-09T13:00:00.000Z',
      },
    ];
    const db = setupSupabase(rows);

    const result = await executeSingleReminderCancellation({
      params: { action: 'cancel', target: oldId },
      user,
      language: 'es',
      correlationId: 'test-series',
    });

    expect(result.success).toBe(true);
    expect(result.action).toBe('cancelled_recurring_reminder_series');
    expect(result.data).toMatchObject({ cancelledCount: 1, recurring: true, recurrenceRule: 'daily' });
    expect(result.confirmation).toContain('Recordatorio recurrente eliminado');
    expect(db.updateIn).toHaveBeenCalledWith('id', [activeId]);
  });

  it('does not cancel a second daily routine with the same text at a different local time', async () => {
    const targetId = '33333333-3333-4333-8333-333333333333';
    const otherId = '44444444-4444-4444-8444-444444444444';
    const rows = [
      {
        id: targetId,
        user_id: user.id,
        phone_number: user.phone_number,
        status: 'pending',
        acknowledged_at: null,
        content: 'Tomar agua',
        recurrence_rule: 'daily',
        send_at: '2026-09-09T13:00:00.000Z', // 08:00 Bogota
      },
      {
        id: otherId,
        user_id: user.id,
        phone_number: user.phone_number,
        status: 'pending',
        acknowledged_at: null,
        content: 'Tomar agua',
        recurrence_rule: 'daily',
        send_at: '2026-09-09T20:00:00.000Z', // 15:00 Bogota
      },
    ];
    const db = setupSupabase(rows);

    const result = await executeSingleReminderCancellation({
      params: { action: 'cancel', target: targetId },
      user,
      language: 'es',
    });

    expect(result.success).toBe(true);
    expect(result.data.cancelledCount).toBe(1);
    expect(db.updateIn).toHaveBeenCalledWith('id', [targetId]);
  });
});
