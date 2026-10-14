import { describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import crypto from 'node:crypto';
import { createCalendarApi, type Dependencies } from '../../../src/integrations/google/calendar-api.js';
import type { CalendarApi, GoogleEvent } from '../../../src/integrations/google/calendar-api-ports.js';
import * as time from '../../../src/shared/time.js';
const google = (createRequire(import.meta.url)('googleapis') as { google: { calendar(input: { version: 'v3'; auth: unknown }): CalendarApi } }).google;
interface Request { method: string; url: string; params?: Record<string, unknown>; data?: GoogleEvent | Record<string, unknown> }
const event: GoogleEvent = { id: 'event1', summary: 'Appointment', start: { dateTime: '2099-10-13T17:00:00Z' }, end: { dateTime: '2099-10-13T18:30:00Z' }, htmlLink: 'https://calendar.test/event', privateField: 'retained' };
function fixture(respond: (request: Request, count: number) => unknown = () => ({ data: event }), overrides: Partial<Dependencies> = {}) {
 const requests: Request[] = [];
 const auth = { request: async (request: Request) => { requests.push(request); return respond(request, requests.length); } };
 const clear = vi.fn(async () => true); const metadata = vi.fn(async () => null);
 const service = createCalendarApi({ ...time, crypto, logger: { log: vi.fn(), warn: vi.fn(), error: vi.fn() },
  getCalendar: credentials => google.calendar({ version: 'v3', auth: credentials }), getEnv: () => ({ APP_BASE_URL: 'https://app.test/' }),
  getAuthenticatedGoogleClient: async () => auth, isGoogleAuthError: error => (error as { code?: unknown }).code === 401,
  clearInvalidGoogleIntegration: clear, getUserIntegration: async () => null, updateUserIntegrationMetadata: metadata, ...overrides });
 return { service, requests, clear, metadata };
}
describe('typed Google Calendar provider boundary with installed SDK', () => {
 it('keeps civil all-day dates independent of UTC shifts and stable IDs', () => {
  const { service } = fixture();
  const normalized = service.normalizeCalendarEvent({ id: 'civil', start: { date: '2099-10-13' } }, 'America/Bogota');
  expect(normalized).toMatchObject({ type: 'all_day', localDate: '2099-10-13', formattedDate: '13/10/2099' });
  expect(service.generateDeterministicCalendarEventId('owner', ' Appointment ', 'date')).toBe(service.generateDeterministicCalendarEventId('owner', 'appointment', 'date'));
 });
 it('caps and serializes list parameters and excludes cancelled events', async () => {
  const { service, requests } = fixture(() => ({ data: { items: [event, { ...event, id: 'cancelled', status: 'cancelled' }] } }));
  const result = await service.listCalendarEvents('owner', { timeMin: new Date('2099-10-13T00:00:00Z'), maxResults: 100, q: ' Appointment ' });
  expect(result).toHaveLength(1); expect(requests[0]!.params).toMatchObject({ maxResults: 50, q: 'Appointment', timeMin: '2099-10-13T00:00:00.000Z' });
 });
 it('rejects missing authentication before issuing provider requests', async () => {
  const { service, requests } = fixture(undefined, { getAuthenticatedGoogleClient: async () => null });
  await expect(service.createCalendarEvent('owner', { summary: 'Appointment', startDate: '2099-10-13' })).rejects.toMatchObject({ code: 'GOOGLE_AUTH_REQUIRED' });
  expect(requests).toHaveLength(0); expect(await service.deleteCalendarEvent('owner', 'event')).toBe(false);
 });
 it('retrieves a deterministic event after 409 without repeating insert', async () => {
  const { service, requests } = fixture((_req, count) => { if (count === 1) throw Object.assign(new Error('conflict'), { code: 409 }); return { data: event }; });
  expect(await service.createCalendarEvent('owner', { summary: 'Appointment', customEventId: 'stableid', startDateTime: '2099-10-13T17:00:00Z' })).toMatchObject({ id: event.id });
  expect(requests.map(r => r.method)).toEqual(['POST', 'GET']); expect(requests[1]!.url).toContain('/events/stableid');
 });
 it('preserves fetched duration and provider fields when moving a timed event', async () => {
  const { service, requests } = fixture(request => ({ data: request.method === 'PUT' ? request.data : event }));
  await service.updateCalendarEvent('owner', { eventId: 'event1', startDateTime: '2099-10-14T17:00:00Z' });
  expect(requests[1]!.data).toMatchObject({ privateField: 'retained', start: { dateTime: '2099-10-14T17:00:00.000Z' }, end: { dateTime: '2099-10-14T18:30:00.000Z' } });
 });
 it('rejects incompatible patches after reading and before mutation', async () => {
  const { service, requests } = fixture();
  await expect(service.updateCalendarEvent('owner', { eventId: 'event1', allDay: true })).rejects.toMatchObject({ code: 'INCOMPATIBLE_CALENDAR_PATCH' });
  expect(requests.map(r => r.method)).toEqual(['GET']);
 });
 it('clears invalid credentials and propagates provider list failures', async () => {
  const { service, clear } = fixture(() => { throw Object.assign(new Error('expired'), { code: 401 }); });
  await expect(service.listCalendarEvents('owner')).rejects.toMatchObject({ code: 401 }); expect(clear).toHaveBeenCalledWith('owner', 'calendar-list');
 });
 it('recovers 410 through paginated full sync without incompatible bounded parameters', async () => {
  const { service, requests } = fixture((_r, count) => {
   if (count === 1) throw Object.assign(new Error('expired sync'), { code: 410 });
   return { data: count === 2 ? { items: [event], nextPageToken: 'page2' } : { items: [{ ...event, id: 'second' }], nextSyncToken: 'new-token' } };
  });
  const result = await service.listIncrementalCalendarEvents('owner', { syncToken: 'old-token', timeMin: '2099-10-13T00:00:00Z', timeMax: '2099-10-14T00:00:00Z' });
  expect(result).toMatchObject({ fullSync: true, nextSyncToken: 'new-token' }); expect(result!.items).toHaveLength(2);
  expect(requests[0]!.params).toMatchObject({ syncToken: 'old-token' }); expect(requests[1]!.params).not.toHaveProperty('syncToken'); expect(requests[1]!.params).not.toHaveProperty('timeMax'); expect(requests[1]!.params).not.toHaveProperty('orderBy'); expect(requests[2]!.params).toHaveProperty('pageToken', 'page2');
 });
 it('stops an obsolete watch without clearing current metadata', async () => {
  const { service, metadata, requests } = fixture(() => ({ data: {} }), { getUserIntegration: async () => ({ metadata: { channelId: 'current' } }) });
  expect(await service.stopGoogleCalendarWatch({ userId: 'owner', channelId: 'old', resourceId: 'resource' })).toBe(true);
  expect(requests[0]!.data).toEqual({ id: 'old', resourceId: 'resource' }); expect(metadata).not.toHaveBeenCalled();
 });
});
