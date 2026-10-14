import type { ExecutionToolCall } from '../../../src/agent/orchestration/turn-intent-executor.js';
import { describe, expect, it, vi } from 'vitest';
import { formatTaskProjectGroups } from '../../../src/shared/task-presentation.js';
import { parseStructuredOrdinal, extractMultipleOrdinals } from '../../../src/agent/core/context-reference.js';
import { executeTurnIntent } from '../../../src/agent/orchestration/intent-executor.js';
import { getWorkingMemory, saveWorkingMemory } from '../../../src/agent/core/working-memory-store.js';

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
    const executedTools: Array<Pick<ExecutionToolCall, 'toolName' | 'params'>> = [];
    const mockExecuteTool = vi.fn(async ({ toolName, params }: ExecutionToolCall) => {
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
    expect(executedTools[0]!.params.target).toBe('1');
    expect(executedTools[1]!.params.target).toBe('3');
    expect(result.records).toHaveLength(2);
  });

  it('keeps task ordinals stable across turns after a sibling task mutation', async () => {
    const user = { id: 'stable-task-reference-user' };
    const taskA = '11111111-1111-4111-8111-111111111111';
    const taskB = '22222222-2222-4222-8222-222222222222';
    saveWorkingMemory(user, {
      source: 'task',
      entityType: 'task',
      items: [
        { id: taskA, title: 'A task', status: 'pending' },
        { id: taskB, title: 'B task', status: 'pending' },
      ],
    });
    const executeTool = vi.fn(async ({ params }: ExecutionToolCall) => ({
      success: true,
      action: 'completed_task',
      data: { id: params.target, title: 'B task', status: 'completed' },
    }));

    await executeTurnIntent({ actions: [{ domain: 'task', action: 'complete', target: '2' }] }, {
      user,
      language: 'en',
      executeTool,
    });

    const memoryAfterComplete = getWorkingMemory(user);
    expect(memoryAfterComplete!.items.map((item) => item.internalId)).toEqual([taskA, taskB]);
    expect(memoryAfterComplete!.items.map((item) => item.position)).toEqual([1, 2]);

    const updateTool = vi.fn(async ({ params }: ExecutionToolCall) => ({
      success: true,
      action: 'updated_task',
      data: { id: params.target, title: (params.updates as { title: string }).title, status: 'pending' },
    }));
    await executeTurnIntent({ actions: [{ domain: 'task', action: 'update', target: '1', title: 'A task changed' }] }, {
      user,
      language: 'en',
      executeTool: updateTool,
    });

    expect(executeTool).toHaveBeenCalledWith(expect.objectContaining({ params: expect.objectContaining({ target: taskB }) }));
    expect(updateTool).toHaveBeenCalledWith(expect.objectContaining({ params: expect.objectContaining({ target: taskA }) }));
    const memoryAfterUpdate = getWorkingMemory(user);
    expect(memoryAfterUpdate!.items.map((item) => item.internalId)).toEqual([taskA, taskB]);
    expect(memoryAfterUpdate!.items[0]).toMatchObject({ title: 'A task changed', summary: 'A task changed', position: 1 });
  });

  it('pins all task mutation ordinals from the pre-mutation list for same-turn sibling actions', async () => {
    const user = { id: 'same-turn-stable-task-reference-user' };
    const taskA = '33333333-3333-4333-8333-333333333333';
    const taskB = '44444444-4444-4444-8444-444444444444';
    saveWorkingMemory(user, {
      source: 'task',
      entityType: 'task',
      items: [
        { id: taskA, title: 'A task', status: 'pending' },
        { id: taskB, title: 'B task', status: 'pending' },
      ],
    });
    const executeTool = vi.fn(async ({ params }: ExecutionToolCall) => ({
      success: true,
      action: params.action === 'complete' ? 'completed_task' : 'updated_task',
      data: { id: params.target, title: (params.updates as { title?: string } | undefined)?.title || params.target, status: params.action === 'complete' ? 'completed' : 'pending' },
    }));

    await executeTurnIntent({ actions: [
      { domain: 'task', action: 'complete', target: '2' },
      { domain: 'task', action: 'update', target: '1', title: 'A task changed' },
    ] }, { user, language: 'en', executeTool });

    expect(executeTool.mock.calls.map(([call]) => call.params.target)).toEqual([taskB, taskA]);
  });

  it('retains a deleted task slot as a stale identity instead of shifting later ordinals', async () => {
    const user = { id: 'deleted-task-reference-user' };
    const taskA = '55555555-5555-4555-8555-555555555555';
    const taskB = '66666666-6666-4666-8666-666666666666';
    saveWorkingMemory(user, {
      source: 'task',
      entityType: 'task',
      items: [
        { id: taskA, title: 'Deleted task', status: 'pending' },
        { id: taskB, title: 'Still pending', status: 'pending' },
      ],
    });

    await executeTurnIntent({ actions: [{ domain: 'task', action: 'delete', target: '1' }] }, {
      user,
      language: 'en',
      executeTool: vi.fn(async ({ params }: ExecutionToolCall) => ({ success: true, action: 'deleted_task', data: { id: params.target } })),
    });

    expect(getWorkingMemory(user)!.items.map((item) => item.internalId)).toEqual([taskA, taskB]);
    expect(getWorkingMemory(user)!.items[0]!.raw.status).toBe('deleted');
  });

  it('rejects an out-of-range numeric ordinal instead of fuzzy-matching a numeric task title', async () => {
    const user = { id: 'out-of-range-task-ordinal-user' };
    saveWorkingMemory(user, {
      source: 'task',
      entityType: 'task',
      items: [
        { id: '77777777-7777-4777-8777-777777777777', title: 'A task', status: 'pending' },
        { id: '88888888-8888-4888-8888-888888888888', title: '3', status: 'pending' },
      ],
    });
    const executeTool = vi.fn(async ({ params }: ExecutionToolCall) => ({ success: true, action: 'deleted_task', data: { id: params.target } }));

    const result = await executeTurnIntent({ actions: [{ domain: 'task', action: 'delete', target: '3' }] }, {
      user,
      language: 'en',
      executeTool,
    });

    expect(executeTool).not.toHaveBeenCalled();
    expect(result.records[0]!.result).toMatchObject({ success: false, requiresClarification: true });
  });
});
