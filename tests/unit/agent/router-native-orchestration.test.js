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
vi.mock('../../../src/integrations/mercado-pago/client.js', () => ({ getOrCreateCanonicalPlan: vi.fn() }));
vi.mock('../../../src/integrations/google/auth.js', () => ({
  getGoogleConnectUrl: vi.fn(() => 'https://example.test/google'),
  hasUsableGoogleCredentials: vi.fn(() => false),
}));

import { routeMessage } from '../../../src/agent/orchestration/router.js';
import { executeTool } from '../../../src/agent/tools/index.js';
import { callChatCompletion, callPendingTransitionVerification, callResponseSynthesis } from '../../../src/agent/providers/client.js';
import { getDailyOverview } from '../../../src/infrastructure/database/index.js';
import { clearWorkingMemory, getWorkingMemory, saveWorkingMemory } from '../../../src/agent/core/working-memory.js';

const user = {
  id: 'user-1',
  phone_number: '573001112233',
  timezone: 'America/Bogota',
  locale: 'es-CO',
  display_name: 'Juan',
};

function modelToolCall(payload) {
  return { role: 'assistant', content: JSON.stringify(payload), tool_calls: [] };
}

function activeFollowup(id = 'reminder-1', content = 'Llamar a Julieth') {
  return {
    pendingConfirmationReminders: [{
      id,
      content,
      status: 'sent',
      localFormatted: 'Hoy a las 10:00 AM',
      nudgeCount: 1,
    }],
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  getDailyOverview.mockResolvedValue(null);
  clearWorkingMemory(user);
});

