import { describe, expect, it, vi } from 'vitest';
import { datedCalendarRenameMessage } from '../../fixtures/agent/behavioral-calendar-lookup-fixture.js';
import { behavioralStructuredMessage } from '../../fixtures/agent/behavioral-read-fixtures.js';
import { getStructuredTurnSchema } from '../../../src/agent/contracts/foreground-turn-schema.js';
import { matchesSchema } from '../../../src/agent/contracts/schema-value-contract.js';
import { validateForegroundContent } from '../../../src/agent/contracts/foreground-turn-validator.js';
import { buildDomainCall } from '../../../src/agent/orchestration/domain-call.js';
import { createCalendarTool, type CalendarEventRow } from '../../../src/agent/tools/calendar-tool.js';
import * as time from '../../../src/shared/time.js';
import { formatRecurrenceLabel } from '../../../src/shared/reminder-presentation.js';
import { parseStructuredOrdinal, resolveContextReference } from '../../../src/agent/core/context-reference.js';
const user = { id: 'dated-calendar-owner', phone_number: '573990001122', timezone: 'America/Bogota' };
const referenceTime = new Date('2026-09-02T17:00:00Z');

function call() {
  const message = datedCalendarRenameMessage();
  expect(matchesSchema(JSON.parse(message.content), getStructuredTurnSchema() as Parameters<typeof matchesSchema>[1])).toBe(true);
  const validation = validateForegroundContent(message.content);
  if (!validation.valid) throw new Error(validation.error);
  const result = buildDomainCall(validation.intent.actions[0], { user, timezone: user.timezone, language: 'es', referenceTime });
  if (!result.valid || !('toolName' in result)) throw new Error('Expected Calendar update call');
  return result;
}
function calendarFixture() {
  const saveCompanion = vi.fn(async () => ({ id: 'gcal-companion' }));
  const createCalendarEvent = vi.fn(async () => ({ id: 'gcal-event-12345', summary: 'Reunión de trabajo' }));
  const deps = {
    getUserIntegration: vi.fn(async () => ({ account_email: 'fixture@example.test' })),
    hasUsableGoogleCredentials: () => true, isGoogleAuthError: () => false,
    saveReminder: saveCompanion,
    cancelCalendarCompanionReminders: vi.fn(async () => ({ cancelled: 0 })),
    rescheduleCalendarCompanionReminders: vi.fn(async () => ({ rescheduled: 0 })),
    getGoogleConnectUrl: () => 'https://example.test/google', revokeGoogleIntegration: vi.fn(async () => null),
    listCalendarEvents: vi.fn(async (): Promise<CalendarEventRow[]> => [{ id: 'sept-9', summary: 'Cita previa con proveedor', start: '2026-09-09T10:00:00-05:00', end: '2026-09-09T11:00:00-05:00' }]), createCalendarEvent,
    updateCalendarEvent: vi.fn(async () => ({ id: 'updated' })), deleteCalendarEvent: vi.fn(async () => null),
    parseTargetTime: time.parseTargetTime, getDayBounds: time.getDayBounds,
    resolveCalendarTemporalScope: time.resolveCalendarTemporalScope, formatLocalDateTime: time.formatLocalDateTime,
    formatHumanFriendlyDateTime: time.formatHumanFriendlyDateTime, formatHumanFriendlyDate: time.formatHumanFriendlyDate,
    zonedTimeToUtc: time.zonedTimeToUtc, DEFAULT_TIMEZONE: 'America/Bogota', formatRecurrenceLabel,
    parseStructuredOrdinal, resolveContextReference, getWorkingMemory: () => ({ items: [{ position: 1, type: 'calendar_event', internalId: 'old-sept-3', summary: 'Cita anterior', time: '2026-09-03T14:00:00Z' }] }),
    getNow: () => referenceTime, getNowMs: () => referenceTime.getTime(), logger: console,
  };
  return { ...createCalendarTool(deps), ...deps };
}


