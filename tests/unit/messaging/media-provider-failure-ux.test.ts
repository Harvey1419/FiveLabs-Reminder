import { untrustedResultMock } from '../../support/unit/contract-boundary.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/agent/orchestration/router.js', () => ({
  routeMessage: vi.fn(),
}));

vi.mock('../../../src/integrations/whatsapp/kapso-client.js', () => ({
  sendWhatsAppText: vi.fn(),
  sendWhatsAppCtaUrl: vi.fn(),
  sendTypingIndicator: vi.fn(() => Promise.resolve()),
  downloadMedia: vi.fn(),
  normalizePhoneNumber: vi.fn((value: unknown) => String(value || '').replace(/\D/g, '')),
}));

vi.mock('../../../src/infrastructure/database/messages.js', () => ({
  saveMessage: vi.fn(),
  getRecentMessages: vi.fn(),
  isMessageAlreadyProcessed: vi.fn(),
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
} = await import('../../../src/infrastructure/database/messages.js');
const { getOrCreateUserByPhone } = await import('../../../src/infrastructure/database/users.js');
const { transcribeAudio } = await import('../../../src/integrations/media/transcription.js');
const { processWebhookMessage } = await import('../../../src/http/webhooks/whatsapp.js');

const handleWebhook = (req: Parameters<typeof processWebhookMessage>[0], res: ReturnType<typeof responseStub>) => Reflect.apply(processWebhookMessage, undefined, [req, res]);

function responseStub() {
  const res = { status: vi.fn(() => res), send: vi.fn(() => res) };
  return res;
}

beforeEach(() => {
  vi.clearAllMocks();
  untrustedResultMock(isMessageAlreadyProcessed).mockResolvedValue(false);
  untrustedResultMock(getOrCreateUserByPhone).mockResolvedValue({
    id: 'user-media',
    phone_number: '573001234567',
    timezone: 'America/Bogota',
    locale: 'es-CO',
  });
  untrustedResultMock(saveMessage).mockResolvedValue({ id: 'message-row' });
  untrustedResultMock(getRecentMessages).mockResolvedValue([]);
  untrustedResultMock(routeMessage).mockResolvedValue({
    intent: 'chat',
    confirmation: 'no debería ejecutarse',
    entities: {},
    executionFacts: [],
  });
});

describe('media/provider failure UX', () => {
  it('responds explicitly when an audio was received but transcription providers returned no text', async () => {
    untrustedResultMock(downloadMedia).mockResolvedValue(Buffer.from('fake-audio'));
    untrustedResultMock(transcribeAudio).mockResolvedValue('');

    const req = {
      headers: {},
      body: {
        message: {
          id: 'wa-audio-1',
          type: 'audio',
          from: '573001234567',
          timestamp: '1788960000',
          audio: { id: 'media-audio-1', mime_type: 'audio/ogg' },
        },
        phone_number_id: 'phone-number-id',
      },
    };

    await handleWebhook(req, responseStub());

    expect(routeMessage).not.toHaveBeenCalled();
    expect(sendWhatsAppText).toHaveBeenCalledTimes(1);
    expect(vi.mocked(sendWhatsAppText).mock.calls[0]![0]!.text).toMatch(/no pude procesar.*audio|audio.*no pude procesar/i);
  });
});
