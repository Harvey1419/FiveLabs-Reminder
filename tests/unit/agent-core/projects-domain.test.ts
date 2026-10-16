import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { TurnContext } from '@templelabs/contracts';
import { createProjectTools, ToolRegistry } from '@templelabs/tools';
import { createProjectDomainPort } from '../../../src/adapters/agent-core/projects-domain.js';

const mockProjects = vi.hoisted(() => ({
  findProjects: vi.fn(),
  findOrCreateProjectFuzzy: vi.fn(),
  renameProject: vi.fn(),
  deleteProjects: vi.fn(),
}));

vi.mock('../../../src/infrastructure/database/projects.js', () => ({
  findProjects: mockProjects.findProjects,
  findOrCreateProjectFuzzy: mockProjects.findOrCreateProjectFuzzy,
  renameProject: mockProjects.renameProject,
  deleteProjects: mockProjects.deleteProjects,
}));

const user = { id: 'owner-123' };
const context: TurnContext = {
  userId: 'owner-123',
  runId: 'run-1',
  requestId: 'req-1',
  threadId: 'thread-1',
  referenceTimeIso: '2026-10-16T12:00:00.000Z',
  timezone: 'America/Bogota',
  language: 'es',
  capabilities: new Set(['projects.read', 'projects.create', 'projects.update', 'projects.delete']),
  signal: new AbortController().signal,
};

describe('Project domain port and tools', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('reads projects successfully through project_read tool', async () => {
    mockProjects.findProjects.mockResolvedValue([
      { id: 'proj-1', name: 'Apartamento', description: 'Remodelación', status: 'active' },
      { id: 'proj-2', name: 'Oficina', description: null, status: 'active' },
    ]);

    const port = createProjectDomainPort(user);
    const tools = createProjectTools(port);
    const registry = new ToolRegistry([...tools]);

    const outcome = await registry.execute('project_read', { query: 'Apar' }, context, 'op-1');

    expect(outcome.status).toBe('success');
    if (outcome.status === 'success') {
      expect(outcome.data.projects).toHaveLength(2);
      expect(outcome.data.projects[0]).toEqual({
        id: 'proj-1',
        name: 'Apartamento',
        description: 'Remodelación',
        status: 'active',
      });
      expect(outcome.receipt.toolName).toBe('project_read');
      expect(outcome.receipt.resourceIds).toEqual(['proj-1', 'proj-2']);
    }
  });

  it('creates project successfully through project_create tool', async () => {
    mockProjects.findOrCreateProjectFuzzy.mockResolvedValue({
      id: 'proj-new',
      name: 'Nuevo Proyecto',
      description: 'Detalle',
      status: 'active',
    });

    const port = createProjectDomainPort(user);
    const tools = createProjectTools(port);
    const registry = new ToolRegistry([...tools]);

    const outcome = await registry.execute('project_create', { name: 'Nuevo Proyecto', description: 'Detalle' }, context, 'op-2');

    expect(outcome.status).toBe('success');
    if (outcome.status === 'success') {
      expect(outcome.data.projects).toHaveLength(1);
      expect(outcome.data.projects[0]?.name).toBe('Nuevo Proyecto');
      expect(outcome.receipt.toolName).toBe('project_create');
    }
  });

  it('renames project successfully through project_rename tool', async () => {
    mockProjects.renameProject.mockResolvedValue({
      success: true,
      project: { id: 'proj-1', name: 'Apartamento Niza', description: null, status: 'active' },
    });

    const port = createProjectDomainPort(user);
    const tools = createProjectTools(port);
    const registry = new ToolRegistry([...tools]);

    const outcome = await registry.execute('project_rename', { oldName: 'Apartamento', newName: 'Apartamento Niza' }, context, 'op-3');

    expect(outcome.status).toBe('success');
    if (outcome.status === 'success') {
      expect(outcome.data.projects[0]?.name).toBe('Apartamento Niza');
    }
  });

  it('requires confirmation on dryRun delete and confirms on confirmed delete', async () => {
    mockProjects.deleteProjects.mockResolvedValue({
      success: true,
      projects: [{ id: 'proj-1', name: 'Apartamento' }],
      pendingTaskCount: 3,
      activeReminderCount: 1,
    });

    const port = createProjectDomainPort(user);
    const tools = createProjectTools(port);
    const registry = new ToolRegistry([...tools]);

    // Unconfirmed -> returns clarification_required
    const dryOutcome = await registry.execute('project_delete', { name: 'Apartamento', confirmed: false }, context, 'op-4');
    expect(dryOutcome.status).toBe('clarification_required');
    expect(dryOutcome.code).toBe('CONFIRMATION_REQUIRED');

    // Confirmed -> executes deletion
    mockProjects.deleteProjects.mockResolvedValue({
      success: true,
      deletedCount: 1,
      deletedTaskCount: 3,
      cancelledReminderCount: 1,
      projects: [{ id: 'proj-1', name: 'Apartamento' }],
    });

    const confirmedOutcome = await registry.execute('project_delete', { name: 'Apartamento', confirmed: true }, context, 'op-5');
    expect(confirmedOutcome.status).toBe('success');
    if (confirmedOutcome.status === 'success') {
      expect(confirmedOutcome.data.deletedCount).toBe(1);
      expect(confirmedOutcome.data.deletedTaskCount).toBe(3);
    }
  });

  it('denies execution when user mismatch occurs', async () => {
    const port = createProjectDomainPort({ id: 'other-user' });
    const tools = createProjectTools(port);
    const registry = new ToolRegistry([...tools]);

    const outcome = await registry.execute('project_read', {}, context, 'op-6');
    expect(outcome.status).toBe('denied');
  });
});
