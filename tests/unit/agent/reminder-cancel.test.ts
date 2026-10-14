import { untrustedResultMock } from '../../support/unit/contract-boundary.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/infrastructure/database/index.js', () => ({
  supabase: { from: vi.fn() },
}));

vi.mock('../../../src/integrations/whatsapp/kapso-client.js', () => ({
  normalizePhoneNumber: vi.fn((value) => String(value || '').replace(/\D/g, '')),
}));

import { supabase } from '../../../src/infrastructure/database/index.js';
import { executeSingleReminderCancellation as cancelReminder } from '../../../src/agent/tools/reminder-cancel.js';

// Controlled builders expose only methods consumed by these historical fixtures.
type SelectBuilder = {
  [K in 'select' | 'or' | 'eq' | 'in' | 'order' | 'not' | 'ilike' | 'textSearch']:
    (...args: unknown[]) => SelectBuilder;
} & { limit: (...args: unknown[]) => Promise<{ data: unknown[]; error: null }> };
type CancellationInput = NonNullable<Parameters<typeof cancelReminder>[0]>;
function executeSingleReminderCancellation(input: Omit<CancellationInput, 'params'> & {
  params: NonNullable<CancellationInput['params']> & { action?: string };
}) {
  // Preserve the historical surplus action field without widening production input.
  return cancelReminder(input as CancellationInput);
}
const user = {
  id: 'user-1',
  phone_number: '573001112233',
  timezone: 'America/Bogota',
};

function setupSupabase(rows: unknown[]) {
  const selectBuilder = {} as SelectBuilder;
  selectBuilder.select = vi.fn(() => selectBuilder);
  selectBuilder.or = vi.fn(() => selectBuilder);
  selectBuilder.eq = vi.fn(() => selectBuilder);
  selectBuilder.in = vi.fn(() => selectBuilder);
  selectBuilder.order = vi.fn(() => selectBuilder);
  selectBuilder.limit = vi.fn(async () => ({ data: rows, error: null }));

  const updateSelect = vi.fn(async (): Promise<{ data: { id: string }[]; error: null }> => ({ data: [], error: null }));
  const updateIn = vi.fn((field: string, ids: string[]) => {
    updateSelect.mockResolvedValueOnce({ data: ids.map((id) => ({ id })), error: null });
    return { select: updateSelect };
  });
  const update = vi.fn(() => ({ in: updateIn }));

  untrustedResultMock(supabase.from)
    .mockReturnValueOnce(selectBuilder)
    .mockReturnValueOnce({ update });

  return { update, updateIn, updateSelect };
}

beforeEach(() => {
  vi.resetAllMocks();
});

