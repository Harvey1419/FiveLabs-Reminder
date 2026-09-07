import { describe, expect, it } from 'vitest';
import { createExecutionFact } from '../../../src/agent/core/execution-facts.js';
import { TOOL_NAMES } from '../../../src/agent/contracts/tool-names.js';

describe('canonical task UX', () => {
  const tasks = [
    { id: '1', title: 'Gestionar mejor los proyectos', entities: { name: 'Reminder' } },
    { id: '2', title: 'Mejorar la gestión de memoria', entities: { name: 'Reminder' } },
    { id: '3', title: 'Comprar leche', entities: null },
  ];

  it('renders task.list as Project -> tasks', () => {
    const fact = createExecutionFact({
      toolName: TOOL_NAMES.MANAGE_TASK,
      params: { action: 'list' },
      result: {
        success: true,
        action: 'listed_tasks',
        data: { tasks, entityName: null },
        formattedCard: 'legacy formatter should not win',
      },
      language: 'es',
    });

    expect(fact.card).toContain('📁 *Reminder*\n• Gestionar mejor los proyectos\n• Mejorar la gestión de memoria');
    expect(fact.card).toContain('📌 *Sin proyecto*\n• Comprar leche');
    expect(fact.card).not.toContain('[Reminder]');
    expect(fact.card).not.toContain('legacy formatter should not win');
  });

  it('uses the same Project -> tasks hierarchy inside Unified Agenda', () => {
    const fact = createExecutionFact({
      toolName: TOOL_NAMES.GET_UNIFIED_AGENDA,
      params: { action: 'get_agenda', scope: 'all_pending' },
      result: {
        success: true,
        action: 'unified_agenda_listed',
        data: {
          scope: 'all_pending',
          calendar: { state: 'DISCONNECTED', events: [] },
          reminders: [],
          tasks,
        },
        formattedCard: 'legacy agenda formatter should not win',
      },
      language: 'es',
    });

    expect(fact.card).toContain('📅 *Google Calendar*\n🔒 No conectado');
    expect(fact.card).toContain('📁 *Reminder*\n• Gestionar mejor los proyectos\n• Mejorar la gestión de memoria');
    expect(fact.card).toContain('📌 *Sin proyecto*\n• Comprar leche');
    expect(fact.card).not.toContain('[Reminder]');
    expect(fact.card).not.toContain('legacy agenda formatter should not win');
  });
});
