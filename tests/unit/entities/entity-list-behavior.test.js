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

describe('entity list behavior', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns project names instead of only a count', async () => {
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

    expect(result.success).toBe(true);
    expect(result.formattedCard).toContain('Tus proyectos');
    expect(result.formattedCard).not.toContain('(2)');
    expect(result.formattedCard).toContain('*Reminder Pro*');
    expect(result.formattedCard).toContain('*trabajo*');
  });

  it('labels categories when listing all entities', async () => {
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

    expect(result.formattedCard).toContain('Tus entidades registradas');
    expect(result.formattedCard).not.toContain('(2)');
    expect(result.formattedCard).toContain('*Toriú* — empresa');
    expect(result.formattedCard).toContain('*trabajo* — proyecto');
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

  it('executes a previously confirmed project deletion', async () => {
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
    expect(result.formattedCard).toContain('Proyecto eliminado');
    expect(result.formattedCard).toContain('Trabajo');
    expect(result.formattedCard).toContain('tarea pendiente asociada');
    expect(result.formattedCard).toContain('recordatorio relacionado');
    expect(result.formattedCard).toContain('tarea completada permanece');
  });
});
