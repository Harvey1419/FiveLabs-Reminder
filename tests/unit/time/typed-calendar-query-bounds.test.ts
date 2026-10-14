import { describe, expect, it, vi } from 'vitest';
import { createCalendarScopeResolver } from '../../../src/shared/calendar-query-bounds.js';
import { resolveCalendarTemporalScope } from '../../../src/shared/time.js';
const now = new Date('2027-01-14T17:49:00Z');
describe('typed calendar query bounds', () => {
  it('distinguishes remaining today from a full local day and preserves result limits', () => {
    const partial = resolveCalendarTemporalScope({ scope: 'today' }, 'America/Bogota', now);
    const full = resolveCalendarTemporalScope({ scope: 'today', fullDay: true }, 'America/Bogota', now);
    expect(partial.timeMin).toBe(now); expect(full.timeMin.toISOString()).toBe('2027-01-14T05:00:00.000Z'); expect(full.timeMax?.toISOString()).toBe('2027-01-15T05:00:00.000Z'); expect(full.maxResults).toBe(15);
  });
  it('builds Monday-based current/next week bounds and remaining Sunday weekend bounds', () => {
    const current = resolveCalendarTemporalScope({ scope: 'this_week' }, 'America/Bogota', now), next = resolveCalendarTemporalScope({ scope: 'next_week' }, 'America/Bogota', now);
    expect(current.timeMin.toISOString()).toBe('2027-01-11T05:00:00.000Z'); expect(current.timeMax?.toISOString()).toBe('2027-01-18T05:00:00.000Z'); expect(next.timeMin.toISOString()).toBe('2027-01-18T05:00:00.000Z'); expect(next.timeMax?.toISOString()).toBe('2027-01-25T05:00:00.000Z');
    const weekend = resolveCalendarTemporalScope({ scope: 'this_weekend' }, 'America/Bogota', new Date('2027-01-17T17:00:00Z'));
    expect(weekend.timeMin.toISOString()).toBe('2027-01-17T05:00:00.000Z'); expect(weekend.timeMax?.toISOString()).toBe('2027-01-18T05:00:00.000Z'); expect(weekend.maxResults).toBe(20);
  });
  it('keeps next-event as the single-result open-ended exception', () => {
    const result = resolveCalendarTemporalScope({ scope: 'next_event' }, 'America/Bogota', now);
    expect(result).toEqual({ timeMin: now, timeMax: null, isNextEvent: true, maxResults: 1, scope: 'next_event' });
  });
  it('retains inclusive input end dates as exclusive next-day bounds across DST', () => {
    const range = resolveCalendarTemporalScope({ dateFrom: '2027-03-13', dateTo: '2027-03-14' }, 'America/Los_Angeles', now);
    expect(range.timeMin.toISOString()).toBe('2027-03-13T08:00:00.000Z'); expect(range.timeMax?.toISOString()).toBe('2027-03-15T07:00:00.000Z'); expect(range.maxResults).toBe(35);
    const day = resolveCalendarTemporalScope({ scope: 'explicit_date', date: '2027-03-14' }, 'America/Los_Angeles', now); expect(day.timeMax!.getTime()-day.timeMin.getTime()).toBe(23*3600000);
  });
  it('preserves supplied shorthand date insertion and named-month rollover', () => {
    const input: Record<string, unknown> = { scope: '2027-01-17' };
    expect(resolveCalendarTemporalScope(input, 'America/Bogota', now).scope).toBe('explicit_date'); expect(input.date).toBe('2027-01-17');
    const month = resolveCalendarTemporalScope({ scope: 'month', month: 'enero', query: 'monthly report' }, 'America/Bogota', new Date('2027-12-14T17:00:00Z'));
    expect(month.timeMin.toISOString()).toBe('2028-01-01T05:00:00.000Z'); expect(month.timeMax?.toISOString()).toBe('2028-02-01T05:00:00.000Z'); expect(month.maxResults).toBe(50);
  });
  it('retains same-weekday next-week selection and rejects inherited weekday table entries', () => {
    const next = resolveCalendarTemporalScope({ scope: 'thursday', query: 'next' }, 'America/Bogota', now); expect(next.timeMin.toISOString()).toBe('2027-01-21T05:00:00.000Z'); expect(next.maxResults).toBe(25);
    for (const scope of ['constructor', '__proto__']) { const result = resolveCalendarTemporalScope({ scope }, 'America/Bogota', now); expect(result.scope).toBe('default_upcoming'); expect(Number.isNaN(result.timeMin.getTime())).toBe(false); expect(Number.isNaN(result.timeMax?.getTime())).toBe(false); }
  });
  it('uses defined month names only and retains the existing unknown-month fallback', () => {
    const result = resolveCalendarTemporalScope({ scope: 'explicit_date', date: '17 de constructor' }, 'America/Bogota', now);
    expect(result.timeMin.toISOString()).toBe('2027-01-17T05:00:00.000Z');
    expect(resolveCalendarTemporalScope({ scope: 'month', month: 'unknown' }, 'America/Bogota', now).timeMin.toISOString()).toBe('2027-01-01T05:00:00.000Z');
  });
  it('delegates legacy time strings lazily and preserves their existing fallback reference policy', () => {
    const parsedMin = new Date('2027-01-15T12:00:00Z'); const parse = vi.fn((value: unknown) => value === 'start' ? parsedMin : null);
    const { resolveCalendarTemporalScope: resolve } = createCalendarScopeResolver({ parseTargetTime: parse });
    expect(parse).not.toHaveBeenCalled(); const result = resolve({ scope: 'custom_range', timeMin: 'start', timeMax: 'bad end' }, 'America/Bogota', now);
    expect(parse).toHaveBeenCalledWith('start', 'America/Bogota'); expect(parse).toHaveBeenCalledWith('bad end', 'America/Bogota'); expect(result.timeMin).toBe(parsedMin); expect(result.timeMax?.toISOString()).toBe('2027-01-29T05:00:00.000Z'); expect(result.maxResults).toBe(30);
  });
});
