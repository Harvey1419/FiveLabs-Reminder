import crypto from 'node:crypto';
const googlePackage = 'googleapis';
const { google } = await import(googlePackage) as { google: { calendar(input: { version: 'v3'; auth: unknown }): import('./calendar-api-ports.js').CalendarApi } };
import {
  clearInvalidGoogleIntegration,
  isGoogleAuthError,
  getAuthenticatedGoogleClient,
} from './auth.js';
import {
  getUserIntegration,
  updateUserIntegrationMetadata,
} from '../../infrastructure/database/integrations.js';
import {
  formatLocalDateTime,
  formatHumanFriendlyDateTime,
  zonedTimeToUtc,
  DEFAULT_TIMEZONE,
} from '../../shared/time.js';
import { createCalendarApi } from './calendar-api.js';
const service = createCalendarApi({
  clearInvalidGoogleIntegration: ((...args: Parameters<typeof clearInvalidGoogleIntegration>) => clearInvalidGoogleIntegration(...args)) as unknown as Parameters<typeof createCalendarApi>[0]['clearInvalidGoogleIntegration'],
  isGoogleAuthError: ((...args: Parameters<typeof isGoogleAuthError>) => isGoogleAuthError(...args)) as unknown as Parameters<typeof createCalendarApi>[0]['isGoogleAuthError'],
  getAuthenticatedGoogleClient: ((...args: Parameters<typeof getAuthenticatedGoogleClient>) => getAuthenticatedGoogleClient(...args)) as unknown as Parameters<typeof createCalendarApi>[0]['getAuthenticatedGoogleClient'],
  getUserIntegration: ((...args: Parameters<typeof getUserIntegration>) => getUserIntegration(...args)) as unknown as Parameters<typeof createCalendarApi>[0]['getUserIntegration'],
  updateUserIntegrationMetadata: ((...args: Parameters<typeof updateUserIntegrationMetadata>) => updateUserIntegrationMetadata(...args)) as unknown as Parameters<typeof createCalendarApi>[0]['updateUserIntegrationMetadata'],
  formatLocalDateTime: ((...args: Parameters<typeof formatLocalDateTime>) => formatLocalDateTime(...args)) as unknown as Parameters<typeof createCalendarApi>[0]['formatLocalDateTime'],
  formatHumanFriendlyDateTime: ((...args: Parameters<typeof formatHumanFriendlyDateTime>) => formatHumanFriendlyDateTime(...args)) as unknown as Parameters<typeof createCalendarApi>[0]['formatHumanFriendlyDateTime'],
  zonedTimeToUtc: ((...args: Parameters<typeof zonedTimeToUtc>) => zonedTimeToUtc(...args)) as unknown as Parameters<typeof createCalendarApi>[0]['zonedTimeToUtc'],
  get DEFAULT_TIMEZONE(): Parameters<typeof createCalendarApi>[0]['DEFAULT_TIMEZONE'] { return DEFAULT_TIMEZONE as unknown as Parameters<typeof createCalendarApi>[0]['DEFAULT_TIMEZONE']; },
  crypto: { createHash: ((...args: Parameters<typeof crypto.createHash>) => crypto.createHash(...args)) as unknown as Parameters<typeof createCalendarApi>[0]['crypto']['createHash'], randomUUID: ((...args: Parameters<typeof crypto.randomUUID>) => crypto.randomUUID(...args)) as unknown as Parameters<typeof createCalendarApi>[0]['crypto']['randomUUID']},
  getCalendar: auth => google.calendar({ version: 'v3', auth }), getEnv: () => process.env,
  logger: console,
});
export function normalizeCalendarEvent(...args: Parameters<typeof service.normalizeCalendarEvent>) { return service.normalizeCalendarEvent(...args); }
export function generateDeterministicCalendarEventId(...args: Parameters<typeof service.generateDeterministicCalendarEventId>) { return service.generateDeterministicCalendarEventId(...args); }
export function listCalendarEvents(...args: Parameters<typeof service.listCalendarEvents>) { return service.listCalendarEvents(...args); }
export function mapToGoogleRRule(...args: Parameters<typeof service.mapToGoogleRRule>) { return service.mapToGoogleRRule(...args); }
export function createCalendarEvent(...args: Parameters<typeof service.createCalendarEvent>) { return service.createCalendarEvent(...args); }
export function updateCalendarEvent(...args: Parameters<typeof service.updateCalendarEvent>) { return service.updateCalendarEvent(...args); }
export function findConflictingEvents(...args: Parameters<typeof service.findConflictingEvents>) { return service.findConflictingEvents(...args); }
export function deleteCalendarEvent(...args: Parameters<typeof service.deleteCalendarEvent>) { return service.deleteCalendarEvent(...args); }
export function setupGoogleCalendarWatch(...args: Parameters<typeof service.setupGoogleCalendarWatch>) { return service.setupGoogleCalendarWatch(...args); }
export function stopGoogleCalendarWatch(...args: Parameters<typeof service.stopGoogleCalendarWatch>) { return service.stopGoogleCalendarWatch(...args); }
export function listIncrementalCalendarEvents(...args: Parameters<typeof service.listIncrementalCalendarEvents>) { return service.listIncrementalCalendarEvents(...args); }


