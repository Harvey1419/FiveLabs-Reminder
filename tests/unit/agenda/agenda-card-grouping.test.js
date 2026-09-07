import { describe, expect, it } from 'vitest';
import { formatCanonicalAgenda } from '../../../src/shared/agenda-presentation.js';

describe('Unified Agenda task hierarchy', () => {
  it('groups tasks under their project instead of repeating project tags', () => {
    const card = formatCanonicalAgenda({
      calendar: { state: 'DISCONNECTED', events: [] },
      reminders: [],
      tasks: [
        { title: 'Gestionar mejor los proyectos', entityName: 'Reminder' },
        { title: 'Mejorar la gestión de memoria', entityName: 'Reminder' },
        { title: 'Comprar comida', entityName: null },
      ],
      scope: 'all_pending',
      timezone: 'America/Bogota',
    }, { language: 'es', timezone: 'America/Bogota' });

    expect(card).toContain('📁 *Reminder*\n• Gestionar mejor los proyectos\n• Mejorar la gestión de memoria');
    expect(card).toContain('📌 *Sin proyecto*\n• Comprar comida');
    expect(card).not.toContain('[Reminder]');
    expect(card).toContain('📅 *Google Calendar*\n🔒 No conectado');
  });
});
