import { describe, expect, it } from 'vitest';
import { formatCanonicalReminderList } from '../../../src/shared/reminder-presentation.js';

describe('canonical reminder list presentation', () => {
  it('uses one WhatsApp bold marker pair and separates time onto its own line', () => {
    const card = formatCanonicalReminderList({
      reminders: [
        {
          content: 'Me amo mucho',
          send_at: '2026-09-08T13:00:00.000Z',
          recurrence_rule: 'daily',
        },
        {
          content: 'cita en cerámica Italia',
          send_at: '2026-09-08T14:30:00.000Z',
          recurrence_rule: null,
        },
      ],
    }, { language: 'es', timezone: 'America/Bogota' });

    expect(card).toContain('🔔 *Recordatorios pendientes*');
    expect(card).toContain('1. *Me amo mucho* · recurrente');
    expect(card).toContain('2. *cita en cerámica Italia*');
    expect(card).toContain('🕒');
    expect(card).not.toContain('**Recordatorios pendientes**');
    expect(card).not.toContain('**Me amo mucho**');
  });
});
