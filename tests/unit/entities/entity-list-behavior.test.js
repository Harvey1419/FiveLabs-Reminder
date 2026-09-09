import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/infrastructure/database/index.js', () => ({
  findOrCreateEntityFuzzy: vi.fn(),
  renameEntityCascade: vi.fn(),
  mergeEntities: vi.fn(),
  deduplicateEntities: vi.fn(),
  getEntitiesByUser: vi.fn(),
  deleteEntities: vi.fn(),
}));

const { getEntitiesByUser, deleteEntities } = await import('../../../src/infrastructure/database/index.js');
const { executeEntityTool } = await import('../../../src/agent/tools/entities.js');
const { createExecutionFact } = await import('../../../src/agent/core/execution-facts.js');
const { TOOL_NAMES } = await import('../../../src/agent/contracts/tool-names.js');

describe('entity list behavior', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns project names as structured truth and presents them canonically', async () => {
    getEntitiesByUser.mockResolvedValue([
      { id: 'one', name: 'Reminder Pro', category: 'project' },
      { id: 'two', name: 'trabajo', category: 'project' },
    ]);

    const result = await executeEntityTool({
      action: 'list',
      params: { category: 'project' },
      user: { id: 'user-1' },
      language: 'es',
    });

    expect(result).toMatchObject({ success: true, action: 'listed_entities' });
    expect(result.data).toHaveLength(2);
    expect(result.formattedCard).toBeUndefined();

    const fact = createExecutionFact({
      toolName: TOOL_NAMES.MANAGE_ENTITY,
      params: { action: 'list', category: 'project' },
      result,
      language: 'es',
    });
    expect(fact.card).toContain('Tus proyectos');
    expect(fact.card).not.toContain('(2)');
    expect(fact.card).toContain('*Reminder Pro*');
    expect(fact.card).toContain('*trabajo*');
  });

  it('labels categories through the canonical entity presenter', async () => {
    getEntitiesByUser.mockResolvedValue([
      { id: 'one', name: 'Toriú', category: 'company' },
      { id: 'two', name: 'trabajo', category: 'project' },
    ]);

    const result = await executeEntityTool({
      action: 'list',
      params: {},
      user: { id: 'user-1' },
      language: 'es',
    });

    expect(result.data).toHaveLength(2);
    expect(result.formattedCard).toBeUndefined();
    const fact = createExecutionFact({
      toolName: TOOL_NAMES.MANAGE_ENTITY,
      params: { action: 'list' },
      result,
      language: 'es',
    });
    expect(fact.card).toContain('Tus entidades registradas');
    expect(fact.card).not.toContain('(2)');
    expect(fact.card).toContain('*Toriú* — empresa');
    expect(fact.card).toContain('*trabajo* — proyecto');
  });

  it('stages destructive project deletion and preserves explicit exceptions', async () => {
    deleteEntities.mockResolvedValue({
      success: true,
      dryRun: true,
      entities: [
        { id: 'one', name: 'Trabajo', category: 'project' },
        { id: 'two', name: 'Casa', category: 'project' },
      ],
      pendingTaskCount: 1,
      activeReminderCount: 1,
      preservedCompletedTaskCount: 1,
      deletedCount: 0,
    });

    const result = await executeEntityTool({
      action: 'delete',
      params: { category: 'project', scope: 'all', preserveNames: ['Reminder Pro'] },
      user: { id: 'user-1' },
      language: 'es',
    });

    expect(result).toMatchObject({
      success: false,
      action: 'entity_deletion_confirmation_required',
      requiresClarification: true,
      pendingClarifications: [{
        proposedOperation: {
          kind: 'entity_delete',
          category: 'project',
          scope: 'all',
          preserveNames: ['Reminder Pro'],
        },
      }],
    });
    expect(result.formattedCard).toContain('Confirmación necesaria');
    expect(result.formattedCard).toContain('Trabajo, Casa');
    expect(result.formattedCard).toContain('Reminder Pro');
    expect(result.formattedCard).toContain('tarea pendiente asociada');
    expect(result.formattedCard).toContain('recordatorio activo relacionado');
    expect(result.formattedCard).toContain('tarea completada permanecerá');
  });

  it('executes a confirmed deletion as structured truth and presents cleanup canonically', async () => {
    deleteEntities.mockResolvedValue({
      success: true,
      entities: [{ id: 'one', name: 'Trabajo', category: 'project' }],
      deletedCount: 1,
      deletedTaskCount: 1,
      cancelledReminderCount: 1,
      preservedCompletedTaskCount: 1,
    });

    const result = await executeEntityTool({
      action: 'delete',
      params: { targetName: 'Trabajo', category: 'project', scope: 'single' },
      user: { id: 'user-1' },
      language: 'es',
      clarificationResolution: true,
    });

    expect(result).toMatchObject({ success: true, action: 'deleted_entities' });
    expect(result.formattedCard).toBeUndefined();

    const fact = createExecutionFact({
      toolName: TOOL_NAMES.MANAGE_ENTITY,
      params: { action: 'delete', targetName: 'Trabajo', category: 'project', scope: 'single' },
      result,
      language: 'es',
    });
    expect(fact.card).toContain('Proyecto eliminado');
    expect(fact.card).toContain('Trabajo');
    expect(fact.card).toContain('tarea pendiente asociada');
    expect(fact.card).toContain('recordatorio relacionado');
    expect(fact.card).toContain('tarea completada permanece');
  });
});
