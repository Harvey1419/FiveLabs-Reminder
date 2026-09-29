import { describe, expect, it } from 'vitest';
import { resolveNextBestAction } from '../../../src/agent/orchestration/next-best-action.js';
import { TOOL_NAMES } from '../../../src/agent/contracts/tool-names.js';

describe('Next Best Action (proactive cycle closure)', () => {
  const baseUser = {
    id: 'user-1',
    preferences: [],
    locale: 'es-CO',
  };

  it('returns null when no completion facts exist', () => {
    const facts = [
      { tool: TOOL_NAMES.MANAGE_REMINDER, action: 'created_reminder', success: true },
    ];
    const overview = { timedRemindersToday: [{ title: 'Comprar leche' }] };
    expect(resolveNextBestAction({ executionFacts: facts, dailyOverview: overview, user: baseUser })).toBeNull();
  });

  it('returns null when completion fact was not successful', () => {
    const facts = [
      { tool: TOOL_NAMES.MANAGE_TASK, action: 'completed_task', success: false },
    ];
    const overview = { tasksDueToday: [{ title: 'Revisar métricas' }] };
    expect(resolveNextBestAction({ executionFacts: facts, dailyOverview: overview, user: baseUser })).toBeNull();
  });

  it('suppresses suggestion when turn already includes read actions', () => {
    const facts = [
      { tool: TOOL_NAMES.MANAGE_TASK, action: 'completed_task', success: true, presentationData: { id: 't1' } },
      { tool: TOOL_NAMES.MANAGE_TASK, action: 'listed_tasks', success: true },
    ];
    const overview = { tasksDueToday: [{ id: 't2', title: 'Revisar métricas' }] };
    expect(resolveNextBestAction({ executionFacts: facts, dailyOverview: overview, user: baseUser })).toBeNull();
  });

  it('respects user preference against proactive suggestions', () => {
    const userWithAntiPreference = {
      ...baseUser,
      preferences: [{ category: 'communication', content: 'Prefiero sin sugerencias proactivas' }],
    };
    const facts = [
      { tool: TOOL_NAMES.MANAGE_TASK, action: 'completed_task', success: true, presentationData: { id: 't1' } },
    ];
    const overview = { tasksDueToday: [{ id: 't2', title: 'Revisar métricas' }] };
    expect(resolveNextBestAction({ executionFacts: facts, dailyOverview: overview, user: userWithAntiPreference })).toBeNull();
  });

  it('prioritizes pending unacknowledged follow-up reminders over scheduled items', () => {
    const facts = [
      { tool: TOOL_NAMES.MANAGE_TASK, action: 'completed_task', success: true, presentationData: { id: 't1', title: 'Comprar leche' } },
    ];
    const overview = {
      pendingConfirmationReminders: [
        { id: 'rem-followup', content: 'Llamar a Laura', localFormatted: 'Hoy 10:00 AM' },
      ],
      timedRemindersToday: [
        { id: 'rem-later', title: 'Reunión balance', localTime: '4:00 PM' },
      ],
    };

    const res = resolveNextBestAction({ executionFacts: facts, dailyOverview: overview, user: baseUser, language: 'es' });
    expect(res).not.toBeNull();
    expect(res.type).toBe('followup');
    expect(res.recommendationText).toContain('Todavía tenés pendiente confirmar el seguimiento de *Llamar a Laura*');
    expect(res.recommendationText).toContain('Hoy 10:00 AM');
  });

  it('recommends upcoming timed reminder when task is completed', () => {
    const facts = [
      { tool: TOOL_NAMES.MANAGE_TASK, action: 'completed_task', success: true, presentationData: { id: 't1', title: 'Enviar reporte' } },
    ];
    const overview = {
      timedRemindersToday: [
        { id: 'rem-1', title: 'Cita con el médico', localTime: '3:30 PM' },
      ],
      tasksDueToday: [
        { id: 't2', title: 'Otra tarea', entityName: 'Trabajo' },
      ],
    };

    const res = resolveNextBestAction({ executionFacts: facts, dailyOverview: overview, user: baseUser, language: 'es' });
    expect(res).not.toBeNull();
    expect(res.type).toBe('reminder');
    expect(res.recommendationText).toContain('Tu próximo recordatorio es *Cita con el médico* a las 3:30 PM');
  });

  it('recommends next task due today when reminder is acknowledged and no more timed reminders', () => {
    const facts = [
      {
        tool: TOOL_NAMES.MANAGE_REMINDER,
        action: 'acknowledged_reminder',
        success: true,
        presentationData: { id: 'rem-1', content: 'Tomar medicina' },
      },
    ];
    const overview = {
      pendingConfirmationReminders: [],
      timedRemindersToday: [
        { id: 'rem-1', content: 'Tomar medicina' }, // was just completed
      ],
      tasksDueToday: [
        { id: 't-due-1', title: 'Enviar facturas', entityName: 'Finanzas' },
      ],
    };

    const res = resolveNextBestAction({ executionFacts: facts, dailyOverview: overview, user: baseUser, language: 'es' });
    expect(res).not.toBeNull();
    expect(res.type).toBe('task_due_today');
    expect(res.recommendationText).toContain('Tu próxima tarea para hoy es *Enviar facturas* (📁 Finanzas)');
  });

  it('recommends open task to keep momentum when no timed reminders or due tasks remain', () => {
    const facts = [
      { tool: TOOL_NAMES.MANAGE_TASK, action: 'completed_task', success: true, presentationData: { id: 't1' } },
    ];
    const overview = {
      openTasks: [
        { id: 't-open-1', title: 'Rediseñar landing', entityName: 'FiveLabs' },
      ],
    };

    const res = resolveNextBestAction({ executionFacts: facts, dailyOverview: overview, user: baseUser, language: 'es' });
    expect(res).not.toBeNull();
    expect(res.type).toBe('open_task');
    expect(res.recommendationText).toContain('Si querés seguir con ritmo, tenés pendiente *Rediseñar landing* (📁 FiveLabs)');
  });

  it('celebrates all caught up with tomorrow preview when today is clear', () => {
    const facts = [
      { tool: TOOL_NAMES.MANAGE_TASK, action: 'completed_task', success: true, presentationData: { id: 't1', title: 'Última tarea' } },
    ];
    const overview = {
      tasksDueToday: [{ id: 't1', title: 'Última tarea' }],
      tomorrowReminders: [
        { id: 'rem-tom', title: 'Vuelo a Bogotá', localTime: '7:00 AM' },
      ],
    };

    const res = resolveNextBestAction({ executionFacts: facts, dailyOverview: overview, user: baseUser, language: 'es' });
    expect(res).not.toBeNull();
    expect(res.type).toBe('all_caught_up');
    expect(res.recommendationText).toContain('¡Todo listo por hoy!');
    expect(res.recommendationText).toContain('Tu primer compromiso de mañana es *Vuelo a Bogotá* a las 7:00 AM');
  });

  it('celebrates completely all caught up when today and tomorrow are clear', () => {
    const facts = [
      { tool: TOOL_NAMES.MANAGE_TASK, action: 'completed_task', success: true, presentationData: { id: 't1', title: 'Última tarea' } },
    ];
    const overview = {
      tasksDueToday: [{ id: 't1', title: 'Última tarea' }],
    };

    const res = resolveNextBestAction({ executionFacts: facts, dailyOverview: overview, user: baseUser, language: 'es' });
    expect(res).not.toBeNull();
    expect(res.type).toBe('all_caught_up');
    expect(res.recommendationText).toContain('¡Todo al día!');
    expect(res.recommendationText).toContain('No tenés más compromisos pendientes');
  });

  it('supports English localization', () => {
    const facts = [
      { tool: TOOL_NAMES.MANAGE_TASK, action: 'completed_task', success: true, presentationData: { id: 't1' } },
    ];
    const overview = {
      timedRemindersToday: [
        { id: 'rem-1', title: 'Team meeting', localTime: '4:00 PM' },
      ],
    };

    const res = resolveNextBestAction({ executionFacts: facts, dailyOverview: overview, user: baseUser, language: 'en' });
    expect(res).not.toBeNull();
    expect(res.recommendationText).toBe('💡 *Next up*: Your next reminder is *Team meeting* at 4:00 PM.');
  });
});
