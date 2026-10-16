import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { TurnContext } from '@templelabs/contracts';
import { createEntityTools, ToolRegistry } from '@templelabs/tools';
import { createEntityDomainPort } from '../../../src/adapters/agent-core/entities-domain.js';

const mockEntities = vi.hoisted(() => ({
  getEntitiesByUser: vi.fn(),
  findOrCreateEntityFuzzy: vi.fn(),
  renameEntityCascade: vi.fn(),
  mergeEntities: vi.fn(),
  deleteEntities: vi.fn(),
}));

vi.mock('../../../src/infrastructure/database/entities.js', () => ({
  getEntitiesByUser: mockEntities.getEntitiesByUser,
  findOrCreateEntityFuzzy: mockEntities.findOrCreateEntityFuzzy,
  renameEntityCascade: mockEntities.renameEntityCascade,
  mergeEntities: mockEntities.mergeEntities,
  deleteEntities: mockEntities.deleteEntities,
}));

const user = { id: 'owner-123' };
const context: TurnContext = {
  userId: 'owner-123',
  runId: 'run-1',
  requestId: 'req-1',
  referenceTimeIso: '2026-10-16T12:00:00.000Z',
  timezone: 'America/Bogota',
  language: 'es',
  capabilities: new Set(['entities.read', 'entities.create', 'entities.update', 'entities.delete']),
  signal: new AbortController().signal,
};

describe('Entity domain port and tools', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('reads entities successfully through entity_read tool', async () => {
    mockEntities.getEntitiesByUser.mockResolvedValue([
      { id: 'ent-1', name: 'Dr. Perez', category: 'contact', status: 'active' },
      { id: 'ent-2', name: 'Supermercado', category: 'place', status: 'active' },
    ]);

    const port = createEntityDomainPort(user);
    const tools = createEntityTools(port);
    const registry = new ToolRegistry([...tools]);

    const outcome = await registry.execute('entity_read', { query: 'Perez' }, context, 'op-ent-1');

    expect(outcome).toMatchObject({
      status: 'success',
      data: {
        entities: [
          {
            id: 'ent-1',
            name: 'Dr. Perez',
            category: 'contact',
            status: 'active',
          },
        ],
      },
      receipt: {
        toolName: 'entity_read',
        resourceIds: ['ent-1'],
      },
    });
  });

  it('creates entity successfully through entity_create tool', async () => {
    mockEntities.findOrCreateEntityFuzzy.mockResolvedValue({
      id: 'ent-new',
      name: 'Farmacia',
      category: 'place',
      status: 'active',
    });

    const port = createEntityDomainPort(user);
    const tools = createEntityTools(port);
    const registry = new ToolRegistry([...tools]);

    const outcome = await registry.execute('entity_create', { name: 'Farmacia', category: 'place' }, context, 'op-ent-2');

    expect(outcome).toMatchObject({
      status: 'success',
      data: {
        entities: [
          expect.objectContaining({ name: 'Farmacia', category: 'place' }),
        ],
      },
      receipt: {
        toolName: 'entity_create',
      },
    });
  });

  it('renames entity successfully through entity_update tool', async () => {
    mockEntities.renameEntityCascade.mockResolvedValue({
      success: true,
      id: 'ent-1',
    });

    const port = createEntityDomainPort(user);
    const tools = createEntityTools(port);
    const registry = new ToolRegistry([...tools]);

    const outcome = await registry.execute('entity_update', { oldName: 'Farmacia', newName: 'Farmacia 24H' }, context, 'op-ent-3');

    expect(outcome).toMatchObject({
      status: 'success',
      data: {
        entities: [
          expect.objectContaining({ name: 'Farmacia 24H' }),
        ],
      },
    });
  });

  it('merges entities successfully through entity_merge tool', async () => {
    mockEntities.mergeEntities.mockResolvedValue({
      success: true,
      id: 'ent-target',
      mergedCount: 1,
      tasksMovedCount: 2,
    });

    const port = createEntityDomainPort(user);
    const tools = createEntityTools(port);
    const registry = new ToolRegistry([...tools]);

    const outcome = await registry.execute('entity_merge', { sourceName: 'Farmacia', targetName: 'Farmacia Central' }, context, 'op-ent-4');

    expect(outcome).toMatchObject({
      status: 'success',
      data: {
        mergedCount: 1,
        tasksMovedCount: 2,
      },
    });
  });

  it('requires confirmation on dryRun delete and confirms on confirmed delete', async () => {
    mockEntities.deleteEntities.mockResolvedValue({
      success: true,
      dryRun: true,
      candidates: [{ id: 'ent-1', name: 'Farmacia' }],
      deletedCount: 0,
    });

    const port = createEntityDomainPort(user);
    const tools = createEntityTools(port);
    const registry = new ToolRegistry([...tools]);

    // Unconfirmed -> returns clarification_required
    const dryOutcome = await registry.execute('entity_delete', { name: 'Farmacia', confirmed: false }, context, 'op-ent-5');
    expect(dryOutcome).toMatchObject({
      status: 'clarification_required',
      code: 'CONFIRMATION_REQUIRED',
    });

    // Confirmed -> executes deletion
    mockEntities.deleteEntities.mockResolvedValue({
      success: true,
      dryRun: false,
      entities: [{ id: 'ent-1', name: 'Farmacia' }],
      deletedCount: 1,
    });

    const confirmedOutcome = await registry.execute('entity_delete', { name: 'Farmacia', confirmed: true }, context, 'op-ent-6');
    expect(confirmedOutcome).toMatchObject({
      status: 'success',
      data: {
        deletedCount: 1,
      },
    });
  });

  it('denies execution when user mismatch occurs', async () => {
    const port = createEntityDomainPort({ id: 'other-user' });
    const tools = createEntityTools(port);
    const registry = new ToolRegistry([...tools]);

    const outcome = await registry.execute('entity_read', {}, context, 'op-ent-7');
    expect(outcome.status).toBe('denied');
  });
});
