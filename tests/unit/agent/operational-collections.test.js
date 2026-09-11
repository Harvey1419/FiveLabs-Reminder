import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/infrastructure/database/index.js', () => ({
  createTask: vi.fn(),
  findOrCreateEntityFuzzy: vi.fn(),
  inspectOwnedEntityReferences: vi.fn(),
  saveReminder: vi.fn(),
}));
vi.mock('../../../src/agent/tools/index.js', () => ({
  executeTool: vi.fn(),
}));

import {
  createTask,
  findOrCreateEntityFuzzy,
  inspectOwnedEntityReferences,
} from '../../../src/infrastructure/database/index.js';
import { executeTaskCreate } from '../../../src/agent/tools/task-create.js';
import { executeEntityTool } from '../../../src/agent/tools/entities.js';
import { executeTool } from '../../../src/agent/tools/index.js';
import { executeTurnIntent } from '../../../src/agent/orchestration/intent-executor.js';
import {
  clearWorkingMemory,
  getWorkingMemory,
} from '../../../src/agent/core/working-memory.js';
import { inspectEntityReferenceSnapshot } from '../../../src/infrastructure/database/entities.js';

const user = {
  id: 'owner-1',
  phone_number: '573000000001',
  timezone: 'America/Bogota',
};
const context = {
  user,
  language: 'es',
  timezone: 'America/Bogota',
  referenceTime: new Date('2026-09-11T12:00:00.000Z'),
};

beforeEach(() => {
  vi.clearAllMocks();
  clearWorkingMemory(user);
  inspectOwnedEntityReferences.mockResolvedValue({ success: true, resolutions: [] });
});

