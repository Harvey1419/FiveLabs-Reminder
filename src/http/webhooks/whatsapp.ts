import crypto from 'crypto';
import { enqueueInboundTurn } from '../../infrastructure/database/inbound-turns.js';
import { assertTurnLease, checkpointTurnResponse, withoutTurnLease } from '../../agent/core/turn-lease.js';
import { clearWorkingMemory } from '../../agent/core/working-memory.js';
import { routeMessage } from '../../agent/orchestration/router.js';
import {
  sendWhatsAppText,
  sendWhatsAppCtaUrl,
  sendWhatsAppFlow,
  sendWhatsAppQuickReplyButtons,
  sendWhatsAppListMessage,
  sendTypingIndicator,
  downloadMedia,
  normalizePhoneNumber,
} from '../../integrations/whatsapp/kapso-client.js';
import { saveMessage, getRecentMessages, isMessageAlreadyProcessed, getAssistantMessageById } from '../../infrastructure/database/messages.js';
import { getOrCreateUserByPhone, touchUserLastActive } from '../../infrastructure/database/users.js';
import {
  updateReminderDeliveryStatus,
  acknowledgeReminder,
  acknowledgeRemindersByTaskId,
  updateReminder,
  updateTask,
} from '../../infrastructure/database/index.js';
import { extractMemoryInBackground } from '../../jobs/memory-extractor.js';
import { withQueryEmbeddingScope } from '../../integrations/ai/embeddings.js';
import { transcribeAudio } from '../../integrations/media/transcription.js';
import { processDocumentOrImage } from '../../integrations/media/document-processor.js';
import { getNearestCityFromCoordinates } from '../../shared/time.js';
import { extractCurrentUserText } from '../../shared/current-user-input.js';
import { isIntradayRecurrence } from '../../shared/reminder-recurrence.js';

import { createWhatsAppWebhook } from './whatsapp-handler.js';

