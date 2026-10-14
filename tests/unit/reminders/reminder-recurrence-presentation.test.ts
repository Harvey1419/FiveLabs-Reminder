import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { formatCanonicalReminderCreate, formatRecurrenceLabel } from '../../../src/shared/reminder-presentation.js';

describe('canonical recurring reminder presentation', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-07T17:00:00.000Z'));
  });
  afterEach(() => vi.useRealTimers());
  it('shows daily recurrence explicitly on creation', () => {
    const card = formatCanonicalReminderCreate([
      {
        content: 'Me amo mucho',
        sendAt: '2026-09-08T13:00:00.000Z',
        formattedTime: 'Etiqueta obsoleta que no debe prevalecer',
        recurrenceRule: 'daily',
      },
    ], { language: 'es', timezone: 'America/Bogota' });

    expect(card).toContain('✅ *Recordatorio programado*');
    expect(card).toContain('🔁 *Me amo mucho*');
    expect(card).toMatch(/🗓️ Mañana.*8:00 AM/);
    expect(card).not.toContain('Etiqueta obsoleta');
    expect(card).not.toContain('2026');
    expect(card).not.toMatch(/^\s+🗓️/m);
    expect(card).toContain('🔁 Todos los días');
  });

  it('includes the canonical year only for a cross-year recurring occurrence', () => {
    const card = formatCanonicalReminderCreate([
      { content: 'Revisión anual', sendAt: '2027-09-08T13:00:00.000Z', formattedTime: 'Mañana a las 8:00 AM', recurrenceRule: 'yearly' },
    ], { language: 'es', timezone: 'America/Bogota' });
    expect(card).toContain('2027');
    expect(card).toContain('8:00 AM');
    expect(card).not.toContain('Mañana');
    expect(card).toContain('🔁 Todos los años');
  });

  it('maps canonical recurrence labels in Spanish and English', () => {
    expect(formatRecurrenceLabel('daily', 'es')).toBe('Todos los días');
    expect(formatRecurrenceLabel('weekdays', 'es')).toBe('De lunes a viernes');
    expect(formatRecurrenceLabel('weekly', 'en')).toBe('Every week');
  });

  it('does not show recurrence for one-shot reminders', () => {
    const card = formatCanonicalReminderCreate([
      { content: 'Salir', formattedTime: 'Hoy a las 7:00 PM' },
    ], { language: 'es', timezone: 'America/Bogota' });

    expect(card).not.toContain('🔁');
  });
});
