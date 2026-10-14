import { untrustedResultMock } from '../../support/unit/contract-boundary.js';
import { describe, it, expect, vi } from 'vitest';
import { formatMorningBriefingMessage, claimMorningBriefing } from '../../../src/jobs/morning-briefing.js';
import { formatCompactOverview } from '../../../src/agent/core/agent-core.js';
import { supabase } from '../../../src/infrastructure/database/index.js';

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
    expect(msg).toContain('2. Esparadrapo');
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
    expect(msg).toContain('1. Esparadrapo');
  });

  it('omits companion Google Calendar reminders from timed reminders section when Calendar is connected', () => {
    const overview = {
      timedRemindersToday: [
        { id: 'rem-gcal-1', delivery_id: 'gcal:ev-123', content: '🔔 [Google Calendar] Cita médica en 15 minutos', localTime: '9:45 a. m.' },
        { id: 'rem-custom-1', delivery_id: null, content: 'Tomar café', localTime: '11:00 a. m.' },
      ],
      tasksDueToday: [],
      openTasksByEntity: {},
      openTasksGeneral: [],
    };
    const calendar = {
      state: 'CONNECTED',
      events: [{ summary: 'Cita médica', localStartTime: '10:00 a. m.', isAllDay: false }],
    };

    const msg = formatMorningBriefingMessage({ overview, calendar, timezone: 'America/Bogota' });
    expect(msg).toContain('📅 *Compromisos en Google Calendar:*');
    expect(msg).toContain('Cita médica');
    expect(msg).toContain('⏰ *Compromisos con hora fija:*');
    expect(msg).toContain('Tomar café');
    expect(msg).not.toContain('🔔 [Google Calendar] Cita médica');
  });

  it('formats morning briefing in English when language is en or user locale is en-US', () => {
    const overview = {
      timedRemindersToday: [{ id: 'rem-1', content: 'Standup meeting', localTime: '9:00 AM' }],
      tasksDueToday: [{ id: 'task-1', title: 'Ship feature', localTime: '5:00 PM' }],
      openTasksByEntity: { 'Sprint 42': [{ id: 'task-2', title: 'Write unit tests' }] },
      openTasksGeneral: [],
    };
    const calendar = {
      state: 'CONNECTED',
      events: [{ summary: 'Client Demo', localStartTime: '11:00 AM', isAllDay: false }],
    };

    const msg = formatMorningBriefingMessage({
      overview,
      calendar,
      timezone: 'America/New_York',
      language: 'en',
    });

    expect(msg).toContain('Good morning!');
    expect(msg).toContain('Google Calendar Commitments:');
    expect(msg).toContain('Client Demo');
    expect(msg).toContain('Scheduled Commitments:');
    expect(msg).toContain('Standup meeting');
    expect(msg).toContain('Tasks to Complete Today:');
    expect(msg).toContain('Due today');
    expect(msg).toContain('Ship feature');
    expect(msg).toContain('Executive tip:');
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

  it('renders compact notes badge instead of dumping raw task notes into briefing', () => {
    const overview = {
      timedRemindersToday: [],
      tasksDueToday: [
        {
          id: 'task-1',
          title: 'Configurar pasarela',
          description: 'Esta es una nota larguísima que no debe inundar el mensaje\nSegunda línea de detalles',
          entityName: 'Pagos',
        },
      ],
      openTasksByEntity: {
        'Productos Inteligentes': [
          {
            id: 'task-2',
            title: 'Producto de Meta Ads',
            description: 'Detalle de configuración de API y token de acceso',
          },
        ],
      },
      openTasksGeneral: [
        {
          id: 'task-3',
          title: 'Comprar insumos',
        },
      ],
    };

    const msg = formatMorningBriefingMessage({ overview, timezone: 'America/Bogota' });
    expect(msg).toContain('Configurar pasarela [Pagos] 📝 _(2 notas)_');
    expect(msg).toContain('2. Producto de Meta Ads 📝 _(1 nota)_');
    expect(msg).toContain('3. Comprar insumos');
    expect(msg).not.toContain('Esta es una nota larguísima');
    expect(msg).not.toContain('Detalle de configuración de API');
  });
});

describe('Distributed Worker Idempotency (claimMorningBriefing)', () => {
  it('claims briefing when user has never received a briefing or received one yesterday', async () => {
    untrustedResultMock(vi.spyOn(supabase, 'from')).mockReturnValue({
      update: () => ({
        eq: () => ({
          or: () => ({
            select: () => Promise.resolve({ data: [{ id: 'user-1' }], error: null }),
          }),
        }),
      }),
    });

    const claimed = await claimMorningBriefing('user-1', 'America/Bogota');
    expect(claimed).toBe(true);
    vi.restoreAllMocks();
  });

  it('rejects claim when another worker has already claimed or dispatched today', async () => {
    untrustedResultMock(vi.spyOn(supabase, 'from')).mockReturnValue({
      update: () => ({
        eq: () => ({
          or: () => ({
            select: () => Promise.resolve({ data: [], error: null }),
          }),
        }),
      }),
    });

    const claimed = await claimMorningBriefing('user-1', 'America/Bogota');
    expect(claimed).toBe(false);
    vi.restoreAllMocks();
  });
});

