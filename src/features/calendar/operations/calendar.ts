import {
  getUserIntegration,
  saveReminder,
  cancelCalendarCompanionReminders,
  rescheduleCalendarCompanionReminders,
} from '../../../infrastructure/database/index.js';
import {
  getGoogleConnectUrl,
  revokeGoogleIntegration,
  hasUsableGoogleCredentials,
  isGoogleAuthError,
} from '../../../integrations/google/auth.js';
import {
  listCalendarEvents,
  createCalendarEvent,
  updateCalendarEvent,
  deleteCalendarEvent,
} from '../../../integrations/google/calendar.js';
import {
  parseTargetTime,
  getDayBounds,
  resolveCalendarTemporalScope,
  formatLocalDateTime,
  formatHumanFriendlyDateTime,
  formatHumanFriendlyDate,
  zonedTimeToUtc,
  DEFAULT_TIMEZONE,
} from '../../../shared/time.js';
import { formatRecurrenceLabel } from '../../../shared/reminder-presentation.js';
import {
  parseStructuredOrdinal,
  resolveContextReference,
} from '../../../agent/core/context-reference.js';
import { getWorkingMemory } from '../../../agent/core/working-memory-store.js';
import { createCalendarTool } from './calendar-tool.js';
const tool = createCalendarTool({
  getUserIntegration: ((...args: Parameters<typeof getUserIntegration>) => getUserIntegration(...args)) as unknown as Parameters<typeof createCalendarTool>[0]['getUserIntegration'],
  saveReminder: ((...args: Parameters<typeof saveReminder>) => saveReminder(...args)) as unknown as Parameters<typeof createCalendarTool>[0]['saveReminder'],
  cancelCalendarCompanionReminders: ((...args: Parameters<typeof cancelCalendarCompanionReminders>) => cancelCalendarCompanionReminders(...args)) as unknown as Parameters<typeof createCalendarTool>[0]['cancelCalendarCompanionReminders'],
  rescheduleCalendarCompanionReminders: ((...args: Parameters<typeof rescheduleCalendarCompanionReminders>) => rescheduleCalendarCompanionReminders(...args)) as unknown as Parameters<typeof createCalendarTool>[0]['rescheduleCalendarCompanionReminders'],
  getGoogleConnectUrl: ((...args: Parameters<typeof getGoogleConnectUrl>) => getGoogleConnectUrl(...args)) as unknown as Parameters<typeof createCalendarTool>[0]['getGoogleConnectUrl'],
  revokeGoogleIntegration: ((...args: Parameters<typeof revokeGoogleIntegration>) => revokeGoogleIntegration(...args)) as unknown as Parameters<typeof createCalendarTool>[0]['revokeGoogleIntegration'],
  hasUsableGoogleCredentials: ((...args: Parameters<typeof hasUsableGoogleCredentials>) => hasUsableGoogleCredentials(...args)) as unknown as Parameters<typeof createCalendarTool>[0]['hasUsableGoogleCredentials'],
  isGoogleAuthError: ((...args: Parameters<typeof isGoogleAuthError>) => isGoogleAuthError(...args)) as unknown as Parameters<typeof createCalendarTool>[0]['isGoogleAuthError'],
  listCalendarEvents: ((...args: Parameters<typeof listCalendarEvents>) => listCalendarEvents(...args)) as unknown as Parameters<typeof createCalendarTool>[0]['listCalendarEvents'],
  createCalendarEvent: ((...args: Parameters<typeof createCalendarEvent>) => createCalendarEvent(...args)) as unknown as Parameters<typeof createCalendarTool>[0]['createCalendarEvent'],
  updateCalendarEvent: ((...args: Parameters<typeof updateCalendarEvent>) => updateCalendarEvent(...args)) as unknown as Parameters<typeof createCalendarTool>[0]['updateCalendarEvent'],
  deleteCalendarEvent: ((...args: Parameters<typeof deleteCalendarEvent>) => deleteCalendarEvent(...args)) as unknown as Parameters<typeof createCalendarTool>[0]['deleteCalendarEvent'],
  parseTargetTime: ((...args: Parameters<typeof parseTargetTime>) => parseTargetTime(...args)) as unknown as Parameters<typeof createCalendarTool>[0]['parseTargetTime'],
  getDayBounds: ((...args: Parameters<typeof getDayBounds>) => getDayBounds(...args)) as unknown as Parameters<typeof createCalendarTool>[0]['getDayBounds'],
  resolveCalendarTemporalScope: ((...args: Parameters<typeof resolveCalendarTemporalScope>) => resolveCalendarTemporalScope(...args)) as unknown as Parameters<typeof createCalendarTool>[0]['resolveCalendarTemporalScope'],
  formatLocalDateTime: ((...args: Parameters<typeof formatLocalDateTime>) => formatLocalDateTime(...args)) as unknown as Parameters<typeof createCalendarTool>[0]['formatLocalDateTime'],
  formatHumanFriendlyDateTime: ((...args: Parameters<typeof formatHumanFriendlyDateTime>) => formatHumanFriendlyDateTime(...args)) as unknown as Parameters<typeof createCalendarTool>[0]['formatHumanFriendlyDateTime'],
  formatHumanFriendlyDate: ((...args: Parameters<typeof formatHumanFriendlyDate>) => formatHumanFriendlyDate(...args)) as unknown as Parameters<typeof createCalendarTool>[0]['formatHumanFriendlyDate'],
  zonedTimeToUtc: ((...args: Parameters<typeof zonedTimeToUtc>) => zonedTimeToUtc(...args)) as unknown as Parameters<typeof createCalendarTool>[0]['zonedTimeToUtc'],
  DEFAULT_TIMEZONE: DEFAULT_TIMEZONE as unknown as Parameters<typeof createCalendarTool>[0]['DEFAULT_TIMEZONE'],
  formatRecurrenceLabel: ((...args: Parameters<typeof formatRecurrenceLabel>) => formatRecurrenceLabel(...args)) as unknown as Parameters<typeof createCalendarTool>[0]['formatRecurrenceLabel'],
  parseStructuredOrdinal: ((...args: Parameters<typeof parseStructuredOrdinal>) => parseStructuredOrdinal(...args)) as unknown as Parameters<typeof createCalendarTool>[0]['parseStructuredOrdinal'],
  resolveContextReference: ((...args: Parameters<typeof resolveContextReference>) => resolveContextReference(...args)) as unknown as Parameters<typeof createCalendarTool>[0]['resolveContextReference'],
  getWorkingMemory: ((...args: Parameters<typeof getWorkingMemory>) => getWorkingMemory(...args)) as unknown as Parameters<typeof createCalendarTool>[0]['getWorkingMemory'],
  getNow: () => new Date(), getNowMs: () => Date.now(), logger: console,
});
export function normalizeCalendarEvent(...args: Parameters<typeof tool.normalizeCalendarEvent>) { return tool.normalizeCalendarEvent(...args); }
export function formatCalendarEventLine(...args: Parameters<typeof tool.formatCalendarEventLine>) { return tool.formatCalendarEventLine(...args); }
export function sanitizeCalendarQueryAndScope(...args: Parameters<typeof tool.sanitizeCalendarQueryAndScope>) { return tool.sanitizeCalendarQueryAndScope(...args); }
export function executeCalendarTool(...args: Parameters<typeof tool.executeCalendarTool>) { return tool.executeCalendarTool(...args); }
