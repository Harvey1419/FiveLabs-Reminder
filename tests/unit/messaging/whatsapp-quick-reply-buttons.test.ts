import { untrustedResultMock } from '../../support/unit/contract-boundary.js';
import type { KapsoRecipient } from '../../../src/integrations/whatsapp/kapso-client-core.js';
import type { processWebhookMessage as ProcessWebhookMessage } from '../../../src/http/webhooks/whatsapp.js';

type CapturedMessage = {
  messaging_product: string;
  type: string;
  interactive: {
    type: string;
    action: {
      button: string;
      buttons: Array<{ type: string; reply: { id: string; title: string } }>;
      sections: Array<{ title: string; rows: Array<{ id: string; title: string; description?: string }> }>;
    };
  };
};
type TextInput = KapsoRecipient & { text: string };

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockState = vi.hoisted(() => ({
  fetchCalls: [] as Array<{ url: Parameters<typeof fetch>[0]; body: CapturedMessage }>,
  dispatchedMessages: [] as Array<{ content: string; [field: string]: unknown }>,
  acknowledgedReminders: [] as Array<{ id: string; userId: string }>,
  updatedReminders: [] as Array<{ id: string; updates: Record<string, unknown>; userId: string; phone: string }>,
  updatedTasks: [] as Array<{ id: string; updates: Record<string, unknown>; userId: string }>,
  sentTexts: [] as TextInput[],
  sentButtons: [] as unknown[],
  sentLists: [] as unknown[],
}));

vi.mock('../../../src/infrastructure/database/index.js', () => ({
  updateReminderDeliveryStatus: vi.fn(),
  acknowledgeReminder: vi.fn(async (id: string, userId: string) => {
    mockState.acknowledgedReminders.push({ id, userId });
    return { id, user_id: userId, task_id: 'linked-task-uuid-1', status: 'sent', acknowledged_at: new Date().toISOString() };
  }),
  acknowledgeRemindersByTaskId: vi.fn(async () => []),
  updateReminder: vi.fn(async (id: string, updates: Record<string, unknown>, userId: string, phone: string) => {
    mockState.updatedReminders.push({ id, updates, userId, phone });
    return { id, ...updates };
  }),
  updateTask: vi.fn(async (id: string, updates: Record<string, unknown>, userId: string) => {
    mockState.updatedTasks.push({ id, updates, userId });
    return { id, title: 'Comprar café', ...updates };
  }),
  getReminderConfirmationPreference: vi.fn(async (userId: string) => {
    if (userId === 'user-with-pref') {
      return { requiresConfirmation: true, nudgeIntervalMinutes: 25, preferenceText: 'insistir cada 25 min' };
    }
    return null;
  }),
}));

vi.mock('../../../src/infrastructure/database/users.js', () => ({
  getOrCreateUserByPhone: vi.fn(async (phone: string) => ({
    id: 'user-uuid-1',
    phone_number: phone,
    timezone: 'America/Bogota',
    locale: String(phone).startsWith('+1') || String(phone).startsWith('1') ? 'en-US' : 'es-CO',
  })),
  updateUserTimezone: vi.fn(),
  touchUserLastActive: vi.fn(),
}));

vi.mock('../../../src/infrastructure/database/messages.js', () => ({
  saveMessage: vi.fn(async (msg: { content: string; [field: string]: unknown }) => {
    mockState.dispatchedMessages.push(msg);
    return { id: 'msg-1' };
  }),
  getRecentMessages: vi.fn(async () => []),
  isMessageAlreadyProcessed: vi.fn(async () => false),
  getAssistantMessageById: vi.fn(async () => null),
}));

vi.mock('../../../src/agent/orchestration/router.js', () => ({
  routeMessage: vi.fn(async () => ({
    text: 'routed response',
    confirmation: 'routed response',
    state: {},
  })),
}));

