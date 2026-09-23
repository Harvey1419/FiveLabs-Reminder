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
    expect(card).not.toContain('**Recordatorios pendientes**');
    expect(card).not.toContain('**Me amo mucho**');
  });

  it('renders contextual headers for tomorrow and other temporal scopes', () => {
    const cardTomorrow = formatCanonicalReminderList({
      filter: 'tomorrow',
      reminders: [{ content: 'Pagar arriendo', send_at: '2026-09-09T15:00:00.000Z' }],
    }, { language: 'es', timezone: 'America/Bogota' });

    expect(cardTomorrow).toContain('🔔 *Recordatorios para mañana*');
    expect(cardTomorrow).toContain('1. *Pagar arriendo*');

    const cardEmptyTomorrow = formatCanonicalReminderList({
      filter: 'tomorrow',
      reminders: [],
    }, { language: 'es' });

    expect(cardEmptyTomorrow).toContain('🔔 *Recordatorios para mañana*');
    expect(cardEmptyTomorrow).toContain('No tienes recordatorios programados para mañana.');
  });
});