describe('series-aware reminder cancellation', () => {
  it('returns the canonical missing-target error without a cancellation write', async () => {
    const update = vi.fn();
    const builder = {} as SelectBuilder & { update: typeof update };
    for (const method of ['select', 'or', 'eq', 'in', 'order', 'not', 'ilike', 'textSearch'] as const) {
      builder[method] = vi.fn(() => builder);
    }
    builder.limit = vi.fn(async () => ({ data: [], error: null }));
    builder.update = update;
    untrustedResultMock(supabase.from).mockReturnValue(builder);
    const result = await executeSingleReminderCancellation({
      params: { action: 'cancel', target: 'non-existent-uuid-12345678' }, user, language: 'es',
    });
    expect(result).toMatchObject({ success: false, errorCode: 'NOT_FOUND', error: 'No encontré ese recordatorio.' });
    expect(update).not.toHaveBeenCalled();
  });

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
        send_at: '2026-09-09T13:00:00.000Z',
      },
      {
        id: otherId,
        user_id: user.id,
        phone_number: user.phone_number,
        status: 'pending',
        acknowledged_at: null,
        content: 'Tomar agua',
        recurrence_rule: 'daily',
        send_at: '2026-09-09T20:00:00.000Z',
      },
    ];
    const db = setupSupabase(rows);

    const result = await executeSingleReminderCancellation({
      params: { action: 'cancel', target: targetId },
      user,
      language: 'es',
    });

    expect(result.success).toBe(true);
    expect(result.data!.cancelledCount).toBe(1);
    expect(db.updateIn).toHaveBeenCalledWith('id', [targetId]);
  });

  it('cancels active recurring reminder when base is resolved via fallback DB lookup outside initial slice', async () => {
    const recurringId = 'bbbbbbbb-1111-4111-8111-111111111111';
    const initialRows = [
      {
        id: 'gcal-1',
        user_id: user.id,
        phone_number: user.phone_number,
        status: 'pending',
        acknowledged_at: null,
        content: '🔔 [Google Calendar] Event in 15 minutes',
        recurrence_rule: null,
        send_at: '2040-09-09T13:00:00.000Z',
      },
    ];

    const fallbackRow = {
      id: recurringId,
      user_id: user.id,
      phone_number: user.phone_number,
      status: 'pending',
      acknowledged_at: null,
      content: 'Medicamento diarrea de Borona',
      recurrence_rule: 'hourly:6',
      send_at: '2026-09-26T03:00:00.000Z',
    };

    const selectBuilder1 = {} as SelectBuilder;
    selectBuilder1.select = vi.fn(() => selectBuilder1);
    selectBuilder1.or = vi.fn(() => selectBuilder1);
    selectBuilder1.eq = vi.fn(() => selectBuilder1);
    selectBuilder1.in = vi.fn(() => selectBuilder1);
    selectBuilder1.not = vi.fn(() => selectBuilder1);
    selectBuilder1.order = vi.fn(() => selectBuilder1);
    selectBuilder1.limit = vi.fn(async () => ({ data: initialRows, error: null }));

    const selectBuilderFallback = {} as SelectBuilder;
    selectBuilderFallback.select = vi.fn(() => selectBuilderFallback);
    selectBuilderFallback.or = vi.fn(() => selectBuilderFallback);
    selectBuilderFallback.eq = vi.fn(() => selectBuilderFallback);
    selectBuilderFallback.ilike = vi.fn(() => selectBuilderFallback);
    selectBuilderFallback.in = vi.fn(() => selectBuilderFallback);
    selectBuilderFallback.not = vi.fn(() => selectBuilderFallback);
    selectBuilderFallback.order = vi.fn(() => selectBuilderFallback);
    selectBuilderFallback.limit = vi.fn(async () => ({ data: [fallbackRow], error: null }));

    const updateSelect = vi.fn(async () => ({ data: [{ id: recurringId }], error: null }));
    const updateIn = vi.fn(() => ({ select: updateSelect }));
    const update = vi.fn(() => ({ in: updateIn }));

    untrustedResultMock(supabase.from)
      .mockReturnValueOnce(selectBuilder1)
      .mockReturnValueOnce(selectBuilderFallback)
      .mockReturnValueOnce({ update });

    const result = await executeSingleReminderCancellation({
      params: { action: 'cancel', target: 'Medicamento diarrea de Borona' },
      user,
      language: 'es',
    });

    expect(result.success).toBe(true);
    expect(result.action).toBe('cancelled_recurring_reminder_series');
    expect(result.data!.cancelledCount).toBe(1);
    expect(updateIn).toHaveBeenCalledWith('id', [recurringId]);
  });

  it('resolves a human target to the main reminder and cancels its linked advance notice', async () => {
    const mainId = '55555555-5555-4555-8555-555555555555';
    const noticeId = '66666666-6666-4666-8666-666666666666';
    const rows = [
      {
        id: mainId,
        user_id: user.id,
        phone_number: user.phone_number,
        status: 'pending',
        acknowledged_at: null,
        content: 'Llamar al veterinario',
        recurrence_rule: null,
        send_at: '2026-09-09T15:15:00.000Z',
      },
      {
        id: noticeId,
        user_id: user.id,
        phone_number: user.phone_number,
        status: 'pending',
        acknowledged_at: null,
        content: '🔔 [Aviso Previo] En 30 minutos: Llamar al veterinario',
        recurrence_rule: null,
        send_at: '2026-09-09T14:45:00.000Z',
      },
    ];
    const db = setupSupabase(rows);

    const result = await executeSingleReminderCancellation({
      params: { action: 'cancel', target: 'Llamar al veterinario' },
      user,
      language: 'es',
      correlationId: 'test-advance-child',
    });

    expect(result.success).toBe(true);
    expect(result.action).toBe('cancelled_reminder');
    expect(result.data).toMatchObject({
      cancelledCount: 2,
      logicalCancelledCount: 1,
      linkedAdvanceNoticesCancelled: 1,
      content: 'Llamar al veterinario',
    });
    expect(db.updateIn).toHaveBeenCalledWith('id', expect.arrayContaining([mainId, noticeId]));
    expect(db.updateIn.mock.calls[0]![1]).toHaveLength(2);
  });

  it('does not attach an advance notice to a same-content reminder at a different time', async () => {
    const morningId = '77777777-7777-4777-8777-777777777777';
    const afternoonId = '88888888-8888-4888-8888-888888888888';
    const afternoonNoticeId = '99999999-9999-4999-8999-999999999999';
    const rows = [
      {
        id: morningId,
        user_id: user.id,
        phone_number: user.phone_number,
        status: 'pending',
        acknowledged_at: null,
        content: 'Llamar a Pedro',
        recurrence_rule: null,
        send_at: '2026-09-09T13:00:00.000Z',
      },
      {
        id: afternoonId,
        user_id: user.id,
        phone_number: user.phone_number,
        status: 'pending',
        acknowledged_at: null,
        content: 'Llamar a Pedro',
        recurrence_rule: null,
        send_at: '2026-09-09T20:00:00.000Z',
      },
      {
        id: afternoonNoticeId,
        user_id: user.id,
        phone_number: user.phone_number,
        status: 'pending',
        acknowledged_at: null,
        content: '🔔 [Aviso Previo] En 30 minutos: Llamar a Pedro',
        recurrence_rule: null,
        send_at: '2026-09-09T19:30:00.000Z',
      },
    ];
    const db = setupSupabase(rows);

    const result = await executeSingleReminderCancellation({
      params: { action: 'cancel', target: morningId },
      user,
      language: 'es',
    });

    expect(result.success).toBe(true);
    expect(result.data!.linkedAdvanceNoticesCancelled).toBe(0);
    expect(db.updateIn).toHaveBeenCalledWith('id', [morningId]);
  });

  it('returns concrete ambiguous candidates so follow-up context can distinguish duplicates', async () => {
    const firstId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const secondId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    const rows = [
      {
        id: firstId,
        user_id: user.id,
        phone_number: user.phone_number,
        status: 'pending',
        acknowledged_at: null,
        content: 'Sacar una cita',
        recurrence_rule: null,
        send_at: '2026-09-11T14:00:00.000Z',
      },
      {
        id: secondId,
        user_id: user.id,
        phone_number: user.phone_number,
        status: 'pending',
        acknowledged_at: null,
        content: 'Sacar una cita',
        recurrence_rule: null,
        send_at: '2026-09-12T14:00:00.000Z',
      },
    ];
    setupSupabase(rows);

    const result = await executeSingleReminderCancellation({
      params: { action: 'cancel', target: 'Sacar una cita' },
      user,
      language: 'es',
    });

    expect(result.success).toBe(false);
    expect(result.errorCode).toBe('AMBIGUOUS_TARGET');
    expect(result.requiresClarification).toBe(true);
    expect(result.data!.reminders).toEqual([
      expect.objectContaining({ id: firstId, type: 'reminder', content: 'Sacar una cita', time: '2026-09-11T14:00:00.000Z' }),
      expect.objectContaining({ id: secondId, type: 'reminder', content: 'Sacar una cita', time: '2026-09-12T14:00:00.000Z' }),
    ]);
  });

  it('resolves and cancels target using full text search (FTS websearch) for conversational phrasing', async () => {
    const boronaId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
    const initialSlice = [
      {
        id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
        user_id: user.id,
        phone_number: user.phone_number,
        status: 'pending',
        acknowledged_at: null,
        content: 'Pagar servicio de internet',
        recurrence_rule: null,
        send_at: '2026-09-10T12:00:00.000Z',
      },
    ];
    const boronaRow = {
      id: boronaId,
      user_id: user.id,
      phone_number: user.phone_number,
      status: 'pending',
      acknowledged_at: null,
      content: 'Comprar medicamento de Borona',
      recurrence_rule: null,
      send_at: '2026-09-12T16:00:00.000Z',
    };

    const selectBuilder1 = {} as SelectBuilder;
    selectBuilder1.select = vi.fn(() => selectBuilder1);
    selectBuilder1.or = vi.fn(() => selectBuilder1);
    selectBuilder1.eq = vi.fn(() => selectBuilder1);
    selectBuilder1.in = vi.fn(() => selectBuilder1);
    selectBuilder1.not = vi.fn(() => selectBuilder1);
    selectBuilder1.order = vi.fn(() => selectBuilder1);
    selectBuilder1.limit = vi.fn(async () => ({ data: initialSlice, error: null }));

    const selectBuilderFts = {} as SelectBuilder;
    selectBuilderFts.select = vi.fn(() => selectBuilderFts);
    selectBuilderFts.textSearch = vi.fn(() => selectBuilderFts);
    selectBuilderFts.or = vi.fn(() => selectBuilderFts);
    selectBuilderFts.eq = vi.fn(() => selectBuilderFts);
    selectBuilderFts.in = vi.fn(() => selectBuilderFts);
    selectBuilderFts.not = vi.fn(() => selectBuilderFts);
    selectBuilderFts.order = vi.fn(() => selectBuilderFts);
    selectBuilderFts.limit = vi.fn(async () => ({ data: [boronaRow], error: null }));

    const updateSelect = vi.fn(async () => ({ data: [{ id: boronaId }], error: null }));
    const updateIn = vi.fn(() => ({ select: updateSelect }));
    const update = vi.fn(() => ({ in: updateIn }));

    untrustedResultMock(supabase.from)
      .mockReturnValueOnce(selectBuilder1)
      .mockReturnValueOnce(selectBuilderFts)
      .mockReturnValueOnce({ update });

    const result = await executeSingleReminderCancellation({
      params: { action: 'cancel', target: 'lo de borona' },
      user,
      language: 'es',
    });

    expect(selectBuilderFts.textSearch).toHaveBeenCalledWith('content', 'lo de borona', {
      type: 'websearch',
      config: 'spanish',
    });
    expect(result.success).toBe(true);
    expect(result.action).toBe('cancelled_reminder');
    expect(result.data!.content).toBe('Comprar medicamento de Borona');
    expect(updateIn).toHaveBeenCalledWith('id', [boronaId]);
  });
});

