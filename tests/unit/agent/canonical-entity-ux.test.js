import { describe, expect, it } from 'vitest';
import { createExecutionFact } from '../../../src/agent/core/execution-facts.js';
import { TOOL_NAMES } from '../../../src/agent/contracts/tool-names.js';

describe('canonical entity UX', () => {
  it('renders entity.list from structured data instead of tool cards', () => {
    const fact = createExecutionFact({
      toolName: TOOL_NAMES.MANAGE_ENTITY,
      params: { action: 'list', category: 'project' },
      result: {
        success: true,
        action: 'listed_entities',
        data: [
          { id: '1', name: 'Reminder', category: 'project' },
          { id: '2', name: 'Trabajo', category: 'project' },
        ],
        formattedCard: 'legacy list card',
      },
      language: 'es',
    });

    expect(fact.card).toContain('📁 *Tus proyectos*');
    expect(fact.card).toContain('• *Reminder*');
    expect(fact.card).toContain('• *Trabajo*');
    expect(fact.card).not.toContain('legacy list card');
  });

  it('renders create and rename from verified facts', () => {
    const created = createExecutionFact({
      toolName: TOOL_NAMES.MANAGE_ENTITY,
      params: { action: 'create' },
      result: {
        success: true,
        action: 'created_entity',
        data: { id: '1', name: 'Casa', category: 'project' },
        formattedCard: 'legacy create card',
      },
      language: 'es',
    });
    const renamed = createExecutionFact({
      toolName: TOOL_NAMES.MANAGE_ENTITY,
      params: { action: 'rename', oldName: 'Casa', newName: 'Hogar' },
      result: {
        success: true,
        action: 'renamed_entity',
        data: { success: true },
        formattedCard: 'legacy rename card',
      },
      language: 'es',
    });

    expect(created.card).toContain('📁 *Proyecto / entidad registrada*');
    expect(created.card).toContain('*Casa* — proyecto');
    expect(created.card).not.toContain('legacy create card');
    expect(renamed.card).toContain('✏️ *Proyecto renombrado*');
    expect(renamed.card).toContain('Casa → Hogar');
    expect(renamed.card).not.toContain('legacy rename card');
  });

  it('renders confirmed project deletion from structured cleanup facts', () => {
    const fact = createExecutionFact({
      toolName: TOOL_NAMES.MANAGE_ENTITY,
      params: { action: 'delete' },
      result: {
        success: true,
        action: 'deleted_entities',
        data: {
          entities: [{ id: '1', name: 'Trabajo', category: 'project' }],
          deletedCount: 1,
          deletedTaskCount: 1,
          cancelledReminderCount: 1,
          preservedCompletedTaskCount: 1,
        },
        formattedCard: 'legacy delete card',
      },
      language: 'es',
    });

    expect(fact.card).toContain('🗑️ *Proyecto eliminado*');
    expect(fact.card).toContain('• Trabajo');
    expect(fact.card).toContain('tarea pendiente asociada');
    expect(fact.card).toContain('recordatorio relacionado');
    expect(fact.card).toContain('tarea completada permanece');
    expect(fact.card).not.toContain('legacy delete card');
  });
});
