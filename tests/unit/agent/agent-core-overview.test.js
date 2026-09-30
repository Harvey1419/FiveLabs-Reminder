import { describe, expect, it } from 'vitest';
import { buildAgentCorePrompt, formatActiveFollowups, formatCompactOverview, formatProjectReferences } from '../../../src/agent/core/agent-core.js';

describe('agent live overview', () => {
  it('exposes counts for orientation but never item content', () => {
    const text = formatCompactOverview({
      pendingConfirmationReminders: [{ content: 'Recordatorio antiguo sensible' }],
      timedRemindersToday: [{ content: 'Comprar leche', localTime: '9:00 a. m.' }],
      tasksDueToday: [{ title: 'Pagar factura' }],
      openTasks: [{ title: 'Tarea sin fecha' }],
      openTasksByEntity: { Reminder: [{ title: 'Mejorar memoria' }] },
    });

    expect(text).toContain('Avisos de seguimiento activos: 1');
    expect(text).toContain('Recordatorios programados hoy: 1');
    expect(text).toContain('Tareas con vencimiento hoy: 1');
    expect(text).not.toContain('Recordatorio antiguo sensible');
    expect(text).not.toContain('Comprar leche');
    expect(text).not.toContain('Pagar factura');
    expect(text).not.toContain('Tarea sin fecha');
    expect(text).not.toContain('Mejorar memoria');
  });

  it('exposes only active confirmation reminders as authoritative interaction context', () => {
    const text = formatActiveFollowups({
      pendingConfirmationReminders: [
        { id: 'internal-id-never-exposed', content: 'cita', localFormatted: 'Hoy a las 4:00 PM', nudgeCount: 1 },
      ],
      timedRemindersToday: [{ content: 'Comprar leche' }],
    });

    expect(text).toContain('Seguimientos activos');
    expect(text).toContain('cita');
    expect(text).toContain('Hoy a las 4:00 PM');
    expect(text).toContain('avisos_enviados=1');
    expect(text).not.toContain('internal-id-never-exposed');
    expect(text).not.toContain('Comprar leche');
  });

  it('returns no follow-up context when nothing awaits confirmation', () => {
    expect(formatActiveFollowups({ pendingConfirmationReminders: [] })).toBe('');
  });


  it('anchors Hermes identity to Temple Labs and keeps casual conversation open', () => {
    const text = buildAgentCorePrompt({
      nowStr: '2026-09-27 22:54',
      nowHumanStr: 'domingo, 27 de septiembre de 2026, 10:54 p. m.',
      timezone: 'America/Bogota',
      memoryHints: '',
      overview: null,
      isPro: true,
    });

    expect(text).toContain('creado por Temple Labs');
    expect(text).toContain('No te presentes como ChatGPT, OpenAI, Groq, Google, Anthropic');
    expect(text).toContain('puedes conversar naturalmente');
    expect(text).toContain('¿En qué puedo ayudarte?');
    expect(text).toContain('No la repitas mecánicamente');
  });

  it('provides names for semantic resolution, never task values or language matching', () => {
    const overview = { pendingTasksByEntity: {
      Taller: [{ title: 'devolver 720.000 pesos', status: 'pending' }],
      Trabajo: [{ title: 'enviar reporte' }],
    } };
    const references = formatProjectReferences(overview);
    expect(references).toContain('Taller');
    expect(references).toContain('Trabajo');
    expect(references).not.toContain('720.000');
    expect(references).not.toContain('enviar reporte');
    expect(formatProjectReferences(null)).toBe('');
  });

  it('keeps stateful answers on the read path instead of answering from prefetched prose', () => {
    const prompt = buildAgentCorePrompt({
      nowStr: '2026-09-29T18:00:00-05:00', nowHumanStr: '29 de septiembre', timezone: 'America/Bogota',
      overview: { pendingTasksByEntity: { Taller: [{ title: 'devolver 720.000 pesos' }] } },
    });
    expect(prompt).toContain('readAnswer');
    expect(prompt).toContain('task.list(entityName, query?)');
    expect(prompt).not.toContain('720.000');
    expect(prompt).not.toContain('sin task.list ni cards');
    expect(prompt).not.toContain('van directo en conversation.reply');
  });
});
