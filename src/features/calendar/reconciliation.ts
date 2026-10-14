import {
  supabase,
  saveReminder,
  updateReminder,
  getUserIntegration,
  saveMessage,
} from '../../infrastructure/database/index.js';
import { getReminderConfirmationPreference } from '../../infrastructure/database/memories.js';
import { hasUsableGoogleCredentials } from '../../integrations/google/auth.js';
import { listCalendarEvents, normalizeCalendarEvent } from '../../integrations/google/calendar.js';
import { sendWhatsAppText } from '../../integrations/whatsapp/kapso-client.js';
import { formatHumanFriendlyDateTime } from '../../shared/time.js';
import { createCalendarReconciliation } from './calendar-reconciliation.js';
const service = createCalendarReconciliation({
  supabase: { from: ((...args: Parameters<typeof supabase.from>) => supabase.from(...args)) as unknown as Parameters<typeof createCalendarReconciliation>[0]['supabase']['from']},
  saveReminder: ((...args: Parameters<typeof saveReminder>) => saveReminder(...args)) as unknown as Parameters<typeof createCalendarReconciliation>[0]['saveReminder'],
  updateReminder: ((...args: Parameters<typeof updateReminder>) => updateReminder(...args)) as unknown as Parameters<typeof createCalendarReconciliation>[0]['updateReminder'],
  getUserIntegration: ((...args: Parameters<typeof getUserIntegration>) => getUserIntegration(...args)) as unknown as Parameters<typeof createCalendarReconciliation>[0]['getUserIntegration'],
  saveMessage: ((...args: Parameters<typeof saveMessage>) => saveMessage(...args)) as unknown as Parameters<typeof createCalendarReconciliation>[0]['saveMessage'],
  getReminderConfirmationPreference: ((...args: Parameters<typeof getReminderConfirmationPreference>) => getReminderConfirmationPreference(...args)) as unknown as Parameters<typeof createCalendarReconciliation>[0]['getReminderConfirmationPreference'],
  hasUsableGoogleCredentials: ((...args: Parameters<typeof hasUsableGoogleCredentials>) => hasUsableGoogleCredentials(...args)) as unknown as Parameters<typeof createCalendarReconciliation>[0]['hasUsableGoogleCredentials'],
  listCalendarEvents: ((...args: Parameters<typeof listCalendarEvents>) => listCalendarEvents(...args)) as unknown as Parameters<typeof createCalendarReconciliation>[0]['listCalendarEvents'],
  normalizeCalendarEvent: ((...args: Parameters<typeof normalizeCalendarEvent>) => normalizeCalendarEvent(...args)) as unknown as Parameters<typeof createCalendarReconciliation>[0]['normalizeCalendarEvent'],
  sendWhatsAppText: ((...args: Parameters<typeof sendWhatsAppText>) => sendWhatsAppText(...args)) as unknown as Parameters<typeof createCalendarReconciliation>[0]['sendWhatsAppText'],
  formatHumanFriendlyDateTime: ((...args: Parameters<typeof formatHumanFriendlyDateTime>) => formatHumanFriendlyDateTime(...args)) as unknown as Parameters<typeof createCalendarReconciliation>[0]['formatHumanFriendlyDateTime'],
  logger: console, getNow: () => new Date(), getNowMs: () => Date.now()});
export function reconcileCalendarCompanionReminders(...args: Parameters<typeof service.reconcileCalendarCompanionReminders>) { return service.reconcileCalendarCompanionReminders(...args); }


