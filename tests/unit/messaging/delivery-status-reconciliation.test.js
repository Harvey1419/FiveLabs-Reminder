import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/agent/orchestration/router.js', () => ({
  routeMessage: vi.fn(),
}));

vi.mock('../../../src/integrations/whatsapp/kapso-client.js', () => ({
  sendWhatsAppText: vi.fn(),
  sendWhatsAppCtaUrl: vi.fn(),
  sendTypingIndicator: vi.fn(() => Promise.resolve()),
  downloadMedia: vi.fn(),
  normalizePhoneNumber: vi.fn((value) => String(value || '').replace(/\D/g, '')),
}));

vi.mock('../../../src/infrastructure/database/messages.js', () => ({
  saveMessage: vi.fn(),
  getRecentMessages: vi.fn(),
  isMessageAlreadyProcessed: vi.fn(),
  getAssistantMessageById: vi.fn(),
}));

vi.mock('../../../src/infrastructure/database/users.js', () => ({
  getOrCreateUserByPhone: vi.fn(),
  updateUserTimezone: vi.fn(),
  touchUserLastActive: vi.fn(),
}));

vi.mock('../../../src/infrastructure/database/index.js', () => ({
  updateReminderDeliveryStatus: vi.fn(),
}));

vi.mock('../../../src/jobs/memory-extractor.js', () => ({
  extractMemoryInBackground: vi.fn(),
}));

vi.mock('../../../src/integrations/media/transcription.js', () => ({
  transcribeAudio: vi.fn(),
}));

vi.mock('../../../src/integrations/media/document-processor.js', () => ({
  processDocumentOrImage: vi.fn(),
}));

vi.mock('../../../src/shared/time.js', () => ({
  detectTimezoneFromLocationText: vi.fn(() => null),
  detectTimezoneFromCoordinates: vi.fn(() => null),
  getNearestCityFromCoordinates: vi.fn(() => null),
}));

const { routeMessage } = await import('../../../src/agent/orchestration/router.js');
const {
  sendWhatsAppText,
  downloadMedia,
} = await import('../../../src/integrations/whatsapp/kapso-client.js');
const {
  saveMessage,
  getRecentMessages,
  isMessageAlreadyProcessed,
  getAssistantMessageById,
} = await import('../../../src/infrastructure/database/messages.js');
const { getOrCreateUserByPhone } = await import('../../../src/infrastructure/database/users.js');
const { transcribeAudio } = await import('../../../src/integrations/media/transcription.js');
const { updateReminderDeliveryStatus } = await import('../../../src/infrastructure/database/index.js');
const { processWebhookMessage: handleWebhook } = await import('../../../src/http/webhooks/whatsapp.js');

function responseStub() {
  return {
    status: vi.fn(function status() { return this; }),
    send: vi.fn(function send() { return this; }),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  getAssistantMessageById.mockResolvedValue(null);
  updateReminderDeliveryStatus.mockResolvedValue(null);
  sendWhatsAppText.mockResolvedValue({ success: true, messageId: 'wamid.CONVERSATION' });
  isMessageAlreadyProcessed.mockResolvedValue(false);
  getOrCreateUserByPhone.mockResolvedValue({
    id: 'user-media',
    phone_number: '573001234567',
    timezone: 'America/Bogota',
    locale: 'es-CO',
  });
  saveMessage.mockResolvedValue({ id: 'message-row' });
  getRecentMessages.mockResolvedValue([]);
  routeMessage.mockResolvedValue({
    intent: 'chat',
    confirmation: 'no debería ejecutarse',
    entities: {},
    executionFacts: [],
  });
});


afterEach(() => { vi.restoreAllMocks(); });
const logs = () => console.log.mock.calls.map((args) => args.join(' ')).join('\n');
const statusRequest = (...ids) => ({ headers: {}, body: { statuses: ids.map((id) => ({ id, status: 'delivered' })) } });

