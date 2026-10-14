import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/agent/tools/index.js', () => ({ executeTool: vi.fn() }));
vi.mock('../../../src/agent/providers/client.js', () => ({
  callChatCompletion: vi.fn(),
  callResponseSynthesis: vi.fn().mockResolvedValue(null),
}));
vi.mock('../../../src/features/memory/service.js', () => ({
  retrieveRelevantMemories: vi.fn().mockResolvedValue([]),
  retrieveStandingPreferences: vi.fn().mockResolvedValue([]),
  getProactiveAnchors: vi.fn().mockResolvedValue([]),
}));
vi.mock('../../../src/infrastructure/database/index.js', () => ({
  getDailyOverview: vi.fn().mockResolvedValue(null),
  getUserSubscription: vi.fn().mockResolvedValue({ status: 'authorized', plan: 'pro' }),
  getUserIntegration: vi.fn().mockResolvedValue(null),
  hasProAccess: vi.fn().mockReturnValue(true),
  createPendingSubscription: vi.fn().mockResolvedValue(null),
}));
vi.mock('../../../src/integrations/google/auth.js', () => ({
  getGoogleConnectUrl: vi.fn(() => 'https://example.test/google'),
  hasUsableGoogleCredentials: vi.fn(() => false),
}));

const { routeMessage } = await import('../../../src/agent/orchestration/router.js');
const { executeTool } = await import('../../../src/agent/tools/index.js');
const { callChatCompletion } = await import('../../../src/agent/providers/client.js');
const {
  saveWorkingMemory,
  clearWorkingMemory,
  getWorkingMemorySnapshot,
} = await import('../../../src/agent/core/working-memory.js');

const user = {
  id: 'provider-user',
  phone_number: '573009998877',
  timezone: 'America/Bogota',
  locale: 'es-CO',
};

function modelToolCall(payload: { actions?: Array<{ domain: string; action: string; [field: string]: unknown }>; [field: string]: unknown }) {
  const wire = Array.isArray(payload.actions) ? {
    responseLanguage: 'es', responseCapability: 'general', ...payload,
    actions: payload.actions.map((item) => {
      if (!item || typeof item !== 'object') return item;
      const { domain, action, ...fields } = item;
      return { operation: `${domain}.${action}`, ...fields };
    }),
  } : payload;
  return { role: 'assistant' as const, content: JSON.stringify(wire), tool_calls: [] };
}

beforeEach(() => {
  vi.clearAllMocks();
  clearWorkingMemory(user);
});

describe('provider failure and continuity UX', () => {
  it('reports provider unavailability without blaming the user or executing anything', async () => {
    vi.mocked(callChatCompletion, { partial: true }).mockRejectedValue(new Error('provider unavailable'));

    const result = await routeMessage('Recuérdame llamar a Laura mañana a las 5', user, []);

    expect(result.intent).toBe('clarification');
    expect(result.plan?.type).toBe('provider_unavailable');
    expect(result.confirmation).toContain('No pude completar esa acción');
    expect(result.confirmation).toContain('No ejecuté acciones nuevas en este turno');
    expect(result.confirmation).toContain('no invalida las confirmaciones anteriores');
    expect(result.confirmation).not.toMatch(/proveedor|modelo|groq|openrouter|baseten/i);
    expect(result.confirmation).not.toContain('interpreta');
    expect(executeTool).not.toHaveBeenCalled();
  });

  it('rehydrates and re-persists typed Working Memory through the router after a process restart', async () => {
    saveWorkingMemory(user, {
      source: 'unified',
      scope: 'all_pending',
      items: [
        { type: 'task', internalId: 'task-router-1', title: 'Comprar comida' },
        { type: 'reminder', internalId: 'reminder-router-2', content: 'Llamar a Laura' },
      ],
    });
    const snapshot = getWorkingMemorySnapshot(user);
    clearWorkingMemory(user);

    vi.mocked(callChatCompletion, { partial: true }).mockResolvedValue(modelToolCall({
      actions: [{ domain: 'conversation', action: 'reply', content: 'Sí, tengo el contexto.' }],
    }));

    const result = await routeMessage('¿Sigues ahí?', user, [{
      role: 'assistant' as const,
      content: 'Te mostré tus pendientes.',
      createdAt: new Date().toISOString(),
      entities: { _workingMemory: snapshot },
    }]);

    expect(result.confirmation).toBe('Sí, tengo el contexto.');
    expect((result.entities!._workingMemory as { items: Array<{ internalId: string }> }).items).toHaveLength(2);
    expect((result.entities!._workingMemory as { items: Array<{ internalId: string }> }).items[1]!.internalId).toBe('reminder-router-2');
  });
});
