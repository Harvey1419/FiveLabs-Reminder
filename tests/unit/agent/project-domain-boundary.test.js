import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/agent/tools/index.js', () => ({
  executeTool: vi.fn(),
}));

import { executeTool } from '../../../src/agent/tools/index.js';
import { executeTurnIntent } from '../../../src/agent/orchestration/intent-executor.js';
import { TOOL_NAMES } from '../../../src/agent/contracts/tool-names.js';
import { validateTurnIntent } from '../../../src/agent/contracts/intent-contracts.js';
import { formatCanonicalEntityList, formatCanonicalEntityDelete } from '../../../src/shared/entity-presentation.js';
import { formatCanonicalTaskList } from '../../../src/shared/agenda-presentation.js';
import { selectProjectsForDeletion } from '../../../src/infrastructure/database/projects.js';

describe('Project domain boundary and presentation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('formats project list card with clean header and no category tags', () => {
    const projects = [
      { id: 'p1', name: 'Reforma baño' },
      { id: 'p2', name: 'Lista de compras' },
      { id: 'p3', name: 'reminder' },
    ];

    const card = formatCanonicalEntityList(projects, { category: 'project', language: 'es' });
    expect(card).toContain('📁 *Tus proyectos*');
    expect(card).toContain('• *Reforma baño*');
    expect(card).toContain('• *Lista de compras*');
    expect(card).toContain('• *reminder*');
    expect(card).not.toContain('— proyecto');
    expect(card).not.toContain('Tus entidades registradas');
  });

  it('validates project.list intent and dispatches to manage_project tool', async () => {
    executeTool.mockResolvedValue({
      success: true,
      action: 'listed_projects',
      data: [
        { id: 'p1', name: 'Reforma baño' },
        { id: 'p2', name: 'Yax' },
      ],
    });

    const context = {
      user: { id: 'user-1' },
      language: 'es',
    };

    const intent = {
      actions: [
        { domain: 'project', action: 'list' },
      ],
    };

    const validation = validateTurnIntent(intent);
    expect(validation.valid).toBe(true);

    const result = await executeTurnIntent(validation.intent, context);
    expect(result.facts.length).toBe(1);
    expect(executeTool).toHaveBeenCalledWith(expect.objectContaining({
      toolName: TOOL_NAMES.MANAGE_PROJECT,
      params: { action: 'list' },
    }));

    const fact = result.facts[0];
    expect(fact.card).toContain('📁 *Tus proyectos*');
    expect(fact.card).toContain('• *Reforma baño*');
    expect(fact.card).toContain('• *Yax*');
  });

  it('batches multiple contiguous project.delete actions into a single manage_project call with targetNames', async () => {
    executeTool.mockResolvedValue({
      success: false,
      action: 'project_deletion_confirmation_required',
      errorCode: 'CONFIRMATION_REQUIRED',
      requiresClarification: true,
      error: '¿Quieres que elimine 2 proyectos?\n\n• *BAM*\n• *Chicamocha*',
      rawSummary: '⚠️ *Confirmación necesaria*\n\n¿Quieres que elimine 2 proyectos?\n\n• *BAM*\n• *Chicamocha*',
      formattedCard: '⚠️ *Confirmación necesaria*\n\n¿Quieres que elimine 2 proyectos?\n\n• *BAM*\n• *Chicamocha*',
      data: {
        previewProjects: [
          { id: 'p1', name: 'BAM' },
          { id: 'p2', name: 'Chicamocha' },
        ],
      },
    });

    const context = {
      user: { id: 'user-1' },
      language: 'es',
    };

    const intent = {
      actions: [
        { domain: 'project', action: 'delete', target: 'BAM' },
        { domain: 'project', action: 'delete', target: 'Chicamocha' },
      ],
    };

    const validation = validateTurnIntent(intent);
    expect(validation.valid).toBe(true);

    const result = await executeTurnIntent(validation.intent, context);

    // Exactly 1 tool call with all targetNames
    expect(executeTool).toHaveBeenCalledTimes(1);
    expect(executeTool).toHaveBeenCalledWith(expect.objectContaining({
      toolName: TOOL_NAMES.MANAGE_PROJECT,
      params: {
        action: 'delete',
        targetNames: ['BAM', 'Chicamocha'],
      },
    }));

    // Exactly 1 unified fact produced
    expect(result.facts.length).toBe(1);
    expect(result.facts[0].card).toContain('⚠️ *Confirmación necesaria*');
    expect(result.facts[0].card).toContain('• *BAM*');
    expect(result.facts[0].card).toContain('• *Chicamocha*');
  });

  it('selects multiple projects by targetNames for batch deletion', () => {
    const projects = [
      { id: 'p1', name: 'BAM' },
      { id: 'p2', name: 'Chicamocha' },
      { id: 'p3', name: 'Reforma baño' },
    ];

    const selection = selectProjectsForDeletion(projects, {
      targetNames: ['BAM', 'Chicamocha'],
    });

    expect(selection.status).toBe('RESOLVED');
    expect(selection.projects.map((p) => p.id)).toEqual(['p1', 'p2']);
  });

  it('formats batch project deletion result with unified 4-block card', () => {
    const card = formatCanonicalEntityDelete({
      deletedCount: 2,
      projects: [{ id: 'p1', name: 'BAM' }, { id: 'p2', name: 'Chicamocha' }],
      deletedTaskCount: 3,
      preservedCompletedTaskCount: 5,
    }, { language: 'es' });

    expect(card).toContain('🗑️ *2 proyectos eliminados*');
    expect(card).toContain('• BAM');
    expect(card).toContain('• Chicamocha');
    expect(card).toContain('🗑️ También se eliminaron 3 tareas pendientes asociadas.');
    expect(card).toContain('📚 5 tareas completadas permanecen en el historial.');
  });

  it('formats project list card with dynamic task count badges', () => {
    const projects = [
      { id: 'p1', name: 'Apartamento', taskCount: 0 },
      { id: 'p2', name: 'reminder', taskCount: 2 },
      { id: 'p3', name: 'Reforma baño', taskCount: 1 },
    ];

    const cardEs = formatCanonicalEntityList(projects, { category: 'project', language: 'es' });
    expect(cardEs).toContain('• *Apartamento* (0 tareas)');
    expect(cardEs).toContain('• *reminder* (2 tareas)');
    expect(cardEs).toContain('• *Reforma baño* (1 tarea)');

    const cardEn = formatCanonicalEntityList(projects, { category: 'project', language: 'en' });
    expect(cardEn).toContain('• *Apartamento* (0 tasks)');
    expect(cardEn).toContain('• *reminder* (2 tasks)');
    expect(cardEn).toContain('• *Reforma baño* (1 task)');
  });

  it('formats project-scoped task list card with clean unified header and numbered items', () => {
    const card = formatCanonicalTaskList({
      entityName: 'reminder',
      tasks: [
        { title: 'Revisar interpretación de audios con correcciones' },
        { title: 'enumerar tareas en vez de por lista con punto' },
      ],
    }, { language: 'es' });

    expect(card).toContain('📁 *reminder* · 2 tareas');
    expect(card).toContain('1. Revisar interpretación de audios con correcciones');
    expect(card).toContain('2. enumerar tareas en vez de por lista con punto');
    expect(card).not.toContain('☑️ *Tareas · 2*');
  });
});
