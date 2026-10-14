import { untrustedResultMock, expectValid } from '../../support/unit/contract-boundary.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/infrastructure/database/index.js', () => ({
  createTasksBatch: vi.fn(),
  findOrCreateEntityFuzzy: vi.fn(),
  inspectOwnedEntityReferences: vi.fn(),
  saveReminder: vi.fn(),
}));
vi.mock('../../../src/agent/tools/index.js', () => ({
  executeTool: vi.fn(),
}));

import {
  createTasksBatch,
  findOrCreateEntityFuzzy,
  inspectOwnedEntityReferences,
} from '../../../src/infrastructure/database/index.js';
import { executeTaskCreate } from '../../../src/agent/tools/task-create.js';
import { executeEntityTool } from '../../../src/agent/tools/entities.js';
import { executeTool } from '../../../src/agent/tools/index.js';
import { executeTurnIntent } from '../../../src/agent/orchestration/intent-executor.js';
import { validateTurnIntent } from '../../../src/agent/contracts/intent-contracts.js';
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
  untrustedResultMock(executeTool).mockReset();
  clearWorkingMemory(user);
  untrustedResultMock(inspectOwnedEntityReferences).mockResolvedValue({ success: true, resolutions: [] });
});

describe('operational collection invariants', () => {
  it('detects ambiguous project identity from a tenant-owned preflight snapshot', () => {
    const resolutions = inspectEntityReferenceSnapshot([
      { id: 'p1', name: 'Viaje personal', category: 'project' },
      { id: 'p2', name: 'Viaje laboral', category: 'project' },
    ], [{ name: 'Viaje', category: 'project', threshold: 0.4 }]);

    expect(resolutions).toHaveLength(1);
    expect(resolutions[0]!.status).toBe('AMBIGUOUS');
    expect((resolutions[0]! as Extract<typeof resolutions[number], { status: 'AMBIGUOUS' | 'NOT_FOUND' }>).candidates).toHaveLength(2);
  });

  it('preflights one project and creates every actionable member under the same owned entity', async () => {
    const project = { id: 'project-1', name: 'Cosas para el viaje', category: 'project' };
    untrustedResultMock(findOrCreateEntityFuzzy).mockResolvedValue(project);
    untrustedResultMock(createTasksBatch).mockImplementation(async ({ items }) => ({
      data: items!.map(({ title, entityId }) => ({
        id: `task-${title}`,
        title,
        entity_id: entityId,
        user_id: user.id,
      })),
      error: null,
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
    expect(createTasksBatch).toHaveBeenCalledTimes(1);
    expect(createTasksBatch).toHaveBeenCalledWith({
      userId: user.id,
      items: expect.arrayContaining([
        expect.objectContaining({ title: 'Pasaporte', entityId: project.id }),
        expect.objectContaining({ title: 'Cargador', entityId: project.id }),
        expect.objectContaining({ title: 'Bloqueador', entityId: project.id }),
      ]),
    });
  });

  it('fails closed before any mutation when the structured project reference is ambiguous', async () => {
    untrustedResultMock(inspectOwnedEntityReferences).mockResolvedValue({
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
    expect(createTasksBatch).not.toHaveBeenCalled();
  });

  it('never creates ungrouped tasks when the declared project cannot be resolved', async () => {
    untrustedResultMock(findOrCreateEntityFuzzy).mockResolvedValue(null);

    const result = await executeTaskCreate({
      user,
      params: { items: [{ title: 'Revisar cajas', entityName: 'Mudanza', entityCategory: 'project' }] },
    });

    expect(result).toMatchObject({ success: false, errorCode: 'DATABASE_ERROR' });
    expect(createTasksBatch).not.toHaveBeenCalled();
  });

  it('fails the coherent task batch without reporting a persisted subset', async () => {
    const project = { id: 'project-1', name: 'Preparativos', category: 'project' };
    untrustedResultMock(findOrCreateEntityFuzzy).mockResolvedValue(project);
    untrustedResultMock(createTasksBatch).mockResolvedValue({
      data: null,
      error: { code: 'DATABASE_ERROR', message: 'atomic batch insert failed', source: 'database' },
    });

    const result = await executeTaskCreate({
      user,
      params: {
        items: ['A', 'B', 'C'].map((title) => ({
          title,
          entityName: project.name,
          entityCategory: 'project',
        })),
      },
    });

    expect(result).toMatchObject({ success: false, errorCode: 'DATABASE_ERROR' });
    expect(result.action).not.toBe('created_tasks_batch');
    expect(createTasksBatch).toHaveBeenCalledTimes(1);
  });

  it('does not upsert an ambiguous container before clarification', async () => {
    untrustedResultMock(inspectOwnedEntityReferences).mockResolvedValue({
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
    untrustedResultMock(executeTool).mockResolvedValue({
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
    expect(getWorkingMemory(user)!.items.map((item) => item.title)).toEqual(['Pasaporte', 'Cargador', 'Bloqueador']);
  });

  it('uses the unique structured task container to complete its project upsert without fabricating pending state', async () => {
    untrustedResultMock(executeTool)
      .mockResolvedValueOnce({
        success: true, complete: true, action: 'upserted_entity',
        data: { id: 'project-1', name: 'Viaje', category: 'project' },
      })
      .mockResolvedValueOnce({
        success: true, complete: true, action: 'created_tasks_batch',
        data: ['Sacar el pasaporte', 'Comprar bloqueador', 'Cargar la batería externa'].map((title, index) => ({
          id: `task-${index + 1}`, title, entityId: 'project-1', entityName: 'Viaje',
        })),
      });
    const intent = {
      actions: [
        { domain: 'entity', action: 'upsert', category: 'project' },
        ...['Sacar el pasaporte', 'Comprar bloqueador', 'Cargar la batería externa'].map((title) => ({
          domain: 'task', action: 'create', title, entityName: 'Viaje', category: 'project',
        })),
      ],
    };

    const validation = validateTurnIntent(intent);
    expectValid(validation);
    expect(validation.intent.actions[0]).toMatchObject({
      domain: 'entity', action: 'upsert', category: 'project', entityName: 'Viaje',
    });

    const result = await executeTurnIntent(validation.intent, context);

    expect(result.facts.every((fact) => fact.success)).toBe(true);
    expect(executeTool).toHaveBeenCalledTimes(2);
    expect(untrustedResultMock(executeTool).mock.calls[0]![0]).toMatchObject({
      toolName: 'manage_entity', params: { action: 'upsert', name: 'Viaje', category: 'project' },
    });
    expect(getWorkingMemory(user)).toMatchObject({
      activeEntity: 'Viaje',
    });
    expect(getWorkingMemory(user)?.pendingIntent).toBeUndefined();
  });

  it('never turns an undeclared invalid action into a typed Pending Intent', async () => {
    untrustedResultMock(executeTool).mockResolvedValue({
      success: true, complete: true, action: 'created_task',
      data: [{ id: 'task-1', title: 'Comprar bloqueador', entityId: 'project-1', entityName: 'Viaje' }],
    });

    const result = await executeTurnIntent({ actions: [
      { domain: 'entity', action: 'upsert', category: 'project' },
      { domain: 'task', action: 'create', title: 'Comprar bloqueador', entityName: 'Viaje', category: 'project' },
    ] }, context);

    expect(result.facts.some((fact) => fact.requiresClarification)).toBe(false);
    expect(getWorkingMemory(user)?.pendingIntent || null).toBeNull();
  });

  it('requires every executable task.create to declare project scope or explicit projectless scope', () => {
    expect(validateTurnIntent({ actions: [
      { domain: 'task', action: 'create', title: 'Revisar seguro' },
    ] })).toMatchObject({ valid: false, errorCode: 'MISSING_TARGET' });
    expect(validateTurnIntent({ actions: [
      { domain: 'task', action: 'create', title: 'Revisar seguro', projectless: true },
    ] })).toMatchObject({ valid: true });
    expect(validateTurnIntent({ actions: [
      { domain: 'task', action: 'create', title: 'Revisar seguro', entityName: 'Viaje' },
    ] })).toMatchObject({ valid: true });
  });

  it('keeps task due dates optional but rejects a present incomplete schedule before execution', () => {
    expect(validateTurnIntent({ actions: [
      { domain: 'task', action: 'create', title: 'Revisar seguro', entityName: 'Viaje' },
    ] })).toMatchObject({ valid: true });
    expect(validateTurnIntent({ actions: [
      {
        domain: 'task', action: 'create', title: 'Revisar seguro', entityName: 'Viaje',
        schedule: { kind: 'relative_day_time' },
      },
    ] })).toMatchObject({ valid: false, errorCode: 'MISSING_SCHEDULE' });
  });

  it('applies the same schedule boundary to schedule-bearing updates', () => {
    const incomplete = { kind: 'relative_day_time', dayOffset: 2 };
    expect(validateTurnIntent({ actions: [
      { domain: 'reminder', action: 'update', target: 'Llamar', schedule: incomplete },
    ] })).toMatchObject({ valid: false, errorCode: 'MISSING_SCHEDULE' });
    expect(validateTurnIntent({ actions: [
      { domain: 'task', action: 'update', target: 'Revisar', schedule: incomplete },
    ] })).toMatchObject({ valid: false, errorCode: 'MISSING_SCHEDULE' });
    expect(validateTurnIntent({ actions: [
      { domain: 'calendar', action: 'update', target: 'Reunión', schedule: incomplete },
    ] })).toMatchObject({ valid: false, errorCode: 'MISSING_SCHEDULE' });
  });

  it('does not write a failed task batch into Working Memory', async () => {
    untrustedResultMock(executeTool).mockResolvedValue({
      success: false,
      complete: false,
      action: 'database_error',
      errorCode: 'DATABASE_ERROR',
      error: 'atomic batch insert failed',
    });

    await executeTurnIntent({ actions: [
      { domain: 'task', action: 'create', title: 'A', entityName: 'Preparativos', category: 'project' },
      { domain: 'task', action: 'create', title: 'B', entityName: 'Preparativos', category: 'project' },
      { domain: 'task', action: 'create', title: 'C', entityName: 'Preparativos', category: 'project' },
    ] }, context);

    expect(executeTool).toHaveBeenCalledTimes(1);
    expect(getWorkingMemory(user)).toBeNull();
  });

  it('keeps item operations in task tools and reserves entity deletion for the explicit container action', async () => {
    untrustedResultMock(executeTool).mockResolvedValue({ success: true, complete: true, action: 'ok', data: null });

    await executeTurnIntent({ actions: [
      { domain: 'task', action: 'list', entityName: 'Pendientes del hogar' },
      { domain: 'task', action: 'complete', target: 'Pintar la puerta', entityName: 'Pendientes del hogar' },
      { domain: 'task', action: 'delete', target: 'Cambiar bombillo', entityName: 'Pendientes del hogar' },
      { domain: 'entity', action: 'delete', target: 'Pendientes del hogar', category: 'project' },
    ] }, context);

    expect(untrustedResultMock(executeTool).mock.calls.map(([call]) => [(call as { toolName: string }).toolName, (call as { params: { action: string } }).params.action])).toEqual([
      ['manage_task', 'list'],
      ['manage_task', 'complete'],
      ['manage_task', 'delete'],
      ['manage_entity', 'delete'],
    ]);
  });
});
