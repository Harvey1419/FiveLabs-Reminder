import { untrustedResultMock } from '../../support/unit/contract-boundary.js';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/infrastructure/database/index.js', () => ({ supabase: { from: vi.fn() } }));
vi.mock('../../../src/integrations/whatsapp/kapso-client.js', () => ({
  normalizePhoneNumber: vi.fn((value: unknown) => String(value || '').replace(/\D/g, '')),
}));

import { supabase } from '../../../src/infrastructure/database/index.js';
import { executeSingleReminderCancellation } from '../../../src/agent/tools/reminder-cancel.js';
import { saveWorkingMemory, getWorkingMemory } from '../../../src/agent/core/working-memory-store.js';

const user = { id: 'user-1', phone_number: '573001112233', timezone: 'America/Bogota' };

describe('ambiguous reminder continuity', () => {
  it('exposes both concrete duplicate candidates without mutating either one', async () => {
    const rows = [
      { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', user_id: user.id, phone_number: user.phone_number, status: 'pending', acknowledged_at: null, content: 'Sacar una cita', recurrence_rule: null, send_at: '2026-09-11T14:00:00.000Z' },
      { id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', user_id: user.id, phone_number: user.phone_number, status: 'pending', acknowledged_at: null, content: 'Sacar una cita', recurrence_rule: null, send_at: '2026-09-12T14:00:00.000Z' },
    ];
    type Builder = { [K in 'select' | 'or' | 'eq' | 'in' | 'order']: (...args: unknown[]) => Builder } & {
      limit(...args: unknown[]): Promise<{ data: typeof rows; error: null }>;
    };
    // All methods are installed below before returning this controlled query.
    const selectBuilder = {} as Builder;
    selectBuilder.select = vi.fn(() => selectBuilder);
    selectBuilder.or = vi.fn(() => selectBuilder);
    selectBuilder.eq = vi.fn(() => selectBuilder);
    selectBuilder.in = vi.fn(() => selectBuilder);
    selectBuilder.order = vi.fn(() => selectBuilder);
    selectBuilder.limit = vi.fn(async () => ({ data: rows, error: null }));
    untrustedResultMock(supabase.from).mockReturnValue(selectBuilder);

    const result = await executeSingleReminderCancellation({ params: { action: 'cancel', target: 'Sacar una cita' } as NonNullable<NonNullable<Parameters<typeof executeSingleReminderCancellation>[0]>['params']>, user, language: 'es' });

    expect(result).toMatchObject({ success: false, errorCode: 'AMBIGUOUS_TARGET', requiresClarification: true });
    expect(result.data!.reminders!.map((item) => item.id)).toEqual(rows.map((row) => row.id));
    expect(result.data!.reminders!.map((item) => item.time)).toEqual(rows.map((row) => row.send_at));
    expect(supabase.from).toHaveBeenCalledTimes(1);
  });

  it('preserves formattedTime when saving items into working memory store', () => {
    saveWorkingMemory(user.phone_number, {
      source: 'reminder',
      items: [
        {
          id: 'rem-1',
          content: 'Dentist appointment',
          formattedTime: 'Tuesday, Oct 6 at 7:00 AM',
        },
      ],
    });

    const memory = getWorkingMemory(user.phone_number);
    expect(memory!.items[0]!.time).toBe('Tuesday, Oct 6 at 7:00 AM');
  });
});
