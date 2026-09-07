import { describe, it, expect } from 'vitest';
import { formatMorningBriefingMessage } from '../../../src/jobs/morning-briefing.js';
import { formatCompactOverview } from '../../../src/agent/core/agent-core.js';

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
        { id: 'rem-1', content: 'Hacer lección de Duolingo', localTime: '8:00 a. m.', recurrenceRule: 'daily' },
        { id: 'rem-2', content: 'Cita en Madecentro', localTime: '9:00 a. m.', recurrenceRule: null },
      ],
      tasksDueToday: [
        { id: 'task-due-1', title: 'Entregar informe contable', localTime: '5:00 p. m.', entityName: 'Finanzas' },
      ],
      openTasksByEntity: {
        'Lista de compras': [
          { id: 'task-1', title: 'Esparadrapo', localTime: null },
          { id: 'task-2', title: 'Algodón laminado', localTime: null },
        ],
        'Archivo Sonoro': [{ id: 'task-3', title: 'Revisar gestión de descargas (7 días)', localTime: null }],
      },
      openTasksGeneral: [{ id: 'task-4', title: 'Comprar bombillo de repuesto', localTime: null }],
    };

    const msg = formatMorningBriefingMessage({ overview, timezone: 'America/Bogota' });
    expect(msg).toContain('⏰ *Compromisos con hora fija:*');
    expect(msg).toContain('Hacer lección de Duolingo');
    expect(msg).toContain('Cita en Madecentro');
    expect(msg).toContain('📌 *Tareas para completar hoy:*');
    expect(msg).toContain('Entregar informe contable');
    expect(msg).toContain('📁 *Lista de compras:*');
    expect(msg).toContain('▫️ Esparadrapo');
    expect(msg).toContain('📋 *Otros pendientes:*');
    expect(msg).not.toContain('⏰ *null*');
  });

  it('formats briefing when only open project tasks exist', () => {
    const overview = {
      timedRemindersToday: [],
      tasksDueToday: [],
      openTasksByEntity: { 'Lista de compras': [{ id: 'task-1', title: 'Esparadrapo', localTime: null }] },
      openTasksGeneral: [],
    };

    const msg = formatMorningBriefingMessage({ overview, timezone: 'America/Bogota' });
    expect(msg).not.toContain('Compromisos con hora fija');
    expect(msg).toContain('📋 *Tus tareas y pendientes abiertos:*');
    expect(msg).toContain('📁 *Lista de compras:*');
    expect(msg).toContain('▫️ Esparadrapo');
  });

  it('formatCompactOverview exposes counts only and never leaks an answer cache into the LLM prompt', () => {
    const overview = {
      pendingConfirmationReminders: [],
      timedRemindersToday: [{ id: 'rem-1', content: 'Reunión directiva', localTime: '10:00 a. m.' }],
      tasksDueToday: [{ id: 'task-1', title: 'Pagar nómina', localTime: '12:00 p. m.', entityName: 'Finanzas' }],
      openTasks: [{ id: 'task-2', title: 'Diseñar arquitectura', entityName: 'Proyecto Alpha' }],
      openTasksByEntity: { 'Proyecto Alpha': [{ id: 'task-2', title: 'Diseñar arquitectura' }] },
    };

    const text = formatCompactOverview(overview);
    expect(text).toContain('*[Estado vivo — solo orientación]*');
    expect(text).toContain('Recordatorios programados hoy: 1');
    expect(text).toContain('Tareas con vencimiento hoy: 1');
    expect(text).toContain('Proyectos/listas con tareas abiertas: 1');
    expect(text).not.toContain('Reunión directiva');
    expect(text).not.toContain('Pagar nómina');
    expect(text).not.toContain('Diseñar arquitectura');
  });
});
