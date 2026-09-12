import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/agent/tools/index.js', () => ({
  executeTool: vi.fn(),
}));

import { executeTool } from '../../../src/agent/tools/index.js';
import { executeTurnIntent } from '../../../src/agent/orchestration/intent-executor.js';
import { TOOL_NAMES } from '../../../src/agent/contracts/tool-names.js';
import { validateTurnIntent } from '../../../src/agent/contracts/intent-contracts.js';
import { formatCanonicalEntityList } from '../../../src/shared/entity-presentation.js';

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
});
