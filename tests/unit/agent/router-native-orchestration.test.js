import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/agent/tools/index.js', () => ({
  executeTool: vi.fn(),
}));
vi.mock('../../../src/agent/providers/client.js', () => ({
  callChatCompletion: vi.fn(),
  callResponseSynthesis: vi.fn().mockResolvedValue(null),
  callPendingTransitionVerification: vi.fn(),
}));
vi.mock('../../../src/features/memory/service.js', () => ({
  retrieveRelevantMemories: vi.fn().mockResolvedValue([]),
}));
vi.mock('../../../src/infrastructure/database/index.js', () => ({
  getDailyOverview: vi.fn().mockResolvedValue(null),
  getUserSubscription: vi.fn().mockResolvedValue({ status: 'authorized', plan: 'pro' }),
  getUserIntegration: vi.fn().mockResolvedValue(null),
  hasProAccess: vi.fn().mockReturnValue(true),
  createPendingSubscription: vi.fn().mockResolvedValue(null),
}));
vi.mock('../../../src/integrations/mercado-pago/client.js', () => ({ getOrCreateCanonicalPlan: vi.fn() }));
vi.mock('../../../src/integrations/google/auth.js', () => ({
  getGoogleConnectUrl: vi.fn(() => 'https://example.test/google'),
  hasUsableGoogleCredentials: vi.fn(() => false),
}));

import { routeMessage } from '../../../src/agent/orchestration/router.js';
import { executeTool } from '../../../src/agent/tools/index.js';
import { callChatCompletion, callPendingTransitionVerification, callResponseSynthesis } from '../../../src/agent/providers/client.js';
import { clearWorkingMemory, saveWorkingMemory } from '../../../src/agent/core/working-memory.js';

const user = {
  id: 'user-1',
  phone_number: '573001112233',
  timezone: 'America/Bogota',
  locale: 'es-CO',
  display_name: 'Juan',
};

function modelToolCall(payload) {
  return {
    role: 'assistant',
    content: null,
    tool_calls: [{
      id: 'turn_1',
      type: 'function',
      function: { name: 'execute_turn', arguments: JSON.stringify(payload) },
    }],
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  clearWorkingMemory(user);
});

