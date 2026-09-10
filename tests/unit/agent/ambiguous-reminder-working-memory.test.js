import { describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/infrastructure/database/index.js', () => ({ supabase: { from: vi.fn() } }));
vi.mock('../../../src/integrations/whatsapp/kapso-client.js', () => ({
  normalizePhoneNumber: vi.fn((value) => String(value || '').replace(/\D/g, '')),
}));

import { supabase } from '../../../src/infrastructure/database/index.js';
import { executeSingleReminderCancellation } from '../../../src/agent/tools/reminder-cancel.js';

const user = { id: 'user-1', phone_number: '573001112233', timezone: 'America/Bogota' };

describe('ambiguous reminder continuity', () => {
  it('exposes both concrete duplicate candidates without mutating either one', async () => {
    const rows = [
      { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', user_id: user.id, phone_number: user.phone_number, status: 'pending', acknowledged_at: null, content: 'Sacar una cita', recurrence_rule: null, send_at: '2026-09-11T14:00:00.000Z' },
      { id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', user_id: user.id, phone_number: user.phone_number, status: 'pending', acknowledged_at: null, content: 'Sacar una cita', recurrence_rule: null, send_at: '2026-09-12T14:00:00.000Z' },
    ];
    const selectBuilder = {};
    selectBuilder.select = vi.fn(() => selectBuilder);
    selectBuilder.or = vi.fn(() => selectBuilder);
    selectBuilder.eq = vi.fn(() => selectBuilder);
    selectBuilder.in = vi.fn(() => selectBuilder);
    selectBuilder.order = vi.fn(() => selectBuilder);
    selectBuilder.limit = vi.fn(async () => ({ data: rows, error: null }));
    supabase.from.mockReturnValue(selectBuilder);

    const result = await executeSingleReminderCancellation({ params: { action: 'cancel', target: 'Sacar una cita' }, user, language: 'es' });

    expect(result).toMatchObject({ success: false, errorCode: 'AMBIGUOUS_TARGET', requiresClarification: true });
    expect(result.data.reminders.map((item) => item.id)).toEqual(rows.map((row) => row.id));
    expect(result.data.reminders.map((item) => item.time)).toEqual(rows.map((row) => row.send_at));
    expect(supabase.from).toHaveBeenCalledTimes(1);
  });
});