describe('typed delivery callback correlation', () => {
  it('reconciles a known reminder using its provider delivery id', async () => {
    updateReminderDeliveryStatus.mockResolvedValue({ id: 'reminder-row', status: 'sent' });
    await handleWebhook(statusRequest('wamid.REMINDER'), responseStub());
    expect(updateReminderDeliveryStatus).toHaveBeenCalledWith({ deliveryId: 'wamid.REMINDER', deliveryStatus: 'delivered', errorDetails: null });
    expect(getAssistantMessageById).not.toHaveBeenCalled();
    expect(logs()).toContain('reminder=1 conversation=0 unmatched=0 failed=0');
    expect(console.warn).not.toHaveBeenCalled();
    expect(routeMessage).not.toHaveBeenCalled();
  });

  it('recognizes conversation callbacks separately rather than reporting a failed reminder update', async () => {
    getAssistantMessageById.mockResolvedValue({ id: 'assistant-row' });
    await handleWebhook(statusRequest('wamid.CONVERSATION'), responseStub());
    expect(getAssistantMessageById).toHaveBeenCalledWith('wamid.CONVERSATION');
    expect(logs()).toContain('reminder=0 conversation=1 unmatched=0 failed=0');
    expect(console.warn).not.toHaveBeenCalled();
  });

  it('leaves unknown or early callbacks unmatched without claiming persistence or failure', async () => {
    await handleWebhook(statusRequest('wamid.UNKNOWN'), responseStub());
    expect(logs()).toContain('unmatched=1 failed=0');
    expect(console.warn).not.toHaveBeenCalled();
  });

  it('distinguishes persistence failures and continues reconciling independent callbacks', async () => {
    updateReminderDeliveryStatus.mockRejectedValueOnce(new Error('database unavailable')).mockResolvedValueOnce({ id: 'known' });
    await handleWebhook(statusRequest('wamid.FAIL', 'wamid.OK'), responseStub());
    expect(logs()).toContain('reminder=1 conversation=0 unmatched=0 failed=1');
    expect(console.warn.mock.calls.flat().join(' ')).toContain('delivery status persistence failed');
  });

  it('does not hide a failure reading conversational correlation as an unmatched callback', async () => {
    getAssistantMessageById.mockRejectedValueOnce(new Error('read unavailable'));
    await handleWebhook(statusRequest('wamid.READ_FAIL'), responseStub());
    expect(logs()).toContain('unmatched=0 failed=1');
    expect(console.warn).toHaveBeenCalled();
  });

  it('keeps an explicit provider-reported failed delivery visible even for a conversation', async () => {
    getAssistantMessageById.mockResolvedValue({ id: 'assistant-row' });
    await handleWebhook({ headers: {}, body: { statuses: [{ id: 'wamid.FAILED', status: 'failed' }] } }, responseStub());
    expect(console.warn.mock.calls.flat().join(' ')).toContain('provider reported failed message delivery');
    expect(logs()).toContain('conversation=1');
  });

  it('persists the accepted reply id and ignores a duplicate inbound batch before another semantic decision', async () => {
    const req = { headers: {}, body: { message: { id: 'wamid.UNIQUE_BATCH_INPUT', type: 'text', from: '573001234567', text: { body: 'Dos recordatorios' } } } };
    await handleWebhook(req, responseStub());
    await handleWebhook(req, responseStub());
    expect(routeMessage).toHaveBeenCalledTimes(1);
    expect(sendWhatsAppText).toHaveBeenCalledTimes(1);
    expect(saveMessage).toHaveBeenCalledWith(expect.objectContaining({ role: 'assistant', messageId: 'wamid.CONVERSATION' }));
  });

  it('preserves the persistent duplicate guard after a restart', async () => {
    isMessageAlreadyProcessed.mockResolvedValueOnce(true);
    const req = { headers: {}, body: { message: { id: 'wamid.ALREADY_PERSISTED', from: '573001234567', text: { body: 'Dos recordatorios' } } } };
    await handleWebhook(req, responseStub());
    expect(routeMessage).not.toHaveBeenCalled();
    expect(sendWhatsAppText).not.toHaveBeenCalled();
  });
});