vi.mock('../../../src/integrations/whatsapp/kapso-client.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/integrations/whatsapp/kapso-client.js')>();
  return {
    ...actual,
    sendWhatsAppText: vi.fn(async (opts: TextInput) => {
      mockState.sentTexts.push(opts);
      return { success: true, messageId: 'wamid.TEXT_CONFIRM' };
    }),
  };
});

function responseStub() {
  const res = { status: vi.fn(() => res), send: vi.fn(() => res) };
  return res;
}

// Preserve the existing surplus response argument without widening production signatures.
function invokeWebhook(handler: typeof ProcessWebhookMessage, req: Parameters<typeof ProcessWebhookMessage>[0], res: ReturnType<typeof responseStub>) {
  return Reflect.apply(handler, undefined, [req, res]);
}

describe('WhatsApp Quick Reply Buttons & Fast-Path', () => {
  beforeEach(() => {
    mockState.fetchCalls = [];
    mockState.dispatchedMessages = [];
    mockState.acknowledgedReminders = [];
    mockState.updatedReminders = [];
    mockState.updatedTasks = [];
    mockState.sentTexts = [];
    vi.clearAllMocks();
    process.env.KAPSO_API_KEY = 'mock-key';
  });

  it.each(['ack', 'snooze', 'task'])('does not confirm an unobserved %s button mutation', async kind => {
    const db = await import('../../../src/infrastructure/database/index.js');
    if (kind === 'ack') untrustedResultMock(db.acknowledgeReminder).mockResolvedValueOnce(null);
    if (kind === 'snooze') untrustedResultMock(db.updateReminder).mockResolvedValueOnce(null);
    if (kind === 'task') untrustedResultMock(db.updateTask).mockResolvedValueOnce({ data: null, error: { code: 'NOT_FOUND' } });
    const id = kind === 'ack' ? 'rem:ack:missing' : kind === 'snooze' ? 'rem:snooze:15:missing' : 'task:done:missing';
    const interactive = kind === 'task' ? { list_reply: { id, title: 'Done' } } : { button_reply: { id, title: 'Done' } };
    const { processWebhookMessage } = await import('../../../src/http/webhooks/whatsapp.js');
    await processWebhookMessage({ headers: {}, body: { message: { id: `missing-${kind}`, from: '573001234567', interactive } } });
    expect(mockState.sentTexts).toHaveLength(1);
    expect(mockState.sentTexts[0]!.text).toContain('No pude confirmar');
    expect(mockState.sentTexts[0]!.text).not.toContain('✅');
  });

  it('keeps the language of the displayed interactive reply without inferring it from button text', async () => {
    const messages = await import('../../../src/infrastructure/database/messages.js');
    untrustedResultMock(messages.getRecentMessages).mockResolvedValueOnce([{ role: 'assistant', entities: { _responseLanguage: 'en' } }]);
    const { processWebhookMessage } = await import('../../../src/http/webhooks/whatsapp.js');
    await processWebhookMessage({ headers: {}, body: { message: { id: 'language-button', from: '573001234567', interactive: { button_reply: { id: 'rem:ack:known', title: 'Done' } } } } });
    expect(mockState.sentTexts[0]!.text).toContain('marked this reminder');
  });


  it('reports a partial acknowledgment when the linked task update is unobserved', async () => {
    const db = await import('../../../src/infrastructure/database/index.js');
    untrustedResultMock(db.updateTask).mockResolvedValueOnce(null);
    const { processWebhookMessage } = await import('../../../src/http/webhooks/whatsapp.js');
    await processWebhookMessage({ headers: {}, body: { message: { id: 'partial-button', from: '573001234567', interactive: { button_reply: { id: 'rem:ack:known', title: 'Listo' } } } } });
    expect(mockState.sentTexts[0]!.text).toContain('recordatorio como completado');
    expect(mockState.sentTexts[0]!.text).toContain('No pude confirmar todos');
  });

  it('accepts equivalent persisted timestamp encodings after snoozing', async () => {
    const db = await import('../../../src/infrastructure/database/index.js');
    untrustedResultMock(db.updateReminder).mockImplementationOnce(async (id, updates) => ({ id, ...updates, send_at: (updates!.send_at as string).replace('Z', '+00:00') }));
    const { processWebhookMessage } = await import('../../../src/http/webhooks/whatsapp.js');
    await processWebhookMessage({ headers: {}, body: { message: { id: 'offset-snooze-button', from: '573001234567', interactive: { button_reply: { id: 'rem:snooze:15:known', title: '+15 min' } } } } });
    expect(mockState.sentTexts[0]!.text).toContain('15 minutos');
    expect(mockState.sentTexts[0]!.text).not.toContain('No pude confirmar');
  });

  describe('sendWhatsAppQuickReplyButtons', () => {
    it('structures interactive button payload adhering to Meta WhatsApp limits', async () => {
      const { sendWhatsAppQuickReplyButtons } = await import('../../../src/integrations/whatsapp/kapso-client.js');

      globalThis.fetch = vi.fn(async (url: Parameters<typeof fetch>[0], options?: RequestInit) => {
        mockState.fetchCalls.push({ url, body: JSON.parse(options!.body as string) as CapturedMessage });
        return {
          ok: true,
          json: async () => ({ messages: [{ id: 'wamid.BTN_123' }] }),
        };
      }) as unknown as typeof fetch;

      const res = await sendWhatsAppQuickReplyButtons({
        phoneNumber: '+573001234567',
        bodyText: '⏰ Recordatorio: Comprar leche',
        buttons: [
          { id: 'rem:ack:123', title: '✅ Listo' },
          { id: 'rem:snooze:15:123', title: '⏰ +15 min' },
          { id: 'rem:snooze:60:123', title: '⏰ +1 hora' },
          { id: 'overflow_btn', title: 'Ignored 4th' },
        ],
      });

      expect(res.success).toBe(true);
      expect(res.messageId).toBe('wamid.BTN_123');
      expect(mockState.fetchCalls.length).toBe(1);

      const payload = mockState.fetchCalls[0]!.body;
      expect(payload.messaging_product).toBe('whatsapp');
      expect(payload.type).toBe('interactive');
      expect(payload.interactive.type).toBe('button');
      expect(payload.interactive.action.buttons.length).toBe(3);
      expect(payload.interactive.action.buttons[0]).toEqual({
        type: 'reply',
        reply: { id: 'rem:ack:123', title: '✅ Listo' },
      });
    });
  });

  describe('Webhook Fast-Path Interception', () => {
    it('executes zero-LLM fast-path when receiving rem:ack button click and cascades to linked task', async () => {
      const { processWebhookMessage: handleWebhook } = await import('../../../src/http/webhooks/whatsapp.js');
      const { routeMessage } = await import('../../../src/agent/orchestration/router.js');

      const req = {
        headers: {},
        body: {
          message: {
            id: 'wamid.INTERACTIVE_ACK',
            from: '573001234567',
            type: 'interactive',
            interactive: {
              type: 'button_reply',
              button_reply: {
                id: 'rem:ack:uuid-999',
                title: '✅ Listo',
              },
            },
          },
          phone_number_id: 'phone-123',
        },
      };

      await invokeWebhook(handleWebhook, req, responseStub());

      // Verify routeMessage (LLM) was NOT called
      expect(routeMessage).not.toHaveBeenCalled();

      // Verify reminder was acknowledged
      expect(mockState.acknowledgedReminders).toContainEqual({
        id: 'uuid-999',
        userId: 'user-uuid-1',
      });

      // Verify task completion cascade
      expect(mockState.updatedTasks).toContainEqual({
        id: 'linked-task-uuid-1',
        updates: { status: 'completed' },
        userId: 'user-uuid-1',
      });

      // Verify confirmation message was saved and sent
      expect(mockState.dispatchedMessages.some((m) => m.content.includes('completado'))).toBe(true);
    });

    it('executes zero-LLM fast-path for rem:snooze button click', async () => {
      const { processWebhookMessage: handleWebhook } = await import('../../../src/http/webhooks/whatsapp.js');
      const { routeMessage } = await import('../../../src/agent/orchestration/router.js');

      const req = {
        headers: {},
        body: {
          message: {
            id: 'wamid.INTERACTIVE_SNOOZE',
            from: '573001234567',
            type: 'interactive',
            interactive: {
              type: 'button_reply',
              button_reply: {
                id: 'rem:snooze:15:uuid-888',
                title: '⏰ +15 min',
              },
            },
          },
          phone_number_id: 'phone-123',
        },
      };

      await invokeWebhook(handleWebhook, req, responseStub());

      expect(routeMessage).not.toHaveBeenCalled();
      expect(mockState.updatedReminders.length).toBe(1);
      expect(mockState.updatedReminders[0]!.id).toBe('uuid-888');
      expect(mockState.updatedReminders[0]!.updates.status).toBe('pending');
      expect(mockState.dispatchedMessages.some((m) => m.content.includes('15 minutos'))).toBe(true);
    });

    it('executes zero-LLM fast-path in English when user locale is en-US', async () => {
      const { processWebhookMessage: handleWebhook } = await import('../../../src/http/webhooks/whatsapp.js');
      const { routeMessage } = await import('../../../src/agent/orchestration/router.js');

      const req = {
        headers: {},
        body: {
          message: {
            id: 'wamid.INTERACTIVE_ACK_EN',
            from: '+14155552671',
            type: 'interactive',
            interactive: {
              type: 'button_reply',
              button_reply: {
                id: 'rem:ack:uuid-en-1',
                title: '✅ Done',
              },
            },
          },
          phone_number_id: 'phone-123',
        },
      };

      await invokeWebhook(handleWebhook, req, responseStub());

      expect(routeMessage).not.toHaveBeenCalled();
      expect(mockState.dispatchedMessages.some((m) => m.content.includes('completed'))).toBe(true);
    });

    it('executes zero-LLM fast-path for list_reply task:done:<id> with micro-dopamina feedback', async () => {
      const { processWebhookMessage: handleWebhook } = await import('../../../src/http/webhooks/whatsapp.js');
      const { routeMessage } = await import('../../../src/agent/orchestration/router.js');

      const req = {
        headers: {},
        body: {
          message: {
            id: 'wamid.LIST_TASK_DONE',
            from: '573046154163',
            type: 'interactive',
            interactive: {
              type: 'list_reply',
              list_reply: {
                id: 'task:done:task-uuid-42',
                title: 'Comprar café',
                description: 'Tostado medio',
              },
            },
          },
          phone_number_id: 'phone-123',
        },
      };

      await invokeWebhook(handleWebhook, req, responseStub());

      expect(routeMessage).not.toHaveBeenCalled();
      expect(mockState.updatedTasks.length).toBe(1);
      expect(mockState.updatedTasks[0]).toEqual({
        id: 'task-uuid-42',
        updates: { status: 'completed' },
        userId: 'user-uuid-1',
      });
      // Check micro-dopamina celebration feedback
      expect(mockState.dispatchedMessages.some((m) => m.content.includes('¡Excelente! 🎯 Tachaste'))).toBe(true);
    });

    it('executes zero-LLM fast-path for list_reply rem:ack:<id>', async () => {
      const { processWebhookMessage: handleWebhook } = await import('../../../src/http/webhooks/whatsapp.js');
      const { routeMessage } = await import('../../../src/agent/orchestration/router.js');

      const req = {
        headers: {},
        body: {
          message: {
            id: 'wamid.LIST_REM_ACK',
            from: '573046154163',
            type: 'interactive',
            interactive: {
              type: 'list_reply',
              list_reply: {
                id: 'rem:ack:rem-uuid-99',
                title: 'Tomar pastilla',
              },
            },
          },
          phone_number_id: 'phone-123',
        },
      };

      await invokeWebhook(handleWebhook, req, responseStub());

      expect(routeMessage).not.toHaveBeenCalled();
      expect(mockState.acknowledgedReminders.length).toBe(1);
      expect(mockState.acknowledgedReminders[0]!.id).toBe('rem-uuid-99');
      expect(mockState.dispatchedMessages.some((m) => m.content.includes('¡Excelente! He marcado este recordatorio'))).toBe(true);
    });
  });

  describe('Router Buttons & List Outbound Dispatch', () => {
    it('dispatches sendWhatsAppQuickReplyButtons when router returns buttons', async () => {
      const { processWebhookMessage: handleWebhook } = await import('../../../src/http/webhooks/whatsapp.js');
      const { routeMessage } = await import('../../../src/agent/orchestration/router.js');

      untrustedResultMock(routeMessage).mockResolvedValueOnce({
        confirmation: '¿Deseas confirmar la eliminación?',
        buttons: [
          { id: 'btn_confirm', title: '✅ Confirmar' },
          { id: 'btn_cancel', title: '❌ Cancelar' },
        ],
      });

      const req = {
        headers: {},
        body: {
          message: {
            id: 'wamid.INBOUND_DELETE',
            from: '573046154163',
            text: { body: 'Eliminar proyectos' },
          },
          phone_number_id: 'phone-123',
        },
      };

      await invokeWebhook(handleWebhook, req, responseStub());

      const btnCall = mockState.fetchCalls.find((c) => c.body?.interactive?.type === 'button');
      expect(btnCall).toBeDefined();
      expect(btnCall!.body.interactive.action.buttons).toHaveLength(2);
      expect(btnCall!.body.interactive.action.buttons[0]!.reply.title).toBe('✅ Confirmar');
      expect(btnCall!.body.interactive.action.buttons[1]!.reply.title).toBe('❌ Cancelar');
    });

    it('dispatches sendWhatsAppListMessage when router returns list', async () => {
      const { processWebhookMessage: handleWebhook } = await import('../../../src/http/webhooks/whatsapp.js');
      const { routeMessage } = await import('../../../src/agent/orchestration/router.js');

      untrustedResultMock(routeMessage).mockResolvedValueOnce({
        confirmation: '📋 *Tus tareas pendientes*',
        list: {
          buttonText: 'Gestionar tareas',
          sections: [
            {
              title: 'Tareas',
              rows: [{ id: 'task:done:1', title: 'Comprar café' }],
            },
          ],
        },
      });

      const req = {
        headers: {},
        body: {
          message: {
            id: 'wamid.INBOUND_TASKS',
            from: '573046154163',
            text: { body: '¿Qué tareas tengo?' },
          },
          phone_number_id: 'phone-123',
        },
      };

      await invokeWebhook(handleWebhook, req, responseStub());

      const listCall = mockState.fetchCalls.find((c) => c.body?.interactive?.type === 'list');
      expect(listCall).toBeDefined();
      expect(listCall!.body.interactive.action.button).toBe('Gestionar tareas');
      expect(listCall!.body.interactive.action.sections[0]!.rows).toHaveLength(1);
      expect(listCall!.body.interactive.action.sections[0]!.rows[0]!.id).toBe('task:done:1');
    });
  });

  describe('Memory-driven confirmation preference', () => {
    it('resolves confirmation preference from semantic memory', async () => {
      const { getReminderConfirmationPreference } = await import('../../../src/infrastructure/database/index.js');
      const pref = await getReminderConfirmationPreference('user-with-pref');
      expect(pref).toEqual({
        requiresConfirmation: true,
        nudgeIntervalMinutes: 25,
        preferenceText: 'insistir cada 25 min',
      });
    });
  });
});
