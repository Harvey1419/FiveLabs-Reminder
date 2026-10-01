import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockGet, mockUpdate } = vi.hoisted(() => ({ mockGet: vi.fn(), mockUpdate: vi.fn() }));

vi.mock('../../../src/integrations/google/auth.js', () => ({
  getAuthenticatedGoogleClient: vi.fn(async () => ({})),
  isGoogleAuthError: vi.fn(() => false),
  clearInvalidGoogleIntegration: vi.fn(),
}));

vi.mock('googleapis', () => ({
  google: {
    calendar: vi.fn(() => ({ events: { get: mockGet, update: mockUpdate } })),
  },
}));

const { updateCalendarEvent } = await import('../../../src/integrations/google/calendar.js');

describe('Google Calendar update patch semantics', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGet.mockResolvedValue({ data: {
      id: 'event-1', summary: 'Planning',
      start: { dateTime: '2026-10-01T14:00:00.000Z', timeZone: 'UTC' },
      end: { dateTime: '2026-10-01T16:00:00.000Z', timeZone: 'UTC' },
      recurrence: ['RRULE:FREQ=DAILY'],
    } });
    mockUpdate.mockImplementation(async ({ requestBody }) => ({ data: { ...requestBody, id: 'event-1' } }));
  });

  it('retains the original event duration when moving only the start', async () => {
    await updateCalendarEvent('user-1', { eventId: 'event-1', startDateTime: '2026-10-01T15:00:00.000Z' });
    expect(mockUpdate.mock.calls[0][0].requestBody.end.dateTime).toBe('2026-10-01T17:00:00.000Z');
  });

  it('updates an end-only patch without changing the fetched start', async () => {
    await updateCalendarEvent('user-1', { eventId: 'event-1', endDateTime: '2026-10-01T17:30:00.000Z' });
    expect(mockUpdate.mock.calls[0][0].requestBody.start.dateTime).toBe('2026-10-01T14:00:00.000Z');
    expect(mockUpdate.mock.calls[0][0].requestBody.end.dateTime).toBe('2026-10-01T17:30:00.000Z');
  });

  it('recalculates end from the fetched start for an explicit duration', async () => {
    await updateCalendarEvent('user-1', { eventId: 'event-1', durationMinutes: 90 });
    expect(mockUpdate.mock.calls[0][0].requestBody.end.dateTime).toBe('2026-10-01T15:30:00.000Z');
  });

  it('clears recurrence by removing it from the full replacement resource', async () => {
    await updateCalendarEvent('user-1', { eventId: 'event-1', clearRecurrence: true });
    expect(mockUpdate.mock.calls[0][0].requestBody).not.toHaveProperty('recurrence');
  });

  it('rejects duration changes for all-day events before issuing an update', async () => {
    mockGet.mockResolvedValueOnce({ data: {
      id: 'event-1', summary: 'Holiday', start: { date: '2026-10-01' }, end: { date: '2026-10-02' },
    } });
    await expect(updateCalendarEvent('user-1', { eventId: 'event-1', durationMinutes: 90 }))
      .rejects.toMatchObject({ code: 'UNSUPPORTED_CALENDAR_DURATION' });
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it('rejects an all-day end-only patch on a timed event before issuing an update', async () => {
    await expect(updateCalendarEvent('user-1', { eventId: 'event-1', endDate: '2026-10-02' }))
      .rejects.toMatchObject({ code: 'INCOMPATIBLE_CALENDAR_PATCH' });
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it('preserves the fetched start date for a valid all-day end-only patch', async () => {
    mockGet.mockResolvedValueOnce({ data: {
      id: 'event-1', summary: 'Holiday', start: { date: '2026-10-01' }, end: { date: '2026-10-02' },
    } });
    await updateCalendarEvent('user-1', { eventId: 'event-1', endDate: '2026-10-03' });
    expect(mockUpdate.mock.calls[0][0].requestBody.start).toEqual({ date: '2026-10-01' });
    expect(mockUpdate.mock.calls[0][0].requestBody.end).toEqual({ date: '2026-10-03' });
  });

  it('rejects non-positive all-day intervals before issuing an update', async () => {
    mockGet.mockResolvedValueOnce({ data: {
      id: 'event-1', summary: 'Holiday', start: { date: '2026-10-01' }, end: { date: '2026-10-02' },
    } });
    await expect(updateCalendarEvent('user-1', { eventId: 'event-1', endDate: '2026-10-01' }))
      .rejects.toMatchObject({ code: 'INVALID_CALENDAR_INTERVAL' });
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it('rejects invalid all-day dates before issuing an update', async () => {
    mockGet.mockResolvedValueOnce({ data: {
      id: 'event-1', summary: 'Holiday', start: { date: '2026-10-01' }, end: { date: '2026-10-02' },
    } });
    await expect(updateCalendarEvent('user-1', { eventId: 'event-1', endDate: '2026-02-30' }))
      .rejects.toMatchObject({ code: 'INVALID_CALENDAR_INTERVAL' });
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it('rejects a timed end that is not after the fetched start', async () => {
    await expect(updateCalendarEvent('user-1', { eventId: 'event-1', endDateTime: '2026-10-01T13:00:00.000Z' }))
      .rejects.toMatchObject({ code: 'INVALID_CALENDAR_INTERVAL' });
    expect(mockUpdate).not.toHaveBeenCalled();
  });
});
