import { describe, expect, it } from 'vitest';
import {
  PRESENTATION_KINDS,
  classifyTurnPresentation,
  composeTurnPresentation,
} from '../../../src/agent/core/presentation-policy.js';
import { TOOL_NAMES } from '../../../src/agent/contracts/tool-names.js';

function fact({
  tool,
  requestedAction,
  data = null,
  success = true,
  summary = 'ok',
  card = 'ok',
  requiresClarification = false,
  params = {},
  complete = true,
}) {
  return {
    tool,
    requestedAction,
    action: requestedAction,
    success,
    complete,
    summary,
    card,
    requiresClarification,
    presentationData: data,
    presentationParams: params,
    presentationContext: { timezone: 'America/Bogota', language: 'es' },
  };
}

describe('turn-level presentation policy', () => {
  it('classifies homogeneous and mixed turns independently of domain', () => {
    const reminders = [
      fact({ tool: TOOL_NAMES.MANAGE_REMINDER, requestedAction: 'create' }),
      fact({ tool: TOOL_NAMES.MANAGE_REMINDER, requestedAction: 'create' }),
    ];
    expect(classifyTurnPresentation(reminders)).toBe(PRESENTATION_KINDS.HOMOGENEOUS_BATCH);

    const mixed = [
      reminders[0],
      fact({ tool: TOOL_NAMES.MANAGE_TASK, requestedAction: 'create' }),
    ];
    expect(classifyTurnPresentation(mixed)).toBe(PRESENTATION_KINDS.MIXED_BATCH);
  });

  it('aggregates reminder creates into one response and treats advance notice as metadata', () => {
    const facts = [
      fact({
        tool: TOOL_NAMES.MANAGE_REMINDER,
        requestedAction: 'create',
        data: [{ content: 'Tomar vitaminas', sendAt: '2026-09-09T12:30:00.000Z', recurrenceRule: 'daily' }],
      }),
      fact({
        tool: TOOL_NAMES.MANAGE_REMINDER,
        requestedAction: 'create',
        data: [
          { content: '🔔 [Aviso Previo] En 30 minutos: Veterinario', displayContent: 'Veterinario', isAdvanceNotice: true, sendAt: '2026-09-09T14:45:00.000Z' },
          { content: 'Veterinario', isAdvanceNotice: false, sendAt: '2026-09-09T15:15:00.000Z' },
        ],
      }),
    ];

    const text = composeTurnPresentation(facts, 'es');
    expect(text.match(/recordatorios programados/g)?.length).toBe(1);
    expect(text).toContain('2 recordatorios programados');
    expect(text).toContain('Aviso previo');
    expect(text.match(/Veterinario/g)?.length).toBe(1);
  });

  it('aggregates task creates with project grouping', () => {
    const facts = [
      fact({
        tool: TOOL_NAMES.MANAGE_TASK,
        requestedAction: 'create',
        data: [{ title: 'Preparar propuesta', entityName: 'Trabajo' }],
      }),
      fact({
        tool: TOOL_NAMES.MANAGE_TASK,
        requestedAction: 'create',
        data: [{ title: 'Enviar factura', entityName: 'Trabajo' }],
      }),
    ];

    const text = composeTurnPresentation(facts, 'es');
    expect(text).toContain('2 tareas creadas');
    expect(text.match(/📁 \*Trabajo\*/g)?.length).toBe(1);
    expect(text).toContain('1. Preparar propuesta');
    expect(text).toContain('2. Enviar factura');
  });

  it('composes mixed domains as one turn without nesting full cards', () => {
    const facts = [
      fact({
        tool: TOOL_NAMES.MANAGE_REMINDER,
        requestedAction: 'create',
        data: [{ content: 'Tomar agua', sendAt: '2026-09-09T13:00:00.000Z' }],
        card: '✅ *Recordatorio programado*\n\n⏰ *Tomar agua*',
      }),
      fact({
        tool: TOOL_NAMES.MANAGE_TASK,
        requestedAction: 'create',
        data: [{ title: 'Llamar a Pedro', entityName: 'Trabajo' }],
        card: '✅ *Tarea creada*\n\nLlamar a Pedro',
      }),
    ];

    const text = composeTurnPresentation(facts, 'es');
    expect(text).toContain('2 acciones realizadas');
    expect(text).toContain('🔔 *Recordatorios · creados*');
    expect(text).toContain('☑️ *Tareas · creados*');
    expect(text).toContain('Tomar agua');
    expect(text).toContain('Llamar a Pedro');
    expect(text).not.toContain('Recordatorio programado');
    expect(text).not.toContain('Tarea creada');
  });

  it('puts verified successes before failures in partial-success turns', () => {
    const facts = [
      fact({
        tool: TOOL_NAMES.MANAGE_TASK,
        requestedAction: 'complete',
        data: { title: 'Cerrar reporte' },
        params: { target: 'Cerrar reporte' },
      }),
      fact({
        tool: TOOL_NAMES.MANAGE_REMINDER,
        requestedAction: 'cancel',
        success: false,
        summary: 'No encontré ese recordatorio.',
        card: '⚠️ No encontré ese recordatorio.',
        params: { target: 'Algo inexistente' },
      }),
    ];

    expect(classifyTurnPresentation(facts)).toBe(PRESENTATION_KINDS.PARTIAL_SUCCESS);
    const text = composeTurnPresentation(facts, 'es');
    expect(text.indexOf('Cerrar reporte')).toBeLessThan(text.indexOf('No encontré ese recordatorio'));
    expect(text).toContain('1 acción no se pudo completar');
  });

  it('does not describe a partial successful outcome as fully completed', () => {
    const partial = fact({
      tool: TOOL_NAMES.MANAGE_REMINDER,
      requestedAction: 'create',
      data: { items: [{ content: 'Main appointment' }], rejected: [{ content: 'Advance notice', code: 'DATABASE_ERROR' }] },
      summary: 'Main appointment was saved, but its advance notice could not be saved.',
      card: '✅ Main appointment saved. Advance notice failed.',
      complete: false,
    });

    expect(classifyTurnPresentation([partial])).toBe(PRESENTATION_KINDS.PARTIAL_SUCCESS);
    const text = composeTurnPresentation([partial], 'en');
    expect(text).toContain('partially completed');
    expect(text).toContain('advance notice could not be saved');
    expect(text).not.toContain('1 actions completed');
    expect(text).not.toMatch(/✅ \*?1?\s*Reminders? ·/);
  });

  it('keeps verified successes aggregated when one action needs clarification', () => {
    const facts = [
      fact({
        tool: TOOL_NAMES.MANAGE_REMINDER,
        requestedAction: 'cancel',
        data: { content: 'Tomar vitaminas', recurring: true, recurrenceRule: 'daily' },
        card: '🗑️ *Recordatorio recurrente eliminado*\n\n🔁 *Tomar vitaminas*',
      }),
      fact({
        tool: TOOL_NAMES.MANAGE_REMINDER,
        requestedAction: 'cancel',
        data: { content: 'Preparar la ropa', recurring: true, recurrenceRule: 'daily' },
        card: '🗑️ *Recordatorio recurrente eliminado*\n\n🔁 *Preparar la ropa*',
      }),
      fact({
        tool: TOOL_NAMES.MANAGE_REMINDER,
        requestedAction: 'cancel',
        success: false,
        requiresClarification: true,
        summary: 'Hay varios recordatorios que coinciden. Dime cuál quieres eliminar.',
        card: 'Hay varios recordatorios que coinciden. Dime cuál quieres eliminar.',
        params: { target: 'Llamar al veterinario' },
      }),
    ];

    expect(classifyTurnPresentation(facts)).toBe(PRESENTATION_KINDS.PARTIAL_SUCCESS);
    const text = composeTurnPresentation(facts, 'es');
    expect(text).toContain('2 recordatorios eliminados');
    expect(text.match(/Recordatorio recurrente eliminado/g)).toBeNull();
    expect(text).toContain('1 necesita aclaración');
    expect(text).toContain('Hay varios recordatorios que coinciden');
    expect(text.indexOf('2 recordatorios eliminados')).toBeLessThan(text.indexOf('1 necesita aclaración'));
  });

  it('keeps a clarification-only turn as a clarification response', () => {
    const facts = [
      fact({
        tool: TOOL_NAMES.MANAGE_REMINDER,
        requestedAction: 'cancel',
        success: false,
        requiresClarification: true,
        card: '¿Cuál recordatorio?',
      }),
      fact({
        tool: TOOL_NAMES.MANAGE_TASK,
        requestedAction: 'complete',
        success: false,
        requiresClarification: true,
        card: '¿Cuál tarea?',
      }),
    ];
    expect(classifyTurnPresentation(facts)).toBe(PRESENTATION_KINDS.CLARIFICATION);
    const text = composeTurnPresentation(facts, 'es');
    expect(text).toContain('2 necesitan aclaración');
    expect(text).toContain('¿Cuál recordatorio?');
    expect(text).toContain('¿Cuál tarea?');
  });

  it('presents successful reads as retrieved information, not completed actions', () => {
    const text = composeTurnPresentation([
      fact({
        tool: TOOL_NAMES.MANAGE_TASK,
        requestedAction: 'list',
        data: { tasks: [{ title: 'Revisar contrato' }] },
        card: '☑️ *Tareas pendientes*\n\n• Revisar contrato',
      }),
      fact({
        tool: TOOL_NAMES.MANAGE_REMINDER,
        requestedAction: 'list',
        data: { reminders: [{ content: 'Llamar a Ana' }] },
        card: '🔔 *Recordatorios pendientes*\n\n• Llamar a Ana',
      }),
      fact({
        tool: TOOL_NAMES.MANAGE_GOOGLE_CALENDAR,
        requestedAction: 'list_events',
        data: { events: [{ summary: 'CCS Daily interna' }] },
        card: 'Eventos en tu Google Calendar:\n• 📅 CCS Daily interna — Mañana a las 9:00 AM (Google Meet: https://meet.google.com/xck-dzjf-chx)',
      }),
    ], 'es');

    expect(text).toContain('Tareas pendientes');
    expect(text).toContain('Recordatorios pendientes');
    expect(text).toContain('Google Meet: https://meet.google.com/xck-dzjf-chx');
    expect(text).not.toContain('acciones realizadas');
    expect(text).not.toContain('realizadas');
  });

  it('keeps mutation framing when reads and mutations share a turn', () => {
    const text = composeTurnPresentation([
      fact({
        tool: TOOL_NAMES.MANAGE_TASK,
        requestedAction: 'list',
        card: '☑️ *Tareas pendientes*\n\n• Revisar contrato',
      }),
      fact({
        tool: TOOL_NAMES.MANAGE_TASK,
        requestedAction: 'complete',
        data: { title: 'Llamar a Ana' },
        card: '✅ *Tarea completada*\n\n• Llamar a Ana',
      }),
    ], 'es');

    expect(text).toContain('Tareas pendientes');
    expect(text).toContain('Tareas · 1 completados');
    expect(text).toContain('Llamar a Ana');
  });

  it('suppresses empty read cards when mutations are present in the turn', () => {
    const text = composeTurnPresentation([
      fact({
        tool: TOOL_NAMES.MANAGE_GOOGLE_CALENDAR,
        requestedAction: 'list_events',
        data: [],
        card: '📅 *Google Calendar*\nNo tienes eventos programados en Google Calendar para este período.',
        summary: 'No tienes eventos programados en Google Calendar para este período.',
      }),
      fact({
        tool: TOOL_NAMES.MANAGE_REMINDER,
        requestedAction: 'create',
        data: [{ content: 'Revisar agenda de mañana', sendAt: '2026-09-10T16:39:00.000Z' }],
        card: '🔔 *Recordatorio creado*\n\n• Revisar agenda de mañana',
      }),
    ], 'es');

    expect(text).toContain('Revisar agenda de mañana');
    expect(text).not.toContain('No tienes eventos programados');
  });
});
