import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/agent/tools/index.js', () => ({
  executeTool: vi.fn(),
}));

vi.mock('../../../src/infrastructure/database/index.js', () => ({
  getUserIntegration: vi.fn(),
  saveReminder: vi.fn(),
}));

vi.mock('../../../src/integrations/google/auth.js', () => ({
  getGoogleConnectUrl: vi.fn(() => 'https://example.test/auth'),
  revokeGoogleIntegration: vi.fn(),
  hasUsableGoogleCredentials: vi.fn(() => true),
  isGoogleAuthError: vi.fn(() => false),
}));

vi.mock('../../../src/integrations/google/calendar.js', () => ({
  listCalendarEvents: vi.fn(),
  createCalendarEvent: vi.fn(),
  updateCalendarEvent: vi.fn(),
  deleteCalendarEvent: vi.fn(),
}));

const { executeTool } = await import('../../../src/agent/tools/index.js');
const { getUserIntegration, saveReminder } = await import('../../../src/infrastructure/database/index.js');
const { createCalendarEvent } = await import('../../../src/integrations/google/calendar.js');
const { executeCalendarTool } = await import('../../../src/agent/tools/calendar.js');
const { executeTurnIntent } = await import('../../../src/agent/orchestration/intent-executor.js');
const { validateTurnIntent } = await import('../../../src/agent/contracts/intent-contracts.js');
const {
  saveWorkingMemory,
  clearWorkingMemory,
  getWorkingMemory,
  getWorkingMemorySnapshot,
  hydrateWorkingMemoryFromHistory,
} = await import('../../../src/agent/core/working-memory-store.js');

const user = {
  id: 'user-audit',
  phone_number: '573001234567',
  timezone: 'America/Bogota',
  locale: 'es-CO',
};

const executionContext = {
  user,
  isPro: true,
  language: 'es',
  timezone: 'America/Bogota',
  referenceTime: new Date('2026-09-09T13:00:00.000Z'),
  correlationId: 'audit-regression',
};

beforeEach(() => {
  vi.clearAllMocks();
  clearWorkingMemory(user);
  getUserIntegration.mockResolvedValue({ access_token: 'token' });
  createCalendarEvent.mockResolvedValue({
    id: 'event-created',
    summary: 'Reunión con Laura',
    start: '2026-09-10T15:00:00-05:00',
    end: '2026-09-10T16:00:00-05:00',
  });
  executeTool.mockResolvedValue({
    success: true,
    complete: true,
    action: 'ok',
    data: {},
    rawSummary: 'ok',
    formattedCard: 'ok',
  });
});

