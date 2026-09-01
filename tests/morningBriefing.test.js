import { describe, it, expect } from 'vitest';
import { formatMorningBriefingMessage, formatBriefingDate } from '../src/workers/morningBriefing.js';
import { formatCompactOverview } from '../src/ai/agentCore.js';

describe('Morning Briefing & Overview Domain Separation', () => {
  it('formats empty briefing cleanly when no reminders or tasks exist', () => {
    const emptyOverview = {
      timedRemindersToday: [],
      tasksDueToday: [],
      openTasksByEntity: {},
      openTasksGeneral: [],
      tomorrow: [],
      upcoming: [],
    };

    const msg = formatMorningBriefingMessage({ overview: emptyOverview, timezone: 'America/Bogota' });
    expect(msg).toContain('¡Buenos días!');
    expect(msg).toContain('no tienes citas programadas ni tareas pendientes');
    expect(msg).not.toContain('Compromisos con hora fija');
    expect(msg).not.toContain('📁');
  });

  it('strictly separates timed reminders from open project tasks without inventing alarm hours', () => {
    const overview = {
      timedRemindersToday: [
        {
          id: 'rem-1',
          content: 'Hacer lección de Duolingo',
          localTime: '8:00 a. m.',
          recurrenceRule: 'daily',
        },
        {
          id: 'rem-2',
          content: 'Cita en Madecentro',
          localTime: '9:00 a. m.',
          recurrenceRule: null,
        },
      ],
      tasksDueToday: [
        {
          id: 'task-due-1',
          title: 'Entregar informe contable',
          localTime: '5:00 p. m.',
          entityName: 'Finanzas',
        },
      ],
      openTasksByEntity: {
        'Lista de compras': [
          { id: 'task-1', title: 'Esparadrapo', localTime: null },
          { id: 'task-2', title: 'Algodón laminado', localTime: null },
        ],
        'Archivo Sonoro': [
          { id: 'task-3', title: 'Revisar gestión de descargas (7 días)', localTime: null },
        ],
      },
      openTasksGeneral: [
        { id: 'task-4', title: 'Comprar bombillo de repuesto', localTime: null },
      ],
    };

    const msg = formatMorningBriefingMessage({ overview, timezone: 'America/Bogota' });

    // Timed reminders section
    expect(msg).toContain('⏰ *Compromisos con hora fija:*');
    expect(msg).toContain('• ⏰ *8:00 a. m.* — Hacer lección de Duolingo _(Recurrente)_');
    expect(msg).toContain('• ⏰ *9:00 a. m.* — Cita en Madecentro');

    // Tasks due today section
    expect(msg).toContain('📌 *Tareas para completar hoy:*');
    expect(msg).toContain('• 🎯 *Vence hoy _(antes de las 5:00 p. m.)_:* Entregar informe contable [Finanzas]');

    // Open tasks grouped by entity
    expect(msg).toContain('📁 *Lista de compras:*');
    expect(msg).toContain('▫️ Esparadrapo');
    expect(msg).toContain('▫️ Algodón laminado');
    expect(msg).toContain('📁 *Archivo Sonoro:*');
    expect(msg).toContain('▫️ Revisar gestión de descargas (7 días)');

    // General tasks
    expect(msg).toContain('📋 *Otros pendientes:*');
    expect(msg).toContain('▫️ Comprar bombillo de repuesto');

    // Make sure open tasks DO NOT have fake ⏰ prefixes
    expect(msg).not.toContain('⏰ *null*');
    expect(msg).not.toContain('• ⏰ *12:19 p. m.*: Esparadrapo');
  });

  it('formats briefing when only open project tasks exist (no fixed-time reminders)', () => {
    const overview = {
      timedRemindersToday: [],
      tasksDueToday: [],
      openTasksByEntity: {
        'Lista de compras': [
          { id: 'task-1', title: 'Esparadrapo', localTime: null },
        ],
      },
      openTasksGeneral: [],
    };

    const msg = formatMorningBriefingMessage({ overview, timezone: 'America/Bogota' });

    expect(msg).not.toContain('Compromisos con hora fija');
    expect(msg).toContain('📋 *Tus tareas y pendientes abiertos:*');
    expect(msg).toContain('📁 *Lista de compras:*');
    expect(msg).toContain('▫️ Esparadrapo');
  });

  it('formatCompactOverview renders distinct sections for agent LLM prompt', () => {
    const overview = {
      timedRemindersToday: [
        { id: 'rem-1', content: 'Reunión directiva', localTime: '10:00 a. m.' },
      ],
      tasksDueToday: [
        { id: 'task-1', title: 'Pagar nómina', localTime: '12:00 p. m.', entityName: 'Finanzas' },
      ],
      openTasksByEntity: {
        'Proyecto Alpha': [
          { id: 'task-2', title: 'Diseñar arquitectura' },
        ],
      },
      openTasksGeneral: [
        { id: 'task-3', title: 'Llamar al fontanero' },
      ],
      doneToday: [],
    };

    const text = formatCompactOverview(overview);

    expect(text).toContain('*Recordatorios de hoy con hora fija*:');
    expect(text).toContain('- ⏰ 10:00 a. m.: Reunión directiva');
    expect(text).toContain('*Tareas que vencen hoy*:');
    expect(text).toContain('- 🎯 Pagar nómina (antes de las 12:00 p. m.) [Proyecto: Finanzas]');
    expect(text).toContain('*Tareas y Proyectos abiertos (sin hora fija)*:');
    expect(text).toContain('📁 [Proyecto Alpha]:');
    expect(text).toContain('▫️ Diseñar arquitectura');
    expect(text).toContain('- 📌 Llamar al fontanero');
  });
});