describe('dated Calendar mutation lookup', () => {
  it('preserves strict wire shape and separates lookup date from patch schedule', () => {
    const result = call();
    expect(result).toMatchObject({ toolName: 'manage_google_calendar', params: { action: 'update_event', lookupDate: '2026-09-09', target: 'cita' } });
    expect(result.params).not.toHaveProperty('startDateTime');
    expect(result.params).not.toHaveProperty('allDay');
    expect(getStructuredTurnSchema().properties!.actions!.items!.properties!.scope!.description).toContain('scope=YYYY-MM-DD');
  });

  it('renames the dated event with exact local bounds and ignores stale working memory', async () => {
    const f = calendarFixture();
    const result = await f.executeCalendarTool({ action: 'update_event', params: call().params, user, referenceTime });
    expect(result.success).toBe(true);
    expect(f.listCalendarEvents).toHaveBeenCalledExactlyOnceWith(user.id, expect.objectContaining({
      timeMin: new Date('2026-09-09T05:00:00Z'), timeMax: new Date('2026-09-10T05:00:00Z'), q: 'cita', timezone: user.timezone,
    }));
    expect(f.updateCalendarEvent).toHaveBeenCalledExactlyOnceWith(user.id, expect.objectContaining({
      eventId: 'sept-9', summary: 'Reunión en Ceramica italia de barranquilla', startDateTime: undefined, endDateTime: undefined, allDay: false,
    }));
    expect(f.rescheduleCalendarCompanionReminders).not.toHaveBeenCalled();
  });

  it.each(['2026-02-30', '2025-02-29', 'tomorrow', '2026-9-9', ' 2026-09-09'])('rejects invalid lookup %s in foreground and direct tool without broad search', async scope => {
    const message = behavioralStructuredMessage([{ operation: 'calendar.update', scope, target: 'cita', title: 'Nuevo título' }]);
    expect(validateForegroundContent(message.content).valid).toBe(false);
    const f = calendarFixture();
    const result = await f.executeCalendarTool({ action: 'update_event', params: { target: 'cita', summary: 'Nuevo título', lookupDate: scope }, user });
    expect(result).toMatchObject({ success: false, errorCode: 'INVALID_CALENDAR_LOOKUP_DATE' });
    expect(f.listCalendarEvents).not.toHaveBeenCalled();
    expect(f.updateCalendarEvent).not.toHaveBeenCalled();
    expect(f.createCalendarEvent).not.toHaveBeenCalled();
  });

  it('rejects conflicting dated lookup and displayed position', () => {
    const message = behavioralStructuredMessage([{ operation: 'calendar.update', scope: '2026-09-09', contextRef: { source: 'working_memory', position: 1 }, title: 'Nuevo título' }]);
    expect(validateForegroundContent(message.content)).toMatchObject({ valid: false, errorCode: 'INVALID_CALENDAR_LOOKUP_DATE' });
  });

  it.each(['empty', 'failure', 'outside', 'ambiguous'] as const)('does not mutate or fall back to old memory after %s dated query', async mode => {
    const f = calendarFixture();
    if (mode === 'failure') f.listCalendarEvents.mockRejectedValueOnce(new Error('Google unavailable'));
    else f.listCalendarEvents.mockResolvedValueOnce(mode === 'empty' ? [] : mode === 'outside'
      ? [{ id: 'old-sept-3', summary: 'Cita anterior', start: '2026-09-03T14:00:00Z' }]
      : [{ id: 'a', summary: 'Cita proveedor A', start: '2026-09-09T14:00:00Z' }, { id: 'b', summary: 'Cita proveedor B', start: '2026-09-09T15:00:00Z' }]);
    const result = await f.executeCalendarTool({ action: 'update_event', params: call().params, user, referenceTime });
    expect(result.success).toBe(false);
    expect(result.errorCode).toBe(mode === 'failure' ? 'SERVICE_UNAVAILABLE' : mode === 'ambiguous' ? 'AMBIGUOUS_TARGET' : 'NOT_FOUND');
    expect(f.updateCalendarEvent).not.toHaveBeenCalled();
    expect(f.createCalendarEvent).not.toHaveBeenCalled();
  });

  it('locates an all-day civil event without introducing a schedule patch', async () => {
    const f = calendarFixture();
    f.listCalendarEvents.mockResolvedValueOnce([{ id: 'civil', summary: 'Cita de día completo', start: '2026-09-09', end: '2026-09-10' }]);
    const result = await f.executeCalendarTool({ action: 'update_event', params: call().params, user, referenceTime });
    expect(result.success).toBe(true);
    expect(f.updateCalendarEvent).toHaveBeenCalledWith(user.id, expect.objectContaining({ eventId: 'civil', startDateTime: undefined, endDateTime: undefined, startDate: null, endDate: null }));
    expect(f.rescheduleCalendarCompanionReminders).not.toHaveBeenCalled();
  });

  it('uses a 23-hour DST civil day and keeps explicit rescheduling separate from lookup', async () => {
    const f = calendarFixture();
    f.listCalendarEvents.mockResolvedValueOnce([{ id: 'dst', summary: 'Cita DST', start: '2027-03-14T10:00:00-07:00' }]);
    const result = await f.executeCalendarTool({ action: 'update_event', params: { ...call().params, lookupDate: '2027-03-14', startDateTime: '2027-03-15T17:00:00Z' }, user: { ...user, timezone: 'America/Los_Angeles' }, referenceTime });
    expect(result.success).toBe(true);
    expect(f.listCalendarEvents).toHaveBeenCalledWith(user.id, expect.objectContaining({ timeMin: new Date('2027-03-14T08:00:00Z'), timeMax: new Date('2027-03-15T07:00:00Z') }));
    expect(f.updateCalendarEvent).toHaveBeenCalledWith(user.id, expect.objectContaining({ eventId: 'dst', startDateTime: new Date('2027-03-15T17:00:00Z') }));
  });
});
