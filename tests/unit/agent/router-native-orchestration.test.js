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
  retrieveRelevantMemoriesResult: vi.fn().mockResolvedValue({ status: 'available', memories: [] }),
  retrieveStandingPreferencesResult: vi.fn().mockResolvedValue({ status: 'available', memories: [] }),
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
import { getStructuredTurnSchema } from '../../../src/agent/contracts/foreground-turn-schema.js';
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

const supportedOperations = new Set(getStructuredTurnSchema().properties.actions.items.properties.operation.enum);

function modelToolCall(payload) {
  const actions = Array.isArray(payload.actions) ? payload.actions.map(action => {
    const operation = `${action.domain}.${action.action}`;
    if (!supportedOperations.has(operation)) return action;
    const { domain, action: verb, ...fields } = action;
    return { operation, ...fields };
  }) : payload.actions;
  return { role: 'assistant', content: JSON.stringify({ responseCapability: 'general', ...payload, actions }), tool_calls: [] };
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
  it.each([
    ['missing capability', { actions: [{ operation: 'conversation.reply', content: 'Unsafe bypass' }] }],
    ['null capability', { responseCapability: null, actions: [{ operation: 'conversation.reply', content: 'Unsafe bypass' }] }],
    ['invalid capability', { responseCapability: 'invalid', actions: [{ operation: 'conversation.reply', content: 'Unsafe bypass' }] }],
    ['missing task status', { responseCapability: 'general', actions: [{ operation: 'task.list' }] }],
  ])('rejects raw %s without fixture defaults or tool effects', async (_name, payload) => {
    callChatCompletion.mockResolvedValue({ role: 'assistant', content: JSON.stringify(payload), tool_calls: [] });
    const result = await routeMessage('Consulta', user, []);
    expect(result.intent).toBe('clarification');
    expect(result.plan.type).toBe('invalid_intent');
    expect(executeTool).not.toHaveBeenCalled();
    expect(callChatCompletion).toHaveBeenCalledTimes(1);
  });

  it.each([{}, { domain: 'unknown', action: 'reply' }, { operation: 'unknown.reply' }])('does not repair missing or unknown mock operations: %j', async action => {
    callChatCompletion.mockResolvedValue(modelToolCall({ actions: [action] }));
    const result = await routeMessage('Consulta', user, []);
    expect(result.plan.type).toBe('invalid_intent');
    expect(executeTool).not.toHaveBeenCalled();
  });
  it('captures foreground policy separating historical dates, mutable state and ordinary dialogue', async () => {
    callChatCompletion.mockResolvedValue(modelToolCall({ responseCapability: 'general', actions: [{ domain: 'conversation', action: 'reply', content: 'Con gusto.' }] }));
    const history = [{ role: 'assistant', content: 'Creación anterior', entities: { _turnMetadata: { kind: 'operational_result', mutationReceipts: [{ operation: 'reminder.create', summary: 'Recordatorio programado: Alfa, 14 de enero de 2031' }] } } }];
    const result = await routeMessage('Gracias por acompañarme', user, history);
    const [messages, options] = callChatCompletion.mock.calls[0];
    const policy = messages[0].content;
    process.stdout.write(`DV18 captured foreground=${policy.length} schema=${JSON.stringify(options.responseFormat).length} characters\n`);
    expect(policy).toContain('fechas de compromisos históricos: evidencia canónica, no el año del reloj');
    expect(policy).toContain('conversation.recap historical renders recorded facts');
    expect(policy).toContain('Current: explicit reads, not history.');
    expect(policy).not.toContain('NUNCA respondas desde el historial');
    expect(result.confirmation).toBe('Con gusto.');
    expect(result.confirmation).not.toContain('2031');
    expect(callChatCompletion).toHaveBeenCalledTimes(1);
    expect(executeTool).not.toHaveBeenCalled();
    expect(callResponseSynthesis).not.toHaveBeenCalled();
  });
  it('inherits persisted conversation language for ambiguous replies without changing the profile', async () => {
    callChatCompletion.mockResolvedValue(modelToolCall({ actions: [{ domain: 'conversation', action: 'reply', content: 'You are welcome.' }] }));
    const result = await routeMessage('OK', user, [{ role: 'assistant', content: 'Done.', entities: { _responseLanguage: 'en' } }]);
    expect(result.language).toBe('en');
    expect(callChatCompletion.mock.calls[0][0][0].content).toContain('Stored language fallback: en');
    expect(user.locale).toBe('es-CO');
  });
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

  it('rejects a free-text success claim outside the mandatory decision contract', async () => {
    callChatCompletion.mockResolvedValue({ role: 'assistant', content: 'I scheduled your reminder for 8 AM.', tool_calls: [] });
    const result = await routeMessage('Please remind me later', user, []);
    expect(result.executionFacts).toEqual([]);
    expect(result.confirmation).not.toContain('I scheduled your reminder');
    expect(executeTool).not.toHaveBeenCalled();
  });

  it.each([
    'You wrote "I scheduled your reminder" — was that true?',
    'Me dijiste: «Ya programé tu recordatorio». ¿Eso sí pasó?',
  ])('does not mistake a quoted historical mutation claim for the assistant claiming success: %s', async (reply) => {
    callChatCompletion.mockResolvedValue(modelToolCall({
      actions: [{ domain: 'conversation', action: 'reply', content: reply }],
    }));

    const result = await routeMessage('What did I say earlier?', user, []);

    expect(result.confirmation).toBe(reply);
    expect(result.executionFacts).toEqual([]);
    expect(executeTool).not.toHaveBeenCalled();
  });

  it('renders observed failure instead of a preexecution success claim in a mixed intent', async () => {
    callChatCompletion.mockResolvedValue(modelToolCall({ actions: [
      { domain: 'conversation', action: 'reply', content: 'Ya programé tu recordatorio para las 8.' },
      { domain: 'reminder', action: 'create', content: 'Llamar', schedule: { kind: 'relative_offset', offsetMinutes: 20 } },
    ] }));
    executeTool.mockResolvedValue({ success: false, error: 'No se pudo guardar.', errorCode: 'DATABASE_ERROR' });
    const result = await routeMessage('Recuérdame llamar en veinte minutos', user, []);
    expect(result.confirmation).not.toContain('Ya programé');
    expect(result.executionFacts[0].success).toBe(false);
  });

  it('marks memory context unavailable instead of telling the model no memory exists', async () => {
    const memoryService = await import('../../../src/features/memory/service.js');
    vi.spyOn(memoryService, 'retrieveRelevantMemoriesResult').mockResolvedValueOnce({ status: 'unavailable', memories: [] });
    vi.spyOn(memoryService, 'retrieveStandingPreferencesResult').mockResolvedValueOnce({ status: 'unavailable', memories: [] });
    callChatCompletion.mockResolvedValue(modelToolCall({
      actions: [{ domain: 'conversation', action: 'reply', content: 'Entendido.' }],
    }));

    await routeMessage('What do you remember about me?', user, []);

    const systemPrompt = callChatCompletion.mock.calls[0][0][0].content;
    expect(systemPrompt).toContain('Memory retrieval is temporarily unavailable');
    expect(systemPrompt).not.toContain('(Ninguna memoria relevante para este turno)');
  });

  it('keeps an English reminder action bound to the current utterance despite Spanish quote and OCR context', async () => {
    const currentUserText = 'Please remind me to review the report in 30 minutes.';
    callChatCompletion.mockResolvedValue(modelToolCall({
      responseLanguage: 'en',
      actions: [{
        domain: 'reminder', action: 'create', content: 'Review the report',
        schedule: { kind: 'relative_offset', offsetMinutes: 30 },
      }],
    }));
    executeTool.mockResolvedValue({
      success: true,
      complete: true,
      action: 'created_reminder',
      data: { items: [{ id: 'synthetic-reminder-1', content: 'Review the report', sendAt: '2026-10-01T18:55:00.000Z' }] },
      confirmation: 'Reminder saved.',
      rawSummary: 'Reminder saved.',
    });

    const result = await routeMessage(
      `${currentUserText}\n<untrusted_quoted_message>Recuérdame pagar la factura mañana.</untrusted_quoted_message>\n<untrusted_attachment_content>Reunión a las 5.</untrusted_attachment_content>`,
      { ...user, timezone: 'America/Los_Angeles', locale: 'es-CO' },
      [],
      { currentUserText, requestTimeMs: Date.parse('2026-10-01T18:25:00.000Z') },
    );

    expect(executeTool).toHaveBeenCalledTimes(1);
    expect(executeTool).toHaveBeenCalledWith(expect.objectContaining({
      toolName: 'manage_reminder',
      params: expect.objectContaining({ action: 'create', items: [expect.objectContaining({ content: 'Review the report' })] }),
    }));
    expect(result.executionFacts).toEqual(expect.arrayContaining([expect.objectContaining({ success: true })]));
    const systemPrompt = callChatCompletion.mock.calls[0][0][0].content;
    expect(systemPrompt).toContain("CURRENT USER's language");
    expect(result.language).toBe('en');
    expect(executeTool.mock.calls[0][0].language).toBe('en');
    expect(systemPrompt).not.toContain('pagar la factura mañana');
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
      actions: [{ domain: 'task', action: 'list', status: 'pending' }],
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
        status: 'pending',
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
    callChatCompletion.mockResolvedValueOnce(modelToolCall({
      actions: [{ domain: 'task', action: 'complete', target: 'Enviar reporte' }],
    })).mockResolvedValueOnce({ content: JSON.stringify({ position: 1, suggestion: 'Puedes preparar la reunión de balance de las 4:00 PM.' }) });
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
    expect(result.confirmation).toContain('Puedes preparar la reunión de balance de las 4:00 PM.');
    expect(executeTool).toHaveBeenCalledTimes(1);
  });

  it('answers personal facts from user memories directly via conversation.reply without emitting memory.search', async () => {
    const memoryService = await import('../../../src/features/memory/service.js');
    vi.spyOn(memoryService, 'retrieveRelevantMemoriesResult').mockResolvedValueOnce({ status: 'available', memories: [
      { category: 'fact', content: 'El usuario debe 580000 pesos al proyecto Apartamento' },
    ] });
    callChatCompletion.mockResolvedValue(modelToolCall({
      actions: [{ domain: 'conversation', action: 'reply', content: 'Le debes 580.000 pesos al proyecto Apartamento.' }],
    }));

    const result = await routeMessage('¿Cuánto debo del apartamento?', user, []);

    expect(result.intent).toBe('chat');
    expect(result.confirmation).toBe('Le debes 580.000 pesos al proyecto Apartamento.');
    expect(executeTool).not.toHaveBeenCalled();
    const systemPrompt = callChatCompletion.mock.calls[0][0][0].content;
    expect(systemPrompt).toContain('El usuario debe 580000 pesos al proyecto Apartamento');
  });

  it('injects live project tasks into context and answers debt questions in conversation.reply without emitting task.list cards', async () => {
    const dbIndex = await import('../../../src/infrastructure/database/index.js');
    vi.spyOn(dbIndex, 'getDailyOverview').mockResolvedValueOnce({
      pendingTasksByEntity: {
        Apartamento: [
          { title: 'devolver 465.000 pesos', localFormatted: 'Mañana a las 12:00 PM' },
          { title: 'comprar escritorio' },
        ],
      },
    });
    callChatCompletion.mockResolvedValue(modelToolCall({
      actions: [{ domain: 'conversation', action: 'reply', content: 'Del apartamento tienes una tarea de devolver 465.000 pesos programada para mañana a las 12:00 PM.' }],
    }));

    const result = await routeMessage('Oye, ¿cuánto debo del apartamento?', user, []);

    expect(result.intent).toBe('chat');
    expect(result.confirmation).toBe('Del apartamento tienes una tarea de devolver 465.000 pesos programada para mañana a las 12:00 PM.');
    expect(executeTool).not.toHaveBeenCalled();
    const systemPrompt = callChatCompletion.mock.calls[0][0][0].content;
    expect(systemPrompt).toContain('[Tareas vivas del proyecto/entidad: Apartamento]');
    expect(systemPrompt).toContain('• devolver 465.000 pesos [Mañana a las 12:00 PM]');
  });

  it('routes explicit task or debt completion ("ya los pagué") to task.complete mutation', async () => {
    executeTool.mockResolvedValueOnce({
      success: true,
      action: 'completed_task',
      data: { id: 'task-123', title: 'devolver 465.000 pesos', entities: { name: 'Apartamento' } },
    });
    callChatCompletion.mockResolvedValue(modelToolCall({
      actions: [
        { domain: 'task', action: 'complete', target: 'devolver 465.000 pesos', entityName: 'Apartamento' },
        { domain: 'conversation', action: 'reply', content: '¡Excelente! Ya marqué como pagada la deuda de 465.000 pesos del apartamento.' },
      ],
    }));

    const result = await routeMessage('ya los pagué', user, [
      { role: 'user', content: '¿Cuánto debo del apartamento?' },
      { role: 'assistant', content: 'Debes 465.000 pesos del proyecto Apartamento.' },
    ]);

    expect(executeTool).toHaveBeenCalledWith(expect.objectContaining({
      toolName: 'manage_task',
      params: expect.objectContaining({
        action: 'complete',
        target: 'devolver 465.000 pesos',
        entityName: 'Apartamento',
      }),
    }));
    expect(result.confirmation).toContain('Tarea completada');
  });
});
