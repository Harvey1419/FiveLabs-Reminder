import { assertTurnLease, checkpointTurnResponse, currentTurnSignal } from '../../agent/core/turn-lease.js';
import { markAsProcessed } from '../../http/webhooks/whatsapp.js';
import { supabase } from '../../infrastructure/database/index.js';
import { userCache } from '../../infrastructure/database/users.js';

import { createKapsoClient } from './kapso-client-core.js';
export { KapsoError, KapsoConfigurationError, KapsoAuthError, KapsoSandboxError, KapsoRateLimitError, KapsoValidationError } from './kapso-errors.js';
const client = createKapsoClient({
  assertTurnLease: ((...args: Parameters<typeof assertTurnLease>) => assertTurnLease(...args)) as unknown as Parameters<typeof createKapsoClient>[0]['assertTurnLease'], checkpointTurnResponse: ((...args: Parameters<typeof checkpointTurnResponse>) => checkpointTurnResponse(...args)) as unknown as Parameters<typeof createKapsoClient>[0]['checkpointTurnResponse'], currentTurnSignal: ((...args: Parameters<typeof currentTurnSignal>) => currentTurnSignal(...args)) as unknown as Parameters<typeof createKapsoClient>[0]['currentTurnSignal'],
  markAsProcessed: ((...args: Parameters<typeof markAsProcessed>) => markAsProcessed(...args)) as unknown as Parameters<typeof createKapsoClient>[0]['markAsProcessed'], fetch: ((...args: Parameters<typeof fetch>) => fetch(...args)) as unknown as Parameters<typeof createKapsoClient>[0]['fetch'],
  supabase: { from: ((...args: Parameters<typeof supabase.from>) => supabase.from(...args)) as unknown as Parameters<typeof createKapsoClient>[0]['supabase']['from']}, userCache: { get: ((...args: Parameters<typeof userCache.get>) => userCache.get(...args)) as unknown as Parameters<typeof createKapsoClient>[0]['userCache']['get']},
  getEnv: () => process.env, getNowMs: () => Date.now(), logger: console,
  sleep: milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)),
});
export function normalizePhoneNumber(...args: Parameters<typeof client.normalizePhoneNumber>) { return client.normalizePhoneNumber(...args); }
export function sendWhatsAppText(...args: Parameters<typeof client.sendWhatsAppText>) { return client.sendWhatsAppText(...args); }
export function sendWhatsAppCtaUrl(...args: Parameters<typeof client.sendWhatsAppCtaUrl>) { return client.sendWhatsAppCtaUrl(...args); }
export function sendWhatsAppFlow(...args: Parameters<typeof client.sendWhatsAppFlow>) { return client.sendWhatsAppFlow(...args); }
export function sendWhatsAppQuickReplyButtons(...args: Parameters<typeof client.sendWhatsAppQuickReplyButtons>) { return client.sendWhatsAppQuickReplyButtons(...args); }
export function sendWhatsAppListMessage(...args: Parameters<typeof client.sendWhatsAppListMessage>) { return client.sendWhatsAppListMessage(...args); }
export function sendReminderConfirmation(...args: Parameters<typeof client.sendReminderConfirmation>) { return client.sendReminderConfirmation(...args); }
export function stripReminderPrefix(...args: Parameters<typeof client.stripReminderPrefix>) { return client.stripReminderPrefix(...args); }
export function isWithin24HourWindow(...args: Parameters<typeof client.isWithin24HourWindow>) { return client.isWithin24HourWindow(...args); }
export function sendWhatsAppTemplate(...args: Parameters<typeof client.sendWhatsAppTemplate>) { return client.sendWhatsAppTemplate(...args); }
export function sendReminderMessage(...args: Parameters<typeof client.sendReminderMessage>) { return client.sendReminderMessage(...args); }
export function sendTypingIndicator(...args: Parameters<typeof client.sendTypingIndicator>) { return client.sendTypingIndicator(...args); }
export function downloadMedia(...args: Parameters<typeof client.downloadMedia>) { return client.downloadMedia(...args); }


