import { supabase, getUserIntegration } from '../../infrastructure/database/index.js';
import { hasUsableGoogleCredentials, isGoogleAuthError } from '../../integrations/google/auth.js';
import { resolveCalendarTemporalScope, formatLocalDateTime } from '../../shared/time.js';
import { normalizeAgendaScope, isAllPendingScope } from '../../shared/agenda-scopes.js';
import { listCalendarEvents, normalizeCalendarEvent } from '../../integrations/google/calendar.js';
import { createAgendaReadService } from './agenda-read-service.js';
const service = createAgendaReadService({
  supabase: { from: ((...args: Parameters<typeof supabase.from>) => supabase.from(...args)) as unknown as Parameters<typeof createAgendaReadService>[0]['supabase']['from']},
  getUserIntegration: ((...args: Parameters<typeof getUserIntegration>) => getUserIntegration(...args)) as unknown as Parameters<typeof createAgendaReadService>[0]['getUserIntegration'],
  hasUsableGoogleCredentials: ((...args: Parameters<typeof hasUsableGoogleCredentials>) => hasUsableGoogleCredentials(...args)) as unknown as Parameters<typeof createAgendaReadService>[0]['hasUsableGoogleCredentials'],
  isGoogleAuthError: ((...args: Parameters<typeof isGoogleAuthError>) => isGoogleAuthError(...args)) as unknown as Parameters<typeof createAgendaReadService>[0]['isGoogleAuthError'],
  resolveCalendarTemporalScope: ((...args: Parameters<typeof resolveCalendarTemporalScope>) => resolveCalendarTemporalScope(...args)) as unknown as Parameters<typeof createAgendaReadService>[0]['resolveCalendarTemporalScope'],
  formatLocalDateTime: ((...args: Parameters<typeof formatLocalDateTime>) => formatLocalDateTime(...args)) as unknown as Parameters<typeof createAgendaReadService>[0]['formatLocalDateTime'],
  normalizeAgendaScope: ((...args: Parameters<typeof normalizeAgendaScope>) => normalizeAgendaScope(...args)) as unknown as Parameters<typeof createAgendaReadService>[0]['normalizeAgendaScope'],
  isAllPendingScope: ((...args: Parameters<typeof isAllPendingScope>) => isAllPendingScope(...args)) as unknown as Parameters<typeof createAgendaReadService>[0]['isAllPendingScope'],
  listCalendarEvents: ((...args: Parameters<typeof listCalendarEvents>) => listCalendarEvents(...args)) as unknown as Parameters<typeof createAgendaReadService>[0]['listCalendarEvents'],
  normalizeCalendarEvent: ((...args: Parameters<typeof normalizeCalendarEvent>) => normalizeCalendarEvent(...args)) as unknown as Parameters<typeof createAgendaReadService>[0]['normalizeCalendarEvent'],
  logger: console, getNow: () => new Date()});
export function getUnifiedAgenda(...args: Parameters<typeof service.getUnifiedAgenda>) { return service.getUnifiedAgenda(...args); }