describe('operational collection invariants', () => {
  it('detects ambiguous project identity from a tenant-owned preflight snapshot', () => {
    const resolutions = inspectEntityReferenceSnapshot([
      { id: 'p1', name: 'Viaje personal', category: 'project' },
      { id: 'p2', name: 'Viaje laboral', category: 'project' },
    ], [{ name: 'Viaje', category: 'project', threshold: 0.4 }]);

    expect(resolutions).toHaveLength(1);
    expect(resolutions[0].status).toBe('AMBIGUOUS');
    expect(resolutions[0].candidates).toHaveLength(2);
  });

  it('preflights one project and creates every actionable member under the same owned entity', async () => {
    const project = { id: 'project-1', name: 'Cosas para el viaje', category: 'project' };
    findOrCreateEntityFuzzy.mockResolvedValue(project);
    createTask.mockImplementation(async ({ title, entityId, userId }) => ({
      id: `task-${title}`,
      title,
      entity_id: entityId,
      user_id: userId,
    }));

    const result = await executeTaskCreate({
      user,
      params: {
        items: ['Pasaporte', 'Cargador', 'Bloqueador'].map((title) => ({
          title,
          entityName: project.name,
          entityCategory: 'project',
        })),
      },
    });

    expect(result.success).toBe(true);
    expect(result.data).toHaveLength(3);
    expect(inspectOwnedEntityReferences).toHaveBeenCalledWith({
      userId: user.id,
      references: [{ name: project.name, category: 'project' }],
    });
    expect(findOrCreateEntityFuzzy).toHaveBeenCalledTimes(1);
    expect(createTask).toHaveBeenCalledTimes(3);
    for (const [call] of createTask.mock.calls) {
      expect(call).toMatchObject({ userId: user.id, entityId: project.id });
    }
  });

  it('fails closed before any mutation when the structured project reference is ambiguous', async () => {
    inspectOwnedEntityReferences.mockResolvedValue({
      success: true,
      resolutions: [{
        status: 'AMBIGUOUS',
        candidates: [
          { id: 'p1', name: 'Viaje personal', category: 'project' },
          { id: 'p2', name: 'Viaje trabajo', category: 'project' },
        ],
      }],
    });

    const result = await executeTaskCreate({
      user,
      params: { items: [{ title: 'Pasaporte', entityName: 'Viaje', entityCategory: 'project' }] },
    });

    expect(result).toMatchObject({ success: false, errorCode: 'AMBIGUOUS_TARGET', requiresClarification: true });
    expect(findOrCreateEntityFuzzy).not.toHaveBeenCalled();
    expect(createTask).not.toHaveBeenCalled();
  });

  it('never creates ungrouped tasks when the declared project cannot be resolved', async () => {
    findOrCreateEntityFuzzy.mockResolvedValue(null);

    const result = await executeTaskCreate({
      user,
      params: { items: [{ title: 'Revisar cajas', entityName: 'Mudanza', entityCategory: 'project' }] },
    });

    expect(result).toMatchObject({ success: false, errorCode: 'DATABASE_ERROR' });
    expect(createTask).not.toHaveBeenCalled();
  });

  it('does not upsert an ambiguous container before clarification', async () => {
    inspectOwnedEntityReferences.mockResolvedValue({
      success: true,
      resolutions: [{ status: 'AMBIGUOUS', candidates: [{ name: 'Casa norte' }, { name: 'Casa sur' }] }],
    });

    const result = await executeEntityTool({
      action: 'upsert',
      params: { name: 'Casa', category: 'project' },
      user,
    });

    expect(result).toMatchObject({ success: false, errorCode: 'AMBIGUOUS_TARGET', requiresClarification: true });
    expect(findOrCreateEntityFuzzy).not.toHaveBeenCalled();
  });

  it('batches compound task creates without losing items and keeps their project in Working Memory', async () => {
    executeTool.mockResolvedValue({
      success: true,
      complete: true,
      action: 'created_tasks_batch',
      data: ['Pasaporte', 'Cargador', 'Bloqueador'].map((title, index) => ({
        id: `task-${index + 1}`,
        title,
        entityId: 'project-1',
        entityName: 'Cosas para el viaje',
      })),
    });

    const actions = ['Pasaporte', 'Cargador', 'Bloqueador'].map((title) => ({
      domain: 'task',
      action: 'create',
      title,
      entityName: 'Cosas para el viaje',
      category: 'project',
    }));
    const result = await executeTurnIntent({ actions }, context);

    expect(result.records).toHaveLength(1);
    expect(executeTool).toHaveBeenCalledTimes(1);
    expect(executeTool).toHaveBeenCalledWith(expect.objectContaining({
      toolName: 'manage_task',
      params: {
        action: 'create',
        items: actions.map(({ title, entityName }) => ({
          title,
          entityName,
          entityCategory: 'project',
        })),
      },
    }));
    expect(getWorkingMemory(user)).toMatchObject({
      activeEntity: 'Cosas para el viaje',
      activeEntityId: 'project-1',
    });
    expect(getWorkingMemory(user).items.map((item) => item.title)).toEqual(['Pasaporte', 'Cargador', 'Bloqueador']);
  });

  it('keeps item operations in task tools and reserves entity deletion for the explicit container action', async () => {
    executeTool.mockResolvedValue({ success: true, complete: true, action: 'ok', data: null });

    await executeTurnIntent({ actions: [
      { domain: 'task', action: 'list', entityName: 'Pendientes del hogar' },
      { domain: 'task', action: 'complete', target: 'Pintar la puerta', entityName: 'Pendientes del hogar' },
      { domain: 'task', action: 'delete', target: 'Cambiar bombillo', entityName: 'Pendientes del hogar' },
      { domain: 'entity', action: 'delete', target: 'Pendientes del hogar', category: 'project' },
    ] }, context);

    expect(executeTool.mock.calls.map(([call]) => [call.toolName, call.params.action])).toEqual([
      ['manage_task', 'list'],
      ['manage_task', 'complete'],
      ['manage_task', 'delete'],
      ['manage_entity', 'delete'],
    ]);
  });
});