describe('Hermes direct TurnIntent router', () => {
  it('delivers normal conversation through conversation.reply with one required structured model decision', async () => {
    callChatCompletion.mockResolvedValue(modelToolCall({
      actions: [{ domain: 'conversation', action: 'reply', content: 'Te llamas Juan.' }],
    }));

    const result = await routeMessage('¿Cómo me llamo?', user, []);

    expect(result.confirmation).toBe('Te llamas Juan.');
    expect(result.intent).toBe('chat');
    expect(result.plan.actions).toEqual([{ domain: 'conversation', action: 'reply' }]);
    expect(callChatCompletion).toHaveBeenCalledTimes(1);
    expect(callChatCompletion).toHaveBeenCalledWith(expect.any(Array), expect.objectContaining({
      toolChoice: 'none', purpose: 'initial', responseFormat: expect.objectContaining({ type: 'json_schema' }),
    }));
    expect(executeTool).not.toHaveBeenCalled();
    expect(callPendingTransitionVerification).not.toHaveBeenCalled();
    expect(callResponseSynthesis).not.toHaveBeenCalled();
  });

  it('never trusts prose-only operational output or sends a second semantic recovery call', async () => {
    callChatCompletion.mockResolvedValue({
      role: 'assistant',
      content: '🔔 Recordatorios pendientes: algo reconstruido del historial',
      tool_calls: [],
    });

    const result = await routeMessage('¿Qué recordatorios tengo pendientes?', user, []);

    expect(callChatCompletion).toHaveBeenCalledTimes(1);
    expect(result.intent).toBe('clarification');
    expect(result.plan.type).toBe('invalid_intent');
    expect(result.confirmation).not.toContain('algo reconstruido');
    expect(executeTool).not.toHaveBeenCalled();
  });

  it('never uses prose-only conversation as a bypass around execute_turn', async () => {
    callChatCompletion.mockResolvedValue({ role: 'assistant', content: '¡Con gusto! 😊', tool_calls: [] });

    const result = await routeMessage('Gracias', user, []);

    expect(callChatCompletion).toHaveBeenCalledTimes(1);
    expect(result.intent).toBe('clarification');
    expect(result.plan.type).toBe('invalid_intent');
    expect(result.confirmation).not.toContain('¡Con gusto!');
    expect(executeTool).not.toHaveBeenCalled();
  });

  it('preserves the authentic conversational transcript in history while executing live reads for inventory', async () => {
    executeTool.mockResolvedValue({ success: true, action: 'listed_tasks', data: { tasks: [] } });
    callChatCompletion.mockResolvedValue(modelToolCall({
      actions: [{ domain: 'task', action: 'list' }],
    }));
    const history = [{
      role: 'assistant',
      content: '☑️ Tareas · 1\n\n• Inventario antiguo',
      intent: 'task',
    }];

    const result = await routeMessage('Consulta el estado actual.', user, history);
    const messages = callChatCompletion.mock.calls[0][0];
    expect(result.intent).toBe('task');
    expect(messages.some((message) => message.content.includes('Inventario antiguo'))).toBe(true);
    expect(executeTool).toHaveBeenCalled();
  });

  it('preserves interactive assistant questions and operational cards in history for conversational continuity', async () => {
    callChatCompletion.mockResolvedValue(modelToolCall({
      actions: [{ domain: 'conversation', action: 'reply', content: 'Anotado para las 5:00 PM.' }],
    }));
    const history = [{
      role: 'assistant',
      content: '¿A qué hora prefieres que te programe el recordatorio?',
      intent: 'reminder',
    }];

    await routeMessage('A las 5pm', user, history);
    const messages = callChatCompletion.mock.calls[0][0];
    expect(messages.some((message) => message.content.includes('¿A qué hora prefieres que te programe el recordatorio?'))).toBe(true);
  });

  it('routes a normal typed standalone greeting through Hermes conversation.reply in one call', async () => {
    callChatCompletion.mockResolvedValue(modelToolCall({
      actions: [{ domain: 'conversation', action: 'reply', content: '¡Hola! 👋 ¿En qué te ayudo?' }],
    }));

    const result = await routeMessage('Hola hola', user, []);

    expect(result.intent).toBe('chat');
    expect(result.confirmation).toContain('¡Hola!');
    expect(callChatCompletion).toHaveBeenCalledTimes(1);
    expect(callChatCompletion.mock.calls[0][1]).toMatchObject({ toolChoice: 'none', purpose: 'initial', responseFormat: expect.objectContaining({ type: 'json_schema' }) });
    expect(executeTool).not.toHaveBeenCalled();
  });

  it('routes an audio transcript through the same required structured path', async () => {
    callChatCompletion.mockResolvedValue(modelToolCall({
      actions: [{ domain: 'conversation', action: 'reply', content: 'Entendido.' }],
    }));

    const result = await routeMessage('Hola', user, [], { inputModality: 'audio', correlationId: 'audio-greeting-test' });

    expect(callChatCompletion).toHaveBeenCalledTimes(1);
    expect(callChatCompletion).toHaveBeenCalledWith(expect.any(Array), expect.objectContaining({ toolChoice: 'none', responseFormat: expect.objectContaining({ type: 'json_schema' }) }));
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

  it.each(['ok', 'listo', 'confirmalo'])('binds a semantic acknowledgement of an active notice to its exact backend identity: %s', async (message) => {
    getDailyOverview.mockResolvedValue(activeFollowup());
    callChatCompletion.mockResolvedValue(modelToolCall({
      actions: [{ domain: 'reminder', action: 'acknowledge' }],
    }));
    executeTool.mockResolvedValue({
      success: true,
      complete: true,
      action: 'acknowledged_reminder',
      data: { id: 'reminder-1', content: 'Llamar a Julieth', acknowledged_at: '2026-09-11T15:00:00.000Z' },
    });

    const result = await routeMessage(message, user, []);

    expect(executeTool).toHaveBeenCalledWith(expect.objectContaining({
      toolName: 'manage_reminder',
      params: {
        action: 'acknowledge',
        target: 'Llamar a Julieth',
        reminderId: 'reminder-1',
      },
    }));
    expect(result.confirmation).toContain('Llamar a Julieth');
    const systemPrompt = callChatCompletion.mock.calls[0][0][0].content;
    expect(systemPrompt).toContain('status=AWAITING_ACKNOWLEDGEMENT');
  });

  it('does not acknowledge when Hermes determines the response is unrelated', async () => {
    getDailyOverview.mockResolvedValue(activeFollowup());
    callChatCompletion.mockResolvedValue(modelToolCall({
      actions: [{ domain: 'conversation', action: 'reply', content: 'Claro, hablemos de eso.' }],
    }));

    const result = await routeMessage('Cambiemos de tema', user, []);

    expect(result.intent).toBe('chat');
    expect(executeTool).not.toHaveBeenCalled();
  });

  it('fails closed when several active notices remain ambiguous', async () => {
    getDailyOverview.mockResolvedValue({
      pendingConfirmationReminders: [
        activeFollowup('reminder-1', 'Llamar a Julieth').pendingConfirmationReminders[0],
        activeFollowup('reminder-2', 'Pagar el recibo').pendingConfirmationReminders[0],
      ],
    });
    callChatCompletion.mockResolvedValue(modelToolCall({
      actions: [{ domain: 'reminder', action: 'acknowledge' }],
    }));

    const result = await routeMessage('hecho', user, []);

    expect(executeTool).not.toHaveBeenCalled();
    expect(result.executionFacts[0]).toMatchObject({
      success: false,
      errorCode: 'MISSING_REQUIRED_CONTEXT',
      requiresClarification: true,
    });
  });

  it('closes acknowledgement Working Memory and does not mutate again on a later conversational turn', async () => {
    saveWorkingMemory(user, {
      source: 'reminder',
      lastAction: 'nudge',
      notificationReminderId: 'reminder-1',
      notificationContent: 'Llamar a Julieth',
      items: [{ id: 'reminder-1', type: 'reminder', content: 'Llamar a Julieth' }],
    });
    getDailyOverview
      .mockResolvedValueOnce(activeFollowup())
      .mockResolvedValueOnce({ pendingConfirmationReminders: [] });
    callChatCompletion
      .mockResolvedValueOnce(modelToolCall({ actions: [{ domain: 'reminder', action: 'acknowledge' }] }))
      .mockResolvedValueOnce(modelToolCall({ actions: [{ domain: 'conversation', action: 'reply', content: '¿En qué más te ayudo?' }] }));
    executeTool.mockResolvedValue({
      success: true,
      complete: true,
      action: 'acknowledged_reminder',
      data: { id: 'reminder-1', content: 'Llamar a Julieth', acknowledged_at: '2026-09-11T15:00:00.000Z' },
    });

    await routeMessage('hecho', user, []);
    expect(getWorkingMemory(user)).toBeNull();
    const second = await routeMessage('ok', user, []);

    expect(executeTool).toHaveBeenCalledTimes(1);
    expect(second.intent).toBe('chat');
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
    expect(callChatCompletion).toHaveBeenCalledWith(expect.any(Array), expect.objectContaining({ toolChoice: 'none', responseFormat: expect.objectContaining({ type: 'json_schema' }) }));
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
    expect(result.confirmation).toContain('🗓️');
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

  it('routes structured task list operations from Hermes without ad-hoc lexical interception', async () => {
    callChatCompletion.mockResolvedValue(modelToolCall({
      actions: [{
        domain: 'task',
        action: 'list',
        entityName: 'reminder',
        scope: 'all_pending',
      }],
    }));
    executeTool.mockResolvedValue({
      success: true,
      action: 'listed_tasks',
      rawSummary: 'Tareas consultadas.',
      data: {
        tasks: [
          { id: 't1', content: 'enumerar tareas en vez de por lista con punto' },
          { id: 't2', content: 'Gestionar mejor los proyectos' },
          { id: 't3', content: 'Mejorar la gestión de la memoria' },
        ],
        entityName: 'reminder',
        scope: 'all_pending',
      },
    });

    const result = await routeMessage('"qué tareas tengo en reminder', user, []);

    expect(executeTool).toHaveBeenCalledWith(expect.objectContaining({
      toolName: 'manage_task',
      params: expect.objectContaining({ action: 'list', entityName: 'reminder', scope: 'all_pending' }),
    }));
    expect(result.confirmation).toContain('*reminder*');
    expect(result.confirmation).toContain('1. enumerar tareas en vez de por lista con punto');
    expect(result.confirmation).toContain('2. Gestionar mejor los proyectos');
    expect(result.confirmation).toContain('3. Mejorar la gestión de la memoria');
  });

  it('respects pure conversation replies without lexical regex interception in Node', async () => {
    callChatCompletion.mockResolvedValue(modelToolCall({
      actions: [{
        domain: 'conversation',
        action: 'reply',
        content: '¡Hola! ¿Cómo estás hoy?',
      }],
    }));

    const result = await routeMessage('Hola Hermes qué tal', user, []);

    expect(executeTool).not.toHaveBeenCalled();
    expect(result.confirmation).toBe('¡Hola! ¿Cómo estás hoy?');
  });

  it('suppresses speculative conversation reply framing when turn performs pure domain reads', async () => {
    callChatCompletion.mockResolvedValue(modelToolCall({
      actions: [
        {
          domain: 'conversation',
          action: 'reply',
          content: 'No tienes eventos programados en Google Calendar para mañana.',
        },
        {
          domain: 'calendar',
          action: 'list',
          scope: 'tomorrow',
        },
      ],
    }));
    executeTool.mockResolvedValue({
      success: true,
      action: 'google_events_listed',
      rawSummary: 'Eventos en tu Google Calendar:\n• 📅 CCS Daily interna — Mañana a las 9:00 AM',
      confirmation: 'Eventos en tu Google Calendar:\n• 📅 CCS Daily interna — Mañana a las 9:00 AM',
      formattedCard: 'Eventos en tu Google Calendar:\n• 📅 CCS Daily interna — Mañana a las 9:00 AM',
      data: {
        events: [{ summary: 'CCS Daily interna', start: '2026-09-17T09:00:00-05:00' }],
      },
    });

    const result = await routeMessage('Y en google calendar ?', user, []);

    expect(executeTool).toHaveBeenCalledWith(expect.objectContaining({
      toolName: 'manage_google_calendar',
      params: expect.objectContaining({ action: 'list_events', scope: 'tomorrow' }),
    }));
    expect(result.confirmation).toContain('Eventos en tu Google Calendar');
    expect(result.confirmation).toContain('CCS Daily interna');
    expect(result.confirmation).not.toContain('No tienes eventos programados');
  });

  it('appends proactive Next Best Action steering when completing a task with upcoming items', async () => {
    getDailyOverview.mockResolvedValue({
      timedRemindersToday: [
        { id: 'rem-upcoming', title: 'Reunión de balance', localTime: '4:00 PM' },
      ],
      tasksDueToday: [],
    });
    callChatCompletion.mockResolvedValue(modelToolCall({
      actions: [{ domain: 'task', action: 'complete', target: 'Enviar reporte' }],
    }));
    executeTool.mockResolvedValue({
      success: true,
      complete: true,
      action: 'completed_task',
      data: { id: 'task-1', title: 'Enviar reporte', entities: { name: 'Trabajo' } },
      formattedCard: '✅ *Tarea completada*\n\n📁 *Trabajo*\n• Enviar reporte',
    });

    const result = await routeMessage('Completé la tarea de enviar el reporte', user, []);

    expect(executeTool).toHaveBeenCalledWith(expect.objectContaining({
      toolName: 'manage_task',
      params: expect.objectContaining({ action: 'complete' }),
    }));
    expect(result.confirmation).toContain('✅ *Tarea completada*');
    expect(result.confirmation).toContain('Enviar reporte');
    expect(result.confirmation).toContain('💡 *Siguiente paso*: Tu próximo recordatorio es *Reunión de balance* a las 4:00 PM.');
  });
});
