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

    expect(fact.card).toContain('📁 *Reminder*\n1. Gestionar mejor los proyectos\n2. Mejorar la gestión de memoria');
    expect(fact.card).toContain('📌 *Sin proyecto*\n3. Comprar leche');
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
    expect(fact.card).toContain('📁 *Reminder*\n1. Gestionar mejor los proyectos\n2. Mejorar la gestión de memoria');
    expect(fact.card).toContain('📌 *Sin proyecto*\n3. Comprar leche');
    expect(fact.card).not.toContain('[Reminder]');
    expect(fact.card).not.toContain('legacy agenda formatter should not win');
  });

  it('renders task.create from structured data instead of the tool formatter', () => {
    const fact = createExecutionFact({
      toolName: TOOL_NAMES.MANAGE_TASK,
      params: { action: 'create' },
      result: {
        success: true,
        action: 'created_tasks_batch',
        data: [{ id: '1', title: 'Preparar propuesta', entityName: 'Trabajo' }],
        formattedCard: 'legacy create card',
      },
      language: 'es',
    });

    expect(fact.card).toContain('✅ *Tarea creada*');
    expect(fact.card).toContain('📁 *Trabajo*\n• Preparar propuesta');
    expect(fact.card).not.toContain('legacy create card');
  });

  it('renders task.complete from verified task data', () => {
    const fact = createExecutionFact({
      toolName: TOOL_NAMES.MANAGE_TASK,
      params: { action: 'complete' },
      result: {
        success: true,
        action: 'completed_task',
        data: { id: '1', title: 'Enviar factura', entities: { name: 'Trabajo' } },
        formattedCard: 'legacy complete card',
      },
      language: 'es',
    });

    expect(fact.card).toContain('✅ *Tarea completada*');
    expect(fact.card).toContain('📁 *Trabajo*\n• Enviar factura');
    expect(fact.card).not.toContain('legacy complete card');
  });

  it('renders task.update and task.delete through the canonical boundary', () => {
    const updated = createExecutionFact({
      toolName: TOOL_NAMES.MANAGE_TASK,
      params: { action: 'update' },
      result: {
        success: true,
        action: 'updated_task',
        data: { id: '1', title: 'Enviar factura final', entities: { name: 'Trabajo' } },
        formattedCard: 'legacy update card',
      },
      language: 'es',
    });
    const deleted = createExecutionFact({
      toolName: TOOL_NAMES.MANAGE_TASK,
      params: { action: 'delete' },
      result: {
        success: true,
        action: 'deleted_task',
        data: { id: '1', title: 'Enviar factura final' },
        formattedCard: 'legacy delete card',
      },
      language: 'es',
    });

    expect(updated.card).toContain('🔄 *Tarea actualizada*');
    expect(updated.card).toContain('📁 *Trabajo*\n• Enviar factura final');
    expect(updated.card).not.toContain('legacy update card');
    expect(deleted.card).toBe('🗑️ *Tarea eliminada*\n\n• Enviar factura final');
    expect(deleted.card).not.toContain('legacy delete card');
  });
});
