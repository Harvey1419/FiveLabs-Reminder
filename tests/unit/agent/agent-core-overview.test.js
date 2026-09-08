import { describe, expect, it } from 'vitest';
import { formatActiveFollowups, formatCompactOverview } from '../../../src/agent/core/agent-core.js';

describe('agent live overview', () => {
  it('exposes counts for orientation but never item content', () => {
    const text = formatCompactOverview({
      pendingConfirmationReminders: [{ content: 'Recordatorio antiguo sensible' }],
      timedRemindersToday: [{ content: 'Comprar leche', localTime: '9:00 a. m.' }],
      tasksDueToday: [{ title: 'Pagar factura' }],
      openTasks: [{ title: 'Tarea sin fecha' }],
      openTasksByEntity: { Reminder: [{ title: 'Mejorar memoria' }] },
    });

    expect(text).toContain('Avisos de seguimiento activos: 1');
    expect(text).toContain('Recordatorios programados hoy: 1');
    expect(text).toContain('Tareas con vencimiento hoy: 1');
    expect(text).not.toContain('Recordatorio antiguo sensible');
    expect(text).not.toContain('Comprar leche');
    expect(text).not.toContain('Pagar factura');
    expect(text).not.toContain('Tarea sin fecha');
    expect(text).not.toContain('Mejorar memoria');
  });

  it('exposes only active confirmation reminders as authoritative interaction context', () => {
    const text = formatActiveFollowups({
      pendingConfirmationReminders: [
        { id: 'internal-id-never-exposed', content: 'cita', localFormatted: 'Hoy a las 4:00 PM', nudgeCount: 1 },
      ],
      timedRemindersToday: [{ content: 'Comprar leche' }],
    });

    expect(text).toContain('Seguimientos activos');
    expect(text).toContain('cita');
    expect(text).toContain('Hoy a las 4:00 PM');
    expect(text).toContain('avisos_enviados=1');
    expect(text).not.toContain('internal-id-never-exposed');
    expect(text).not.toContain('Comprar leche');
  });

  it('returns no follow-up context when nothing awaits confirmation', () => {
    expect(formatActiveFollowups({ pendingConfirmationReminders: [] })).toBe('');
  });
});