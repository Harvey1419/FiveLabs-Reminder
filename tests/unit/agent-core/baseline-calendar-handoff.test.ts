import { describe, expect, it, vi } from 'vitest';
import type { TurnContext } from '@templelabs/contracts';
import { untrustedResultMock } from '../../support/unit/contract-boundary.js';
vi.mock('../../../src/integrations/google/calendar.js', () => ({ listCalendarEvents: vi.fn() }));
import { listCalendarEvents } from '../../../src/integrations/google/calendar.js';
import { readOwnedBaselineEvent } from '../../../src/adapters/agent-core/baseline-calendar-handoff.js';
const context: TurnContext = { userId: 'owner', runId: 'run', requestId: 'request', timezone: 'America/Bogota', language: 'es', referenceTimeIso: '2026-10-13T12:00:00Z', capabilities: new Set(), signal: new AbortController().signal };
describe('calendar baseline handoff uses an authenticated bounded read', () => {
  it('imports timed events from actual returned owner rows, never historical labels', async () => {
    untrustedResultMock(listCalendarEvents).mockResolvedValue([{ id: 'event', summary: 'Verified', start: '2026-10-13T20:00:00Z', end: '2026-10-13T21:00:00Z', isAllDay: false, meetLink: null }]);
    expect(await readOwnedBaselineEvent('event', context, { startIso: '2026-10-13T20:00:00Z', summary: 'Unverified' })).toEqual({
      kind: 'timed', id: 'event', summary: 'Verified', startIso: '2026-10-13T20:00:00Z', endIso: '2026-10-13T21:00:00Z', meetLink: null,
    });
    expect(listCalendarEvents).toHaveBeenCalledWith('owner', { timeMin: new Date('2026-10-12T20:00:00Z'), timeMax: new Date('2026-10-14T20:00:00Z'), maxResults: 50, timezone: 'America/Bogota' });
  });
  it('retains civil dates and exclusive end for all-day events', async () => {
    untrustedResultMock(listCalendarEvents).mockResolvedValue([{ id: 'holiday', summary: 'Holiday', start: '2026-10-13', end: '2026-10-14', isAllDay: true }]);
    expect(await readOwnedBaselineEvent('holiday', context, { start: { date: '2026-10-13' } })).toEqual({ kind: 'all_day', id: 'holiday', summary: 'Holiday', startDate: '2026-10-13', endDateExclusive: '2026-10-14' });
  });
  it('never imports an event absent from the user calendar', async () => {
    untrustedResultMock(listCalendarEvents).mockResolvedValue([]);
    expect(await readOwnedBaselineEvent('foreign-event', context, { start: '2026-10-13' })).toBeNull();
  });
});
