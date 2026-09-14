import { describe, expect, it, vi } from 'vitest';
import { formatTaskProjectGroups } from '../../../src/shared/task-presentation.js';
import { parseStructuredOrdinal, extractMultipleOrdinals } from '../../../src/agent/core/context-reference.js';
import { executeTurnIntent } from '../../../src/agent/orchestration/intent-executor.js';

describe('task numbered lists and ordinal resolution', () => {
  it('numbers tasks continuously across multiple project containers', () => {
    const tasks = [
      { id: 't1', title: 'Primera tarea', entityName: 'Proyecto Alfa' },
      { id: 't2', title: 'Segunda tarea', entityName: 'Proyecto Alfa' },
      { id: 't3', title: 'Tercera tarea', entityName: 'Proyecto Beta' },
      { id: 't4', title: 'Cuarta tarea', entityName: null },
    ];

    const result = formatTaskProjectGroups(tasks, {
      language: 'es',
      timezone: 'America/Bogota',
      numbered: true,
    });

    expect(result).toContain('📁 *Proyecto Alfa*\n1. Primera tarea\n2. Segunda tarea');
    expect(result).toContain('📁 *Proyecto Beta*\n3. Tercera tarea');
    expect(result).toContain('📌 *Sin proyecto*\n4. Cuarta tarea');
  });

  it('parses natural ordinal variants including contractions and prefixes', () => {
    expect(parseStructuredOrdinal('1')).toBe(1);
    expect(parseStructuredOrdinal('al 1')).toBe(1);
    expect(parseStructuredOrdinal('a la 1')).toBe(1);
    expect(parseStructuredOrdinal('tarea 1')).toBe(1);
    expect(parseStructuredOrdinal('item 2')).toBe(2);
    expect(parseStructuredOrdinal('la 3')).toBe(3);
    expect(parseStructuredOrdinal('opcion 4')).toBe(4);
    expect(parseStructuredOrdinal('#5')).toBe(5);
    expect(parseStructuredOrdinal('12')).toBe(12);
    expect(parseStructuredOrdinal('ultimo')).toBe(-1);
    expect(parseStructuredOrdinal('comprar leche')).toBeNull();
  });

  it('extracts multiple ordinals from compound user statements', () => {
    expect(extractMultipleOrdinals('1 y 3')).toEqual(['1', '3']);
    expect(extractMultipleOrdinals('la 1 y la 3')).toEqual(['1', '3']);
    expect(extractMultipleOrdinals('1, 2 y 4')).toEqual(['1', '2', '4']);
    expect(extractMultipleOrdinals('tarea 1 y tarea 2')).toEqual(['1', '2']);
    expect(extractMultipleOrdinals('al 1 y al 3')).toEqual(['1', '3']);

    // Non-ordinals must NOT be split
    expect(extractMultipleOrdinals('Comprar pan y leche')).toEqual([]);
    expect(extractMultipleOrdinals('Revisar token de Meta y Google')).toEqual([]);
  });

  it('expands compound task delete intent into individual atomic tool executions', async () => {
    const executedTools = [];
    const mockExecuteTool = vi.fn(async ({ toolName, params }) => {
      executedTools.push({ toolName, params });
      return { success: true, action: 'deleted_task', data: { id: params.target } };
    });

    const intent = {
      actions: [
        { domain: 'task', action: 'delete', target: '1 y 3' },
      ],
    };

    const context = {
      language: 'es',
      user: { id: 'user-1' },
      executeTool: mockExecuteTool,
    };

    const result = await executeTurnIntent(intent, context);
    expect(executedTools).toHaveLength(2);
    expect(executedTools[0].params.target).toBe('1');
    expect(executedTools[1].params.target).toBe('3');
    expect(result.records).toHaveLength(2);
  });
});
