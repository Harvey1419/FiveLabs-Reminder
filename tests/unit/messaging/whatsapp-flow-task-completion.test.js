import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockState = vi.hoisted(() => ({
  sentTexts: [],
  sentFlows: [],
  updatedTasks: [],
  acknowledgedReminders: [],
  savedMessages: [],
}));

vi.mock('../../../src/infrastructure/database/index.js', () => ({
  updateReminderDeliveryStatus: vi.fn(),
  acknowledgeReminder: vi.fn(),
  acknowledgeRemindersByTaskId: vi.fn(async (taskId, userId) => {
    mockState.acknowledgedReminders.push({ taskId, userId });
    return [{ id: 'rem-1' }];
  }),
  updateReminder: vi.fn(),
  updateTask: vi.fn(async (id, updates, userId) => {
    mockState.updatedTasks.push({ id, updates, userId });
    return {
      id,
      title: id === 'task-uuid-1' ? 'Comprar café' : 'Revisar informe',
      status: 'completed',
    };
  }),
}));

vi.mock('../../../src/infrastructure/database/users.js', () => ({
  getOrCreateUserByPhone: vi.fn(async (phone) => ({
    id: 'user-uuid-1',
    phone_number: phone,
    timezone: 'America/Bogota',
    locale: 'es-CO',
  })),
  updateUserTimezone: vi.fn(),
  touchUserLastActive: vi.fn(),
}));

vi.mock('../../../src/infrastructure/database/messages.js', () => ({
  saveMessage: vi.fn(async (msg) => {
    mockState.savedMessages.push(msg);
    return { id: 'msg-1' };
  }),
  getRecentMessages: vi.fn(async () => []),
  isMessageAlreadyProcessed: vi.fn(async () => false),
  getAssistantMessageById: vi.fn(async () => null),
}));

vi.mock('../../../src/integrations/whatsapp/kapso-client.js', () => ({
  sendWhatsAppText: vi.fn(async (params) => {
    mockState.sentTexts.push(params);
    return { success: true, messageId: 'wamid.TEXT_123' };
  }),
  sendWhatsAppCtaUrl: vi.fn(async () => ({ success: true })),
  sendWhatsAppFlow: vi.fn(async (params) => {
    mockState.sentFlows.push(params);
    return { success: true, messageId: 'wamid.FLOW_123' };
  }),
  sendTypingIndicator: vi.fn(async () => {}),
  downloadMedia: vi.fn(async () => null),
  normalizePhoneNumber: vi.fn((p) => p),
}));

vi.mock('../../../src/agent/orchestration/router.js', () => ({
  routeMessage: vi.fn(async () => ({
    intent: 'list_tasks',
    confirmation: '📁 *reminder* · 2 tareas\n\n1. Comprar café\n2. Revisar informe',
    flow: {
      flowId: '1599560168243520',
      buttonText: 'Completar tareas',
      flowToken: 'test_token',
      screen: 'TASK_SELECTION',
      mode: 'draft',
      data: {
        tasks: [
          { id: 'task-uuid-1', title: '1. Comprar café', description: '' },
          { id: 'task-uuid-2', title: '2. Revisar informe', description: '' },
        ],
      },
    },
  })),
}));

function responseStub() {
  const res = {
    status: vi.fn(() => res),
    send: vi.fn(() => res),
  };
  return res;
}

describe('WhatsApp Flow Task Completion & Delivery', () => {
  beforeEach(() => {
    mockState.sentTexts = [];
    mockState.sentFlows = [];
    mockState.updatedTasks = [];
    mockState.acknowledgedReminders = [];
    mockState.savedMessages = [];
    vi.clearAllMocks();
  });

  it('completes multiple tasks via nfm_reply Flow webhook and returns canonical completion card', async () => {
    const { handleWebhook } = await import('../../../src/http/webhooks/whatsapp.js');

    const req = {
      headers: {},
      body: {
        object: 'whatsapp_business_account',
        entry: [
          {
            id: 'WHATSAPP_BUSINESS_ACCOUNT_ID',
            changes: [
              {
                value: {
                  messaging_product: 'whatsapp',
                  metadata: {
                    display_phone_number: '123456789',
                    phone_number_id: '1248246475047194',
                  },
                  contacts: [{ profile: { name: 'Harvey' }, wa_id: '573046154163' }],
                  messages: [
                    {
                      from: '573046154163',
                      id: 'wamid.FLOW_RESPONSE_123',
                      timestamp: String(Math.floor(Date.now() / 1000)),
                      type: 'interactive',
                      interactive: {
                        type: 'nfm_reply',
                        nfm_reply: {
                          name: 'flow',
                          body: 'Sent',
                          response_json: JSON.stringify({
                            selected_ids: ['task-uuid-1', 'task-uuid-2'],
                          }),
                        },
                      },
                    },
                  ],
                },
                field: 'messages',
              },
            ],
          },
        ],
      },
    };

    await handleWebhook(req, responseStub());

    // Verify tasks were completed in database
    expect(mockState.updatedTasks).toHaveLength(2);
    expect(mockState.updatedTasks[0]).toEqual({
      id: 'task-uuid-1',
      updates: { status: 'completed' },
      userId: 'user-uuid-1',
    });
    expect(mockState.updatedTasks[1]).toEqual({
      id: 'task-uuid-2',
      updates: { status: 'completed' },
      userId: 'user-uuid-1',
    });

    // Verify reminder acknowledgment cascade
    expect(mockState.acknowledgedReminders).toHaveLength(2);

    // Verify canonical completion response sent to WhatsApp
    expect(mockState.sentTexts).toHaveLength(1);
    expect(mockState.sentTexts[0].text).toContain('✅ *2 tareas completadas*');
    expect(mockState.sentTexts[0].text).toContain('• Comprar café');
    expect(mockState.sentTexts[0].text).toContain('• Revisar informe');
  });

  it('dispatches sendWhatsAppFlow when turn result includes flow metadata', async () => {
    const { handleWebhook } = await import('../../../src/http/webhooks/whatsapp.js');

    const req = {
      headers: {},
      body: {
        object: 'whatsapp_business_account',
        entry: [
          {
            id: 'WHATSAPP_BUSINESS_ACCOUNT_ID',
            changes: [
              {
                value: {
                  messaging_product: 'whatsapp',
                  metadata: {
                    display_phone_number: '123456789',
                    phone_number_id: '1248246475047194',
                  },
                  contacts: [{ profile: { name: 'Harvey' }, wa_id: '573046154163' }],
                  messages: [
                    {
                      from: '573046154163',
                      id: 'wamid.MSG_ASK_TASKS',
                      timestamp: String(Math.floor(Date.now() / 1000)),
                      type: 'text',
                      text: { body: 'qué tareas tengo en reminder' },
                    },
                  ],
                },
                field: 'messages',
              },
            ],
          },
        ],
      },
    };

    await handleWebhook(req, responseStub());

    expect(mockState.sentFlows).toHaveLength(1);
    expect(mockState.sentFlows[0].buttonText).toBe('Completar tareas');
    expect(mockState.sentFlows[0].flowId).toBe('1599560168243520');
    expect(mockState.sentFlows[0].mode).toBe('draft');
    expect(mockState.sentFlows[0].bodyText).toContain('📁 *reminder* · 2 tareas');
    expect(mockState.sentFlows[0].flowData.tasks).toHaveLength(2);
  });
});