describe('Hermes product-quality audit P0 regressions', () => {
  it('calendar.create does not invent a WhatsApp reminder when Hermes did not request advance notice', async () => {
    const result = await executeCalendarTool({
      action: 'create_event',
      params: {
        summary: 'Reunión con Laura',
        startDateTime: '2099-09-10T15:00:00-05:00',
        durationMinutes: 60,
      },
      user,
      language: 'es',
      referenceTime: new Date('2099-09-09T13:00:00.000Z'),
    });

    expect(result.success).toBe(true);
    expect(saveReminder).not.toHaveBeenCalled();
    expect(result.data.reminderCreated).toBe(false);
    expect(result.data.reminderSendAt).toBeNull();
  });

  it('calendar.create creates the linked WhatsApp reminder only for an explicit advance notice', async () => {
    await executeCalendarTool({
      action: 'create_event',
      params: {
        summary: 'Reunión con Laura',
        startDateTime: '2099-09-10T15:00:00-05:00',
        durationMinutes: 60,
        advanceMinutes: 30,
      },
      user,
      language: 'es',
      referenceTime: new Date('2099-09-09T13:00:00.000Z'),
    });

    expect(saveReminder).toHaveBeenCalledTimes(1);
    expect(saveReminder).toHaveBeenCalledWith(expect.objectContaining({
      content: expect.stringContaining('Reunión con Laura'),
      requiresConfirmation: true,
    }));
  });

  it('calendar time-only updates keep target identity out of summary patch fields', async () => {
    await executeTurnIntent({
      actions: [{
        domain: 'calendar',
        action: 'update',
        target: 'reunión con Laura',
        schedule: {
          kind: 'calendar_date_time',
          year: 2026,
          month: 9,
          day: 10,
          hour: 17,
          minute: 0,
          clockMode: 'explicit_24h',
        },
      }],
    }, executionContext);

    expect(executeTool).toHaveBeenCalledTimes(1);
    const call = executeTool.mock.calls[0][0];
    expect(call.params.action).toBe('update_event');
    expect(call.params.target).toBe('reunión con Laura');
    expect(call.params.startDateTime).toBeDefined();
    expect(call.params).not.toHaveProperty('summary');
  });

  it('calendar explicit rename sends a summary delta while keeping target separate', async () => {
    await executeTurnIntent({
      actions: [{
        domain: 'calendar',
        action: 'update',
        target: 'reunión con Laura',
        title: 'Reunión con Laura y Pedro',
      }],
    }, executionContext);

    const call = executeTool.mock.calls[0][0];
    expect(call.params.target).toBe('reunión con Laura');
    expect(call.params.summary).toBe('Reunión con Laura y Pedro');
    expect(call.params).not.toHaveProperty('startDateTime');
  });

  it('rejects existing-object mutations that omit target instead of resolving identity from patch fields', () => {
    const cases = [
      { domain: 'task', action: 'update', title: 'Informe final' },
      { domain: 'task', action: 'complete', title: 'Informe final' },
      { domain: 'task', action: 'delete', title: 'Informe final' },
      { domain: 'calendar', action: 'update', title: 'Reunión final' },
      { domain: 'calendar', action: 'delete', title: 'Reunión final' },
      { domain: 'reminder', action: 'acknowledge', content: 'Comprar leche' },
      { domain: 'reminder', action: 'cancel', content: 'Comprar leche' },
    ];

    for (const action of cases) {
      const result = validateTurnIntent({ actions: [action] });
      expect(result.valid, `${action.domain}.${action.action}`).toBe(false);
      expect(result.errorCode).toBe('MISSING_TARGET');
    }
  });

  it('pending.revise uses target only to select a proposal and never as destructive entity identity', async () => {
    saveWorkingMemory(user, {
      source: 'entity',
      scope: 'clarification',
      entityType: 'entity',
      lastAction: 'clarification_required',
      pendingClarifications: [
        {
          type: 'clarification',
          content: 'Eliminar Proyecto A',
          proposedOperation: { kind: 'entity_delete', targetName: 'Proyecto A', category: 'project', scope: 'single' },
        },
        {
          type: 'clarification',
          content: 'Eliminar Proyecto B',
          proposedOperation: { kind: 'entity_delete', targetName: 'Proyecto B', category: 'project', scope: 'single' },
        },
      ],
      items: [],
    });

    await executeTurnIntent({
      actions: [{
        domain: 'pending',
        action: 'revise',
        target: '2',
        preserveNames: ['Proyecto X'],
      }],
    }, executionContext);

    expect(executeTool).toHaveBeenCalledTimes(1);
    const call = executeTool.mock.calls[0][0];
    expect(call.params.targetName).toBe('Proyecto B');
    expect(call.params.targetName).not.toBe('2');
    expect(call.params.preserveNames).toEqual(['Proyecto X']);
  });
});

describe('Hermes product-quality audit continuity regressions', () => {
  it('rehydrates typed Working Memory from persisted assistant history after an in-memory restart', () => {
    saveWorkingMemory(user, {
      source: 'unified',
      scope: 'all_pending',
      entityType: 'all',
      lastAction: 'list',
      items: [
        { type: 'task', internalId: 'task-1', title: 'Comprar comida' },
        { type: 'reminder', internalId: 'reminder-2', content: 'Llamar a Laura' },
      ],
    });
    const snapshot = getWorkingMemorySnapshot(user);
    expect(snapshot?.items).toHaveLength(2);

    clearWorkingMemory(user);
    expect(getWorkingMemory(user)).toBeNull();

    hydrateWorkingMemoryFromHistory(user, [{
      role: 'assistant',
      content: 'Pendientes listados.',
      createdAt: new Date().toISOString(),
      entities: { _workingMemory: snapshot },
    }]);

    const restored = getWorkingMemory(user);
    expect(restored?.items).toHaveLength(2);
    expect(restored?.items[1].internalId).toBe('reminder-2');
  });

  it('does not revive stale persisted Working Memory indefinitely', () => {
    saveWorkingMemory(user, {
      source: 'unified',
      scope: 'all_pending',
      items: [{ type: 'task', internalId: 'task-stale', title: 'Vieja' }],
    });
    const snapshot = getWorkingMemorySnapshot(user);
    clearWorkingMemory(user);

    hydrateWorkingMemoryFromHistory(user, [{
      role: 'assistant',
      content: 'Estado viejo.',
      createdAt: new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString(),
      entities: { _workingMemory: snapshot },
    }]);

    expect(getWorkingMemory(user)).toBeNull();
  });
});
