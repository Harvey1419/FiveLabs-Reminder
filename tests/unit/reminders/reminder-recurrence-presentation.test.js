import { describe, expect, it } from 'vitest';
import { formatCanonicalReminderCreate, formatRecurrenceLabel } from '../../../src/shared/reminder-presentation.js';

describe('canonical recurring reminder presentation', () => {
  it('shows daily recurrence explicitly on creation', () => {
    const card = formatCanonicalReminderCreate([
      {
        content: 'Me amo mucho',
        sendAt: '2026-09-08T13:00:00.000Z',
        formattedTime: 'Mañana a las 8:00 AM',
        recurrenceRule: 'daily',
      },
    ], { language: 'es', timezone: 'America/Bogota' });

    expect(card).toContain('✅ *Recordatorio programado*');
    expect(card).toContain('⏰ *Me amo mucho*');
    expect(card).toContain('📅 Mañana a las 8:00 AM');
    expect(card).toContain('🔁 *Todos los días*');
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
