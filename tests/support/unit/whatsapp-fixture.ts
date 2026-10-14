import { vi } from 'vitest';
import { createWhatsAppWebhook } from '../../../src/http/webhooks/whatsapp-handler.js';
import type { WhatsAppWebhookDependencies } from '../../../src/http/webhooks/whatsapp-ports.js';
import { withoutTurnLease } from '../../../src/agent/core/turn-lease.js';
import { extractCurrentUserText } from '../../../src/shared/current-user-input.js';
import { getNearestCityFromCoordinates } from '../../../src/shared/time.js';
const epoch = Date.parse('2026-10-13T11:00:00Z');
export function createWhatsAppFixture() {
  const timers: { callback: () => unknown; ms: number }[] = [];
  const user = { id: 'owner', phone_number: '573000000001', locale: 'en-US' };
  const deps = {
    enqueueInboundTurn: vi.fn<WhatsAppWebhookDependencies['enqueueInboundTurn']>(async () => ({ inserted: true })),
    assertTurnLease: vi.fn(async () => {}), checkpointTurnResponse: vi.fn<WhatsAppWebhookDependencies['checkpointTurnResponse']>(async () => {}), withoutTurnLease,
    clearWorkingMemory: vi.fn(), routeMessage: vi.fn<WhatsAppWebhookDependencies['routeMessage']>(async () => ({ confirmation: 'Confirmed', intent: 'chat', entities: {}, executionFacts: [], language: 'en' })),
    sendWhatsAppText: vi.fn<WhatsAppWebhookDependencies['sendWhatsAppText']>(async () => ({ success: true, messageId: 'wamid.text' })),
    sendWhatsAppFlow: vi.fn<WhatsAppWebhookDependencies['sendWhatsAppFlow']>(async () => ({ success: true, messageId: 'wamid.flow' })),
    sendWhatsAppCtaUrl: vi.fn<WhatsAppWebhookDependencies['sendWhatsAppCtaUrl']>(async () => ({ success: true, messageId: 'wamid.cta' })),
    sendWhatsAppQuickReplyButtons: vi.fn<WhatsAppWebhookDependencies['sendWhatsAppQuickReplyButtons']>(async () => ({ success: true, messageId: 'wamid.buttons' })),
    sendWhatsAppListMessage: vi.fn<WhatsAppWebhookDependencies['sendWhatsAppListMessage']>(async () => ({ success: true, messageId: 'wamid.list' })),
    sendTypingIndicator: vi.fn(async () => null), downloadMedia: vi.fn<WhatsAppWebhookDependencies['downloadMedia']>(async () => null),
    normalizePhoneNumber: (value: unknown) => typeof value === 'string' && value.replace(/\D/g, '').length >= 7 ? value.replace(/\D/g, '') : null,
    saveMessage: vi.fn<WhatsAppWebhookDependencies['saveMessage']>(async () => ({ id: 'history' })), getRecentMessages: vi.fn<WhatsAppWebhookDependencies['getRecentMessages']>(async () => []),
    isMessageAlreadyProcessed: vi.fn(async () => false), getAssistantMessageById: vi.fn(async () => null), getOrCreateUserByPhone: vi.fn<WhatsAppWebhookDependencies['getOrCreateUserByPhone']>(async () => user), touchUserLastActive: vi.fn(),
    updateReminderDeliveryStatus: vi.fn<WhatsAppWebhookDependencies['updateReminderDeliveryStatus']>(async () => null),
    acknowledgeReminder: vi.fn<WhatsAppWebhookDependencies['acknowledgeReminder']>(async () => null), acknowledgeRemindersByTaskId: vi.fn<WhatsAppWebhookDependencies['acknowledgeRemindersByTaskId']>(async () => null),
    updateReminder: vi.fn<WhatsAppWebhookDependencies['updateReminder']>(async () => null), updateTask: vi.fn<WhatsAppWebhookDependencies['updateTask']>(async () => null),
    extractMemoryInBackground: vi.fn<WhatsAppWebhookDependencies['extractMemoryInBackground']>(),
    withQueryEmbeddingScope: <T>(_owner: string, work: () => T): T => work(), transcribeAudio: vi.fn(async () => ''), processDocumentOrImage: vi.fn(async () => ''),
    getNearestCityFromCoordinates, extractCurrentUserText, isIntradayRecurrence: (rule: unknown) => String(rule).startsWith('hourly'),
    getEnv: () => ({ KAPSO_PHONE_NUMBER_ID: 'default-origin' }), getNow: () => new Date(epoch), getNowMs: () => epoch, randomUUID: () => 'correlation',
    setTimeout: (callback: () => unknown, ms: number) => { timers.push({ callback, ms }); return { unref() {} }; }, logger: { log: vi.fn(), warn: vi.fn(), error: vi.fn() },
  } satisfies WhatsAppWebhookDependencies;
  return { deps, timers, user, ...createWhatsAppWebhook(deps) };
}
