import { supabase, getDailyOverview, getUserIntegration } from '../infrastructure/database/index.js';
import { sendReminderConfirmation, isWithin24HourWindow } from '../integrations/whatsapp/kapso-client.js';
import { hasUsableGoogleCredentials, isGoogleAuthError } from '../integrations/google/auth.js';
import { resolveCalendarTemporalScope } from '../shared/time.js';
import { listCalendarEvents, normalizeCalendarEvent } from '../integrations/google/calendar.js';
import { reconcileCalendarCompanionReminders } from '../features/calendar/reconciliation.js';
import { formatTaskNotesBadge } from '../shared/task-presentation.js';
import { saveWorkingMemory } from '../agent/core/working-memory.js';

import { createMorningBriefing } from './morning-briefing-core.js';

const worker = createMorningBriefing({
  supabase: { from: ((...args: Parameters<typeof supabase.from>) => supabase.from(...args)) as unknown as Parameters<typeof createMorningBriefing>[0]['supabase']['from']},
  getDailyOverview: ((...args: Parameters<typeof getDailyOverview>) => getDailyOverview(...args)) as unknown as Parameters<typeof createMorningBriefing>[0]['getDailyOverview'],
  getUserIntegration: ((...args: Parameters<typeof getUserIntegration>) => getUserIntegration(...args)) as unknown as Parameters<typeof createMorningBriefing>[0]['getUserIntegration'],
  sendReminderConfirmation: ((...args: Parameters<typeof sendReminderConfirmation>) => sendReminderConfirmation(...args)) as unknown as Parameters<typeof createMorningBriefing>[0]['sendReminderConfirmation'],
  isWithin24HourWindow: ((...args: Parameters<typeof isWithin24HourWindow>) => isWithin24HourWindow(...args)) as unknown as Parameters<typeof createMorningBriefing>[0]['isWithin24HourWindow'],
  hasUsableGoogleCredentials: ((...args: Parameters<typeof hasUsableGoogleCredentials>) => hasUsableGoogleCredentials(...args)) as unknown as Parameters<typeof createMorningBriefing>[0]['hasUsableGoogleCredentials'],
  isGoogleAuthError: ((...args: Parameters<typeof isGoogleAuthError>) => isGoogleAuthError(...args)) as unknown as Parameters<typeof createMorningBriefing>[0]['isGoogleAuthError'],
  resolveCalendarTemporalScope: ((...args: Parameters<typeof resolveCalendarTemporalScope>) => resolveCalendarTemporalScope(...args)) as unknown as Parameters<typeof createMorningBriefing>[0]['resolveCalendarTemporalScope'],
  listCalendarEvents: ((...args: Parameters<typeof listCalendarEvents>) => listCalendarEvents(...args)) as unknown as Parameters<typeof createMorningBriefing>[0]['listCalendarEvents'],
  normalizeCalendarEvent: ((...args: Parameters<typeof normalizeCalendarEvent>) => normalizeCalendarEvent(...args)) as unknown as Parameters<typeof createMorningBriefing>[0]['normalizeCalendarEvent'],
  reconcileCalendarCompanionReminders: ((...args: Parameters<typeof reconcileCalendarCompanionReminders>) => reconcileCalendarCompanionReminders(...args)) as unknown as Parameters<typeof createMorningBriefing>[0]['reconcileCalendarCompanionReminders'],
  formatTaskNotesBadge: ((...args: Parameters<typeof formatTaskNotesBadge>) => formatTaskNotesBadge(...args)) as unknown as Parameters<typeof createMorningBriefing>[0]['formatTaskNotesBadge'],
  saveWorkingMemory: ((...args: Parameters<typeof saveWorkingMemory>) => saveWorkingMemory(...args)) as unknown as Parameters<typeof createMorningBriefing>[0]['saveWorkingMemory'],
  getNow: () => new Date(), setInterval: ((...args: Parameters<typeof setInterval>) => setInterval(...args)) as unknown as Parameters<typeof createMorningBriefing>[0]['setInterval'], logger: console});
export function claimMorningBriefing(...args: Parameters<typeof worker.claimMorningBriefing>) { return worker.claimMorningBriefing(...args); }
export function startMorningBriefingWorker(...args: Parameters<typeof worker.startMorningBriefingWorker>) { return worker.startMorningBriefingWorker(...args); }
export function formatBriefingDate(...args: Parameters<typeof worker.formatBriefingDate>) { return worker.formatBriefingDate(...args); }
export function formatMorningBriefingMessage(...args: Parameters<typeof worker.formatMorningBriefingMessage>) { return worker.formatMorningBriefingMessage(...args); }
export function dispatchBriefingForUser(...args: Parameters<typeof worker.dispatchBriefingForUser>) { return worker.dispatchBriefingForUser(...args); }