const webhook = createWhatsAppWebhook({
  enqueueInboundTurn: ((...args: Parameters<typeof enqueueInboundTurn>) => enqueueInboundTurn(...args)) as unknown as Parameters<typeof createWhatsAppWebhook>[0]['enqueueInboundTurn'],
  assertTurnLease: ((...args: Parameters<typeof assertTurnLease>) => assertTurnLease(...args)) as unknown as Parameters<typeof createWhatsAppWebhook>[0]['assertTurnLease'],
  checkpointTurnResponse: ((...args: Parameters<typeof checkpointTurnResponse>) => checkpointTurnResponse(...args)) as unknown as Parameters<typeof createWhatsAppWebhook>[0]['checkpointTurnResponse'],
  withoutTurnLease: ((...args: Parameters<typeof withoutTurnLease>) => withoutTurnLease(...args)) as unknown as Parameters<typeof createWhatsAppWebhook>[0]['withoutTurnLease'],
  clearWorkingMemory: ((...args: Parameters<typeof clearWorkingMemory>) => clearWorkingMemory(...args)) as unknown as Parameters<typeof createWhatsAppWebhook>[0]['clearWorkingMemory'],
  routeMessage: ((...args: Parameters<typeof routeMessage>) => routeMessage(...args)) as unknown as Parameters<typeof createWhatsAppWebhook>[0]['routeMessage'],
  sendWhatsAppText: ((...args: Parameters<typeof sendWhatsAppText>) => sendWhatsAppText(...args)) as unknown as Parameters<typeof createWhatsAppWebhook>[0]['sendWhatsAppText'],
  sendWhatsAppCtaUrl: ((...args: Parameters<typeof sendWhatsAppCtaUrl>) => sendWhatsAppCtaUrl(...args)) as unknown as Parameters<typeof createWhatsAppWebhook>[0]['sendWhatsAppCtaUrl'],
  sendWhatsAppFlow: ((...args: Parameters<typeof sendWhatsAppFlow>) => sendWhatsAppFlow(...args)) as unknown as Parameters<typeof createWhatsAppWebhook>[0]['sendWhatsAppFlow'],
  sendWhatsAppQuickReplyButtons: ((...args: Parameters<typeof sendWhatsAppQuickReplyButtons>) => sendWhatsAppQuickReplyButtons(...args)) as unknown as Parameters<typeof createWhatsAppWebhook>[0]['sendWhatsAppQuickReplyButtons'],
  sendWhatsAppListMessage: ((...args: Parameters<typeof sendWhatsAppListMessage>) => sendWhatsAppListMessage(...args)) as unknown as Parameters<typeof createWhatsAppWebhook>[0]['sendWhatsAppListMessage'],
  sendTypingIndicator: ((...args: Parameters<typeof sendTypingIndicator>) => sendTypingIndicator(...args)) as unknown as Parameters<typeof createWhatsAppWebhook>[0]['sendTypingIndicator'],
  downloadMedia: ((...args: Parameters<typeof downloadMedia>) => downloadMedia(...args)) as unknown as Parameters<typeof createWhatsAppWebhook>[0]['downloadMedia'],
  normalizePhoneNumber: ((...args: Parameters<typeof normalizePhoneNumber>) => normalizePhoneNumber(...args)) as unknown as Parameters<typeof createWhatsAppWebhook>[0]['normalizePhoneNumber'],
  saveMessage: ((...args: Parameters<typeof saveMessage>) => saveMessage(...args)) as unknown as Parameters<typeof createWhatsAppWebhook>[0]['saveMessage'],
  getRecentMessages: ((...args: Parameters<typeof getRecentMessages>) => getRecentMessages(...args)) as unknown as Parameters<typeof createWhatsAppWebhook>[0]['getRecentMessages'],
  isMessageAlreadyProcessed: ((...args: Parameters<typeof isMessageAlreadyProcessed>) => isMessageAlreadyProcessed(...args)) as unknown as Parameters<typeof createWhatsAppWebhook>[0]['isMessageAlreadyProcessed'],
  getAssistantMessageById: ((...args: Parameters<typeof getAssistantMessageById>) => getAssistantMessageById(...args)) as unknown as Parameters<typeof createWhatsAppWebhook>[0]['getAssistantMessageById'],
  getOrCreateUserByPhone: ((...args: Parameters<typeof getOrCreateUserByPhone>) => getOrCreateUserByPhone(...args)) as unknown as Parameters<typeof createWhatsAppWebhook>[0]['getOrCreateUserByPhone'],
  touchUserLastActive: ((...args: Parameters<typeof touchUserLastActive>) => touchUserLastActive(...args)) as unknown as Parameters<typeof createWhatsAppWebhook>[0]['touchUserLastActive'],
  updateReminderDeliveryStatus: ((...args: Parameters<typeof updateReminderDeliveryStatus>) => updateReminderDeliveryStatus(...args)) as unknown as Parameters<typeof createWhatsAppWebhook>[0]['updateReminderDeliveryStatus'],
  acknowledgeReminder: ((...args: Parameters<typeof acknowledgeReminder>) => acknowledgeReminder(...args)) as unknown as Parameters<typeof createWhatsAppWebhook>[0]['acknowledgeReminder'],
  acknowledgeRemindersByTaskId: ((...args: Parameters<typeof acknowledgeRemindersByTaskId>) => acknowledgeRemindersByTaskId(...args)) as unknown as Parameters<typeof createWhatsAppWebhook>[0]['acknowledgeRemindersByTaskId'],
  updateReminder: ((...args: Parameters<typeof updateReminder>) => updateReminder(...args)) as unknown as Parameters<typeof createWhatsAppWebhook>[0]['updateReminder'],
  updateTask: ((...args: Parameters<typeof updateTask>) => updateTask(...args)) as unknown as Parameters<typeof createWhatsAppWebhook>[0]['updateTask'],
  extractMemoryInBackground: ((...args: Parameters<typeof extractMemoryInBackground>) => extractMemoryInBackground(...args)) as unknown as Parameters<typeof createWhatsAppWebhook>[0]['extractMemoryInBackground'],
  withQueryEmbeddingScope: ((...args: Parameters<typeof withQueryEmbeddingScope>) => withQueryEmbeddingScope(...args)) as unknown as Parameters<typeof createWhatsAppWebhook>[0]['withQueryEmbeddingScope'],
  transcribeAudio: ((...args: Parameters<typeof transcribeAudio>) => transcribeAudio(...args)) as unknown as Parameters<typeof createWhatsAppWebhook>[0]['transcribeAudio'],
  processDocumentOrImage: ((...args: Parameters<typeof processDocumentOrImage>) => processDocumentOrImage(...args)) as unknown as Parameters<typeof createWhatsAppWebhook>[0]['processDocumentOrImage'],
  getNearestCityFromCoordinates: ((...args: Parameters<typeof getNearestCityFromCoordinates>) => getNearestCityFromCoordinates(...args)) as unknown as Parameters<typeof createWhatsAppWebhook>[0]['getNearestCityFromCoordinates'],
  extractCurrentUserText: ((...args: Parameters<typeof extractCurrentUserText>) => extractCurrentUserText(...args)) as unknown as Parameters<typeof createWhatsAppWebhook>[0]['extractCurrentUserText'],
  isIntradayRecurrence: ((...args: Parameters<typeof isIntradayRecurrence>) => isIntradayRecurrence(...args)) as unknown as Parameters<typeof createWhatsAppWebhook>[0]['isIntradayRecurrence'],
  getEnv: () => process.env, getNow: () => new Date(), getNowMs: () => Date.now(),
  randomUUID: () => crypto.randomUUID(), setTimeout: ((...args: Parameters<typeof setTimeout>) => setTimeout(...args)) as unknown as Parameters<typeof createWhatsAppWebhook>[0]['setTimeout'], logger: console,
});
export function markAsProcessed(...args: Parameters<typeof webhook.markAsProcessed>) { return webhook.markAsProcessed(...args); }
export function isDuplicate(...args: Parameters<typeof webhook.isDuplicate>) { return webhook.isDuplicate(...args); }
export function enqueueForUser(...args: Parameters<typeof webhook.enqueueForUser>) { return webhook.enqueueForUser(...args); }
export function extractPhoneNumberId(...args: Parameters<typeof webhook.extractPhoneNumberId>) { return webhook.extractPhoneNumberId(...args); }
export function extractContactInfo(...args: Parameters<typeof webhook.extractContactInfo>) { return webhook.extractContactInfo(...args); }
export function isOutboundMessage(...args: Parameters<typeof webhook.isOutboundMessage>) { return webhook.isOutboundMessage(...args); }
export function extractDeliveryStatuses(...args: Parameters<typeof webhook.extractDeliveryStatuses>) { return webhook.extractDeliveryStatuses(...args); }
export function handleWebhook(...args: Parameters<typeof webhook.handleWebhook>) { return webhook.handleWebhook(...args); }
export function processWebhookMessage(...args: Parameters<typeof webhook.processWebhookMessage>) { return webhook.processWebhookMessage(...args); }