describe('Hermes direct TurnIntent router', () => {
  it('delivers normal conversation through conversation.reply with one structured model decision', async () => {
    callChatCompletion.mockResolvedValue(modelToolCall({
      actions: [{ domain: 'conversation', action: 'reply', content: 'Te llamas Juan.' }],
    }));

    const result = await routeMessage('¿Cómo me llamo?', user, []);

    expect(result.confirmation).toBe('Te llamas Juan.');
    expect(result.intent).toBe('chat');
    expect(result.plan.actions).toEqual([{ domain: 'conversation', action: 'reply' }]);
    expect(callChatCompletion).toHaveBeenCalledTimes(1);
    expect(callChatCompletion).toHaveBeenCalledWith(expect.any(Array), expect.objectContaining({ toolChoice: 'auto' }));
    expect(executeTool).not.toHaveBeenCalled();
    expect(callPendingTransitionVerification).not.toHaveBeenCalled();
    expect(callResponseSynthesis).not.toHaveBeenCalled();
  });

  it('recovers a prose-only operational miss into a verified reminder.list instead of sending stale prose', async () => {
    callChatCompletion
      .mockResolvedValueOnce({
        role: 'assistant',
        content: '🔔 Recordatorios pendientes: algo reconstruido del historial',
        tool_calls: [],
      })
      .mockResolvedValueOnce(modelToolCall({
        actions: [{ domain: 'reminder', action: 'list' }],
      }));
    executeTool.mockResolvedValue({
      success: true,
      complete: true,
      action: 'listed_reminders',
      rawSummary: 'Recordatorios consultados.',
      data: {
        timezone: 'America/Bogota',
        locale: 'es-CO',
        reminders: [{
          id: 'r1',
          content: 'Me amo mucho',
          send_at: '2026-09-08T13:00:00.000Z',
          recurrence_rule: 'daily',
          status: 'pending',
        }],
      },
    });

    const result = await routeMessage('¿Qué recordatorios tengo pendientes?', user, []);

    expect(callChatCompletion).toHaveBeenCalledTimes(2);
    expect(callChatCompletion.mock.calls[0][1]).toMatchObject({ toolChoice: 'auto', purpose: 'initial' });
    expect(callChatCompletion.mock.calls[1][1]).toMatchObject({
      toolChoice: 'auto', purpose: 'structured_recovery', startStage: 'secondary',
    });
    expect(result.confirmation).toContain('🔔 *Recordatorios pendientes*');
    expect(result.confirmation).not.toContain('algo reconstruido');
    expect(executeTool).toHaveBeenCalledWith(expect.objectContaining({
      toolName: 'manage_reminder',
      params: expect.objectContaining({ action: 'list' }),
    }));
  });

  it('recovers ordinary prose conversation into conversation.reply without executing a domain tool', async () => {
    callChatCompletion
      .mockResolvedValueOnce({ role: 'assistant', content: '¡Con gusto! 😊', tool_calls: [] })
      .mockResolvedValueOnce(modelToolCall({
        actions: [{ domain: 'conversation', action: 'reply', content: '¡Con gusto! 😊' }],
      }));

    const result = await routeMessage('Gracias', user, []);

    expect(callChatCompletion).toHaveBeenCalledTimes(2);
    expect(result.intent).toBe('chat');
    expect(result.confirmation).toBe('¡Con gusto! 😊');
    expect(executeTool).not.toHaveBeenCalled();
  });

  it('still refuses prose when structured recovery also misses', async () => {
    callChatCompletion
      .mockResolvedValueOnce({ role: 'assistant', content: 'texto no verificado', tool_calls: [] })
      .mockResolvedValueOnce({ role: 'assistant', content: 'otro texto no estructurado', tool_calls: [] });

    const result = await routeMessage('¿Qué recordatorios tengo pendientes?', user, []);

    expect(result.intent).toBe('clarification');
    expect(result.plan.type).toBe('missing_structured_decision');
    expect(result.confirmation).not.toContain('texto no verificado');
    expect(result.confirmation).not.toContain('otro texto no estructurado');
    expect(executeTool).not.toHaveBeenCalled();
  });

  it('routes a normal typed standalone greeting through Hermes conversation.reply', async () => {
    callChatCompletion.mockResolvedValue(modelToolCall({
      actions: [{ domain: 'conversation', action: 'reply', content: '¡Hola! 👋 ¿En qué te ayudo?' }],
    }));

    const result = await routeMessage('Hola', user, []);

    expect(result.intent).toBe('chat');
    expect(result.confirmation).toContain('¡Hola!');
    expect(callChatCompletion).toHaveBeenCalledTimes(1);
    expect(executeTool).not.toHaveBeenCalled();
  });

  it('routes an audio transcript that looks like a greeting through the same Hermes path', async () => {
    callChatCompletion.mockResolvedValue(modelToolCall({
      actions: [{ domain: 'conversation', action: 'reply', content: 'Entendido.' }],
    }));

    const result = await routeMessage('Hola', user, [], { inputModality: 'audio', correlationId: 'audio-greeting-test' });

    expect(callChatCompletion).toHaveBeenCalledTimes(1);
    expect(callChatCompletion).toHaveBeenCalledWith(expect.any(Array), expect.objectContaining({ toolChoice: 'auto' }));
    expect(result.intent).toBe('chat');
    expect(result.confirmation).toBe('Entendido.');
  });

  it('routes an active reminder fulfillment to acknowledge when Hermes expresses that semantic action', async () => {
    saveWorkingMemory(user, {
      source: 'reminder',
      scope: 'notification',
      lastAction: 'nudge',
      notificationReminderId: 'reminder-1',
      notificationContent: 'Salir',
      items: [{ id: 'reminder-1', type: 'reminder', content: 'Salir' }],
    });
    callChatCompletion.mockResolvedValue(modelToolCall({
      actions: [{ domain: 'reminder', action: 'acknowledge', target: 'Salir' }],
    }));
    executeTool.mockResolvedValue({
      success: true,
      complete: true,
      action: 'acknowledged_reminder',
      confirmation: '✅ *Confirmado:* Salir',
      rawSummary: '✅ *Confirmado:* Salir',
      data: { reminder: { id: 'reminder-1', content: 'Salir' }, content: 'Salir' },
    });

    const result = await routeMessage('Te decía que ya salí', user, [], { correlationId: 'ack-context-test' });

    expect(executeTool).toHaveBeenCalledTimes(1);
    expect(executeTool).toHaveBeenCalledWith(expect.objectContaining({
      toolName: 'manage_reminder',
      params: expect.objectContaining({ action: 'acknowledge', target: 'Salir' }),
    }));
    expect(result.confirmation.toLowerCase()).toContain('confirmado');
  });

  it('routes a generic pending question to Unified Agenda with all_pending', async () => {
    callChatCompletion.mockResolvedValue(modelToolCall({
      actions: [{ domain: 'agenda', action: 'read' }],
    }));
    executeTool.mockResolvedValue({
      success: true,
      complete: true,
      action: 'unified_agenda_listed',
      confirmation: '📋 *Pendientes actuales*\n\n☑️ *TAREAS*\n• Revisar memoria',
      rawSummary: '📋 *Pendientes actuales*\n\n☑️ *TAREAS*\n• Revisar memoria',
      data: { items: [] },
    });

    const result = await routeMessage('¿Qué tenemos pendiente?', user, []);

    expect(executeTool).toHaveBeenCalledTimes(1);
    expect(executeTool).toHaveBeenCalledWith(expect.objectContaining({
      toolName: 'get_unified_agenda',
      params: expect.objectContaining({ scope: 'all_pending' }),
    }));
    expect(result.confirmation).toContain('📋 *Pendientes actuales*');
    expect(callChatCompletion).toHaveBeenCalledTimes(1);
    expect(callChatCompletion).toHaveBeenCalledWith(expect.any(Array), expect.objectContaining({ toolChoice: 'auto' }));
    expect(callPendingTransitionVerification).not.toHaveBeenCalled();
    expect(callResponseSynthesis).not.toHaveBeenCalled();
  });

  it('routes an explicit reminder inventory through reminder.list instead of conversation.reply', async () => {
    callChatCompletion.mockResolvedValue(modelToolCall({
      actions: [{ domain: 'reminder', action: 'list' }],
    }));
    executeTool.mockResolvedValue({
      success: true,
      complete: true,
      action: 'listed_reminders',
      rawSummary: 'Recordatorios consultados.',
      data: {
        timezone: 'America/Bogota',
        locale: 'es-CO',
        reminders: [{
          id: 'r1',
          content: 'Me amo mucho',
          send_at: '2026-09-08T13:00:00.000Z',
          recurrence_rule: 'daily',
          status: 'pending',
        }],
      },
    });

    const result = await routeMessage('¿Qué recordatorios tenemos pendiente?', user, []);

    expect(executeTool).toHaveBeenCalledWith(expect.objectContaining({
      toolName: 'manage_reminder',
      params: expect.objectContaining({ action: 'list' }),
    }));
    expect(result.confirmation).toContain('🔔 *Recordatorios pendientes*');
    expect(result.confirmation).toContain('🕒');
    expect(result.confirmation).not.toContain('**');
  });

  it('preserves explicit agenda scope instead of using all_pending', async () => {
    callChatCompletion.mockResolvedValue(modelToolCall({
      actions: [{ domain: 'agenda', action: 'read', scope: 'today' }],
    }));
    executeTool.mockResolvedValue({
      success: true,
      complete: true,
      action: 'unified_agenda_listed',
      confirmation: '📅 *Tu agenda para hoy:*',
      rawSummary: '📅 *Tu agenda para hoy:*',
      data: { items: [] },
    });

    await routeMessage('¿Qué tengo para hoy?', user, []);

    expect(executeTool).toHaveBeenCalledWith(expect.objectContaining({
      toolName: 'get_unified_agenda',
      params: expect.objectContaining({ scope: 'today' }),
    }));
  });

  it('executes canonical memory.save without any legacy manifest compilation', async () => {
    callChatCompletion.mockResolvedValue(modelToolCall({
      actions: [{ domain: 'memory', action: 'save', content: 'Trabajo en Globant' }],
    }));
    executeTool.mockResolvedValue({
      success: true,
      complete: true,
      action: 'saved_memory',
      confirmation: '🧠 *Guardado en mi memoria:*\n"Trabajo en Globant"',
      rawSummary: '🧠 *Guardado en mi memoria:*\n"Trabajo en Globant"',
      data: { memory: { id: 'memory-1' } },
    });

    const result = await routeMessage('Recuerda que trabajo en Globant', user, []);

    expect(executeTool).toHaveBeenCalledWith(expect.objectContaining({
      toolName: 'manage_memory',
      params: expect.objectContaining({ action: 'save', content: 'Trabajo en Globant' }),
    }));
    expect(result.confirmation).toContain('🧠');
  });

  it('does not call a general semantic verifier or presentation model after ordinary actions', async () => {
    callChatCompletion.mockResolvedValue(modelToolCall({
      actions: [{
        domain: 'reminder',
        action: 'create',
        content: 'Comprar leche',
        schedule: { kind: 'relative_offset', offsetMinutes: 30 },
      }],
    }));
    executeTool.mockResolvedValue({
      success: true,
      complete: true,
      action: 'created_reminder',
      confirmation: '✅ *Recordatorio programado*\n\n⏰ *Comprar leche*',
      rawSummary: '✅ *Recordatorio programado*\n\n⏰ *Comprar leche*',
      data: { items: [] },
    });

    await routeMessage('Recuérdame comprar leche en 30 minutos', user, []);

    expect(callChatCompletion).toHaveBeenCalledTimes(1);
    expect(callPendingTransitionVerification).not.toHaveBeenCalled();
    expect(callResponseSynthesis).not.toHaveBeenCalled();
  });
});
