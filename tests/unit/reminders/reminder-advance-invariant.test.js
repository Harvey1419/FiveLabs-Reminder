import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/infrastructure/database/index.js', () => ({
  supabase: {},
  saveReminder: vi.fn(),
  getRemindersByPhone: vi.fn(),
  cancelPendingRemindersByContent: vi.fn(),
  acknowledgeReminder: vi.fn(),
  acknowledgeReminders: vi.fn(),
  markReminderAsCancelled: vi.fn(),
  updateReminder: vi.fn(),
  createTask: vi.fn(),
  getUserSubscription: vi.fn().mockResolvedValue(null),
  hasProAccess: vi.fn().mockReturnValue(true),
  shouldEnforceBillingForUser: vi.fn().mockReturnValue(false),
}));

const { saveReminder } = await import('../../../src/infrastructure/database/index.js');
const { executeReminderCreate } = await import('../../../src/agent/tools/reminder-create.js');

describe('advance-notice scheduling invariant', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    saveReminder
      .mockResolvedValueOnce({ id: 'advance-1' })
      .mockResolvedValueOnce({ id: 'primary-1' });
  });

  it('expands one structured intent into an advance notice and the primary reminder', async () => {
    const result = await executeReminderCreate({
      params: {
        items: [{
          content: 'Cita para radiografías',
          targetTime: '2099-09-04T16:00:00-05:00',
          advanceMinutes: 30,
        }],
      },
      user: { id: 'user-1', phone_number: '+573000000001', timezone: 'America/Bogota' },
      isPro: true,
      language: 'es',
    });

    expect(result.success).toBe(true);
    expect(saveReminder).toHaveBeenCalledTimes(2);
    expect(saveReminder.mock.calls[0][0]).toMatchObject({
      content: 'Cita para radiografías',
      sendAt: '2099-09-04T21:00:00.000Z',
    });
    expect(saveReminder.mock.calls[1][0]).toMatchObject({
      content: expect.stringContaining('[Aviso Previo]'),
      sendAt: '2099-09-04T20:30:00.000Z',
      parentReminderId: 'advance-1',
      source: 'advance_notice',
    });
    expect(result.data).toHaveLength(2);
    expect(result.formattedCard).toContain('✅ *Recordatorios programados*\n\n');
    expect(result.formattedCard).toContain('🔔 *Aviso previo: Cita para radiografías*\n📅');
    expect(result.formattedCard).toContain('\n\n⏰ *Cita para radiografías*\n📅');
    expect(result.formattedCard).not.toContain('🔔 *🔔');
  });

  it('anchors every relative reminder in a batch to the same request timestamp', async () => {
    saveReminder.mockReset();
    saveReminder.mockResolvedValueOnce({ id: 'relative-1' }).mockResolvedValueOnce({ id: 'relative-2' });

    const result = await executeReminderCreate({
      params: {
        items: [
          { content: 'Salir', targetTime: 'PT2M' },
          { content: 'Salir', targetTime: 'PT5M' },
        ],
      },
      user: { id: 'user-1', phone_number: '+573000000001', timezone: 'America/Bogota' },
      isPro: true,
      language: 'es',
      referenceTime: new Date('2026-09-04T19:00:00.000Z'),
    });

    expect(result.success).toBe(true);
    expect(saveReminder.mock.calls.map(([call]) => call.sendAt)).toEqual([
      '2026-09-04T19:02:00.000Z',
      '2026-09-04T19:05:00.000Z',
    ]);
  });

  it('creates valid relative items and asks only about an elapsed item in the same batch', async () => {
    saveReminder.mockReset();
    saveReminder.mockResolvedValueOnce({ id: 'relative-10' }).mockResolvedValueOnce({ id: 'relative-20' });

    const result = await executeReminderCreate({
      params: {
        items: [
          { content: 'Llevar a mi amorcito', targetTime: 'PT10M' },
          { content: 'Decirle que la amo mucho', targetTime: 'PT20M' },
          {
            content: 'Cita de Borona en el veterinario',
            targetTime: '2026-09-04T16:00:00-05:00',
            advanceMinutes: 30,
          },
        ],
      },
      user: { id: 'user-1', phone_number: '+573000000001', timezone: 'America/Bogota' },
      isPro: true,
      language: 'es',
      referenceTime: new Date('2026-09-05T03:18:00.000Z'),
    });

    expect(result).toMatchObject({
      success: true,
      partialSuccess: true,
      complete: false,
      action: 'partially_created_reminders',
      requiresClarification: true,
    });
    expect(saveReminder).toHaveBeenCalledTimes(2);
    expect(saveReminder.mock.calls.map(([call]) => call.content)).toEqual([
      'Llevar a mi amorcito',
      'Decirle que la amo mucho',
    ]);
    expect(result.formattedCard).toContain('Recordatorios programados');
    expect(result.formattedCard).toContain('No programado');
    expect(result.formattedCard).toMatch(/mañana.*4:00/i);
    expect(result.pendingClarifications[0]).toMatchObject({
      content: 'Cita de Borona en el veterinario',
      advanceMinutes: 30,
      proposedReminder: {
        content: 'Cita de Borona en el veterinario',
        targetTime: '2026-09-05T21:00:00.000Z',
        advanceMinutes: 30,
      },
    });

    saveReminder.mockReset();
    saveReminder.mockResolvedValueOnce({ id: 'advance-tomorrow' }).mockResolvedValueOnce({ id: 'main-tomorrow' });
    const confirmed = await executeReminderCreate({
      params: { items: [result.pendingClarifications[0].proposedReminder] },
      user: { id: 'user-1', phone_number: '+573000000001', timezone: 'America/Bogota' },
      isPro: true,
      language: 'es',
      referenceTime: new Date('2026-09-05T03:53:00.000Z'),
    });

    expect(confirmed).toMatchObject({ success: true, action: 'created_reminders_batch' });
    expect(saveReminder.mock.calls.map(([call]) => call.sendAt)).toEqual([
      '2026-09-05T21:00:00.000Z',
      '2026-09-05T20:30:00.000Z',
    ]);
    expect(saveReminder.mock.calls[1][0]).toMatchObject({
      parentReminderId: 'advance-tomorrow',
      source: 'advance_notice',
    });
  });

  it('keeps typed model evidence free of phrase matching without allowing a past local time', async () => {
    saveReminder.mockReset();
    const result = await executeReminderCreate({
      params: {
        items: [{
          content: 'Cita veterinaria',
          targetTime: '2026-09-04T21:00:00.000Z',
        }],
      },
      user: { id: 'user-1', phone_number: '+573000000001', timezone: 'America/Bogota' },
      isPro: true,
      language: 'es',
      referenceTime: new Date('2026-09-05T03:18:00.000Z'),
    });

    expect(result).toMatchObject({
      success: false,
      errorCode: 'TIME_IN_PAST',
      requiresClarification: true,
      pendingClarifications: [expect.objectContaining({
        proposedReminder: expect.objectContaining({ targetTime: '2026-09-05T21:00:00.000Z' }),
      })],
    });
    expect(saveReminder).not.toHaveBeenCalled();
  });

  it('includes advance notice in the clarification proposal question when advanceMinutes is present', async () => {
    const result = await executeReminderCreate({
      params: {
        items: [{
          content: 'Cita y baño de Borona',
          targetTime: '2026-09-04T19:00:00.000Z',
          advanceMinutes: 30,
        }],
      },
      user: { id: 'user-1', phone_number: '+573000000001', timezone: 'America/Bogota' },
      isPro: true,
      language: 'es',
      referenceTime: new Date('2026-09-04T23:00:00.000Z'),
    });

    expect(result).toMatchObject({
      success: false,
      errorCode: 'TIME_IN_PAST',
      requiresClarification: true,
    });
    expect(result.pendingClarifications[0].question).toContain('con aviso 30 min antes');
  });

  it('reports an elapsed advance notice without hiding that only the main reminder was created', async () => {
    saveReminder.mockReset();
    saveReminder.mockResolvedValueOnce({ id: 'primary-only' });

    const result = await executeReminderCreate({
      params: {
        items: [{
          content: 'Llamada importante',
          targetTime: '2026-09-04T22:30:00-05:00',
          advanceMinutes: 30,
        }],
      },
      user: { id: 'user-1', phone_number: '+573000000001', timezone: 'America/Bogota' },
      isPro: true,
      language: 'es',
      referenceTime: new Date('2026-09-05T03:18:00.000Z'),
    });

    expect(result).toMatchObject({ success: true, partialSuccess: true, complete: false });
    expect(saveReminder).toHaveBeenCalledTimes(1);
    expect(saveReminder).toHaveBeenCalledWith(expect.objectContaining({ content: 'Llamada importante' }));
    expect(result.formattedCard).toContain('✅ *Recordatorio programado*\n\n⏰ *Llamada importante*\n📅');
    expect(result.formattedCard).toContain('momento del aviso previo ya pasó');
  });
});
