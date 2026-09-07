import { describe, expect, it } from 'vitest';
import { formatAgendaWhatsAppCard } from '../../../src/features/agenda/presentation.js';

describe('Unified Agenda WhatsApp presentation', () => {
  it('shows Google Calendar as disconnected even when reminders and tasks exist', () => {
    const card = formatAgendaWhatsAppCard({
      scope: 'all_pending',
      timezone: 'America/Bogota',
      calendar: { state: 'DISCONNECTED', events: [] },
      reminders: [{ content: 'Test Update', sendAt: '2026-09-09T14:30:00.000Z' }],
      tasks: [{ title: 'Mejorar memoria', entityName: 'reminder', dueDate: null }],
    }, 'es');

    expect(card).toContain('📋 *Pendientes actuales*');
    expect(card).toContain('📅 *Google Calendar*');
    expect(card).toContain('🔒 No conectado');
    expect(card).toContain('🔔 *Recordatorios* · 1');
    expect(card).toContain('☑️ *Tareas* · 1');
    expect(card).toContain('📁 reminder');
  });

  it('shows a connected empty calendar as a valid empty source, not as disconnected', () => {
    const card = formatAgendaWhatsAppCard({
      scope: 'today',
      timezone: 'America/Bogota',
      calendar: { state: 'CONNECTED', events: [] },
      reminders: [],
      tasks: [],
    }, 'es');

    expect(card).toContain('✅ Sin eventos en este período.');
    expect(card).not.toContain('No conectado');
  });
});
