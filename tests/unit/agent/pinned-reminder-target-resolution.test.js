import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/agent/tools/index.js', () => ({
  executeTool: vi.fn(),
}));

import { executeTool } from '../../../src/agent/tools/index.js';
import { executeTurnIntent } from '../../../src/agent/orchestration/intent-executor.js';
import { clearWorkingMemory, saveWorkingMemory } from '../../../src/agent/core/working-memory.js';
import { TOOL_NAMES } from '../../../src/agent/contracts/tool-names.js';

const user = {
  id: 'user-pinned-resolution',
  phone_number: '573046154163',
  timezone: 'America/Bogota',
  locale: 'es-CO',
  display_name: 'Juan',
};

const context = {
  user,
  isPro: true,
  language: 'es',
  timezone: 'America/Bogota',
  correlationId: 'test-pinned-resolution',
  referenceTime: '2026-09-12T10:00:00.000Z',
};

beforeEach(() => {
  vi.clearAllMocks();
  clearWorkingMemory(user);
});

describe('pinned reminder target resolution in executeTurnIntent', () => {
  it('pre-binds target and reminderId using Map lookup before executeTool for reminder updates', async () => {
    saveWorkingMemory(user, {
      items: [
        {
          position: 1,
          type: 'reminder',
          internalId: '11111111-1111-4111-8111-111111111111',
          summary: 'Llamar al banco',
        },
      ],
    });

    executeTool.mockResolvedValue({
      success: true,
      action: 'reminder_updated',
      data: { id: '11111111-1111-4111-8111-111111111111', content: 'Llamar al banco' },
    });

    const intent = {
      actions: [
        {
          domain: 'reminder',
          action: 'update',
          target: '1',
          schedule: { kind: 'relative_day_time', dayOffset: 2, hour: 10, minute: 0 },
        },
      ],
    };

    const execution = await executeTurnIntent(intent, context);

    expect(executeTool).toHaveBeenCalledTimes(1);
    expect(executeTool).toHaveBeenCalledWith(
      expect.objectContaining({
        toolName: TOOL_NAMES.MANAGE_REMINDER,
        params: expect.objectContaining({
          action: 'update',
          target: '11111111-1111-4111-8111-111111111111',
          reminderId: '11111111-1111-4111-8111-111111111111',
        }),
      }),
    );

    expect(execution.records[0].params).toMatchObject({
      target: '11111111-1111-4111-8111-111111111111',
      reminderId: '11111111-1111-4111-8111-111111111111',
    });
    expect(execution.records[0].result.success).toBe(true);
  });

  it('does not throw pinnedReminderTargets.find is not a function when working memory is empty and tool returns AMBIGUOUS_TARGET', async () => {
    // Exact production scenario reported by user: working-memory empty, human target "llamar al banco", ambiguous in DB
    executeTool.mockResolvedValue({
      success: false,
      action: 'ambiguous_target',
      errorCode: 'AMBIGUOUS_TARGET',
      error: 'Hay varios recordatorios que coinciden. Dime cuál quieres actualizar.',
      requiresClarification: true,
    });

    const intent = {
      actions: [
        {
          domain: 'reminder',
          action: 'update',
          target: 'llamar al banco',
          schedule: { kind: 'relative_day_time', dayOffset: 2, hour: 10, minute: 0 },
        },
      ],
    };

    const execution = await executeTurnIntent(intent, context);

    expect(executeTool).toHaveBeenCalledTimes(1);
    expect(executeTool).toHaveBeenCalledWith(
      expect.objectContaining({
        toolName: TOOL_NAMES.MANAGE_REMINDER,
        params: expect.objectContaining({
          action: 'update',
          target: 'llamar al banco',
        }),
      }),
    );

    expect(execution.records).toHaveLength(1);
    expect(execution.records[0].result).toMatchObject({
      success: false,
      errorCode: 'AMBIGUOUS_TARGET',
      requiresClarification: true,
    });
    expect(execution.facts[0].requiresClarification).toBe(true);
  });

  it('pre-binds target and reminderId using Map lookup before executeTool for reminder cancellations', async () => {
    saveWorkingMemory(user, {
      items: [
        {
          position: 1,
          type: 'reminder',
          internalId: '22222222-2222-4222-8222-222222222222',
          summary: 'Sacar una cita',
        },
      ],
    });

    executeTool.mockResolvedValue({
      success: true,
      action: 'reminder_cancelled',
      data: { id: '22222222-2222-4222-8222-222222222222' },
    });

    const intent = {
      actions: [
        {
          domain: 'reminder',
          action: 'cancel',
          target: '1',
        },
      ],
    };

    const execution = await executeTurnIntent(intent, context);

    expect(executeTool).toHaveBeenCalledTimes(1);
    expect(executeTool).toHaveBeenCalledWith(
      expect.objectContaining({
        toolName: TOOL_NAMES.MANAGE_REMINDER,
        params: expect.objectContaining({
          action: 'cancel',
          target: '22222222-2222-4222-8222-222222222222',
          reminderId: '22222222-2222-4222-8222-222222222222',
        }),
      }),
    );
    expect(execution.records[0].result.success).toBe(true);
  });
});
