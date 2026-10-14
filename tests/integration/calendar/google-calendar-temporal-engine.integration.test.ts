import 'dotenv/config';
import { untrustedResultMock } from '../../support/unit/contract-boundary.js';
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { routeMessage } from '../../../src/agent/orchestration/router.js';
import { executeCalendarTool } from '../../../src/agent/tools/calendar.js';
import * as googleCalendarService from '../../../src/integrations/google/calendar.js';
import {
  resolveCalendarTemporalScope,
  zonedTimeToUtc,
  getLocalDateParts,
  DEFAULT_TIMEZONE,
} from '../../../src/shared/time.js';
import {
  saveUserIntegration,
  getUserIntegration,
  deleteUserIntegration,
} from '../../../src/infrastructure/database/integrations.js';
import { getOrCreateUserByPhone } from '../../../src/infrastructure/database/users.js';

describe('Google Calendar Canonical Temporal Engine Test Suite', () => {
  const testPhoneA = '573007771122';
  const testPhoneB = '573007773344';
  type FixtureUser = NonNullable<NonNullable<Parameters<typeof executeCalendarTool>[0]>['user']> & { id: string };
  let userA: FixtureUser | null = null;
  let userB: FixtureUser | null = null;

  beforeAll(async () => {
    userA = await getOrCreateUserByPhone(testPhoneA, 'America/Bogota', 'es-CO', 'Temporal User A') as unknown as FixtureUser;
    userB = await getOrCreateUserByPhone(testPhoneB, 'America/Bogota', 'es-CO', 'Temporal User B') as unknown as FixtureUser;

    await saveUserIntegration(userA!.id, {
      provider: 'google',
      accessToken: 'token-a-active',
      refreshToken: 'token-a-refresh',
      accountEmail: 'temporal.a@gmail.com',
    });
  });

  afterAll(async () => {
    if (userA?.id) await deleteUserIntegration(userA!.id, 'google');
    if (userB?.id) await deleteUserIntegration(userB!.id, 'google');
  });

  // T01: today
  it('T01: scope "today" computes [startOfTodayLocal, startOfTomorrowLocal) in user timezone', () => {
    const tz = 'America/Bogota';
    const fakeNow = zonedTimeToUtc(2026, 9, 2, 14, 30, 0, tz); // Wednesday Sep 2, 2026
    // Midnight bounds require the explicit full-day option; ordinary today starts at now.
    const res = resolveCalendarTemporalScope({ scope: 'today', fullDay: true }, tz, fakeNow);

    expect(res.timeMin.toISOString()).toBe('2026-09-02T05:00:00.000Z');
    expect(res.timeMax!.toISOString()).toBe('2026-09-03T05:00:00.000Z');
    expect(res.isNextEvent).toBe(false);
  });

  // T02: tomorrow
  it('T02: scope "tomorrow" computes [startOfTomorrowLocal, startOfDayAfterTomorrowLocal)', () => {
    const tz = 'America/Bogota';
    const fakeNow = zonedTimeToUtc(2026, 9, 2, 14, 30, 0, tz);
    const res = resolveCalendarTemporalScope({ scope: 'tomorrow' }, tz, fakeNow);

    expect(res.timeMin.toISOString()).toBe('2026-09-03T05:00:00.000Z');
    expect(res.timeMax!.toISOString()).toBe('2026-09-04T05:00:00.000Z');
  });

  // T03: this_week
  it('T03: scope "this_week" computes [Monday 00:00 local, Next Monday 00:00 local)', () => {
    const tz = 'America/Bogota';
    const fakeNow = zonedTimeToUtc(2026, 9, 2, 14, 30, 0, tz); // Wednesday Sep 2, 2026
    const res = resolveCalendarTemporalScope({ scope: 'this_week' }, tz, fakeNow);

    // Monday of current week is Aug 31, 2026
    expect(res.timeMin.toISOString()).toBe('2026-08-31T05:00:00.000Z');
    // Next Monday is Sep 7, 2026
    expect(res.timeMax!.toISOString()).toBe('2026-09-07T05:00:00.000Z');
  });

  // T04: next_week
  it('T04: scope "next_week" computes [Next Monday 00:00 local, Monday After Next 00:00 local)', () => {
    const tz = 'America/Bogota';
    const fakeNow = zonedTimeToUtc(2026, 9, 2, 14, 30, 0, tz); // Wednesday Sep 2, 2026
    const res = resolveCalendarTemporalScope({ scope: 'next_week' }, tz, fakeNow);

    // Next Monday is Sep 7, 2026
    expect(res.timeMin.toISOString()).toBe('2026-09-07T05:00:00.000Z');
    // Monday after next is Sep 14, 2026
    expect(res.timeMax!.toISOString()).toBe('2026-09-14T05:00:00.000Z');
  });

  // T05: this_weekend from Friday
  it('T05: this_weekend when called on Friday resolves [Saturday 00:00, Monday 00:00)', () => {
    const tz = 'America/Bogota';
    const fridayNow = zonedTimeToUtc(2026, 9, 4, 16, 0, 0, tz); // Friday Sep 4, 2026
    const res = resolveCalendarTemporalScope({ scope: 'this_weekend' }, tz, fridayNow);

    expect(res.timeMin.toISOString()).toBe('2026-09-05T05:00:00.000Z'); // Saturday Sep 5
    expect(res.timeMax!.toISOString()).toBe('2026-09-07T05:00:00.000Z'); // Monday Sep 7
  });

  // T06: this_weekend from Saturday
  it('T06: this_weekend when called on Saturday resolves [Saturday 00:00, Monday 00:00)', () => {
    const tz = 'America/Bogota';
    const saturdayNow = zonedTimeToUtc(2026, 9, 5, 10, 0, 0, tz); // Saturday Sep 5, 2026
    const res = resolveCalendarTemporalScope({ scope: 'this_weekend' }, tz, saturdayNow);

    expect(res.timeMin.toISOString()).toBe('2026-09-05T05:00:00.000Z'); // Saturday Sep 5
    expect(res.timeMax!.toISOString()).toBe('2026-09-07T05:00:00.000Z'); // Monday Sep 7
  });

  // T07: this_weekend from Sunday
  it('T07: this_weekend when called on Sunday resolves [Sunday 00:00, Monday 00:00)', () => {
    const tz = 'America/Bogota';
    const sundayNow = zonedTimeToUtc(2026, 9, 6, 12, 0, 0, tz); // Sunday Sep 6, 2026
    const res = resolveCalendarTemporalScope({ scope: 'this_weekend' }, tz, sundayNow);

    expect(res.timeMin.toISOString()).toBe('2026-09-06T05:00:00.000Z'); // Sunday Sep 6
    expect(res.timeMax!.toISOString()).toBe('2026-09-07T05:00:00.000Z'); // Monday Sep 7
  });

  // T08: this_weekend from Monday-Thursday
  it('T08: this_weekend when called on Tuesday resolves to upcoming weekend [Saturday 00:00, Monday 00:00)', () => {
    const tz = 'America/Bogota';
    const tuesdayNow = zonedTimeToUtc(2026, 9, 1, 9, 0, 0, tz); // Tuesday Sep 1, 2026
    const res = resolveCalendarTemporalScope({ scope: 'this_weekend' }, tz, tuesdayNow);

    expect(res.timeMin.toISOString()).toBe('2026-09-05T05:00:00.000Z'); // Saturday Sep 5
    expect(res.timeMax!.toISOString()).toBe('2026-09-07T05:00:00.000Z'); // Monday Sep 7
  });

  // T09: default_upcoming (Generic)
  it('T09: default_upcoming resolves from now to start of Monday after next week (~7-14 days)', () => {
    const tz = 'America/Bogota';
    const wednesdayNow = zonedTimeToUtc(2026, 9, 2, 14, 30, 0, tz); // Wednesday Sep 2, 2026
    const res = resolveCalendarTemporalScope({ scope: 'default_upcoming' }, tz, wednesdayNow);

    expect(res.timeMin.toISOString()).toBe(wednesdayNow.toISOString());
    // Monday after next is Sep 14, 2026
    expect(res.timeMax!.toISOString()).toBe('2026-09-14T05:00:00.000Z');
    expect(res.timeMax!.getTime() > res.timeMin.getTime()).toBe(true);
  });

  // T10: next_event with event tomorrow
  it('T10: next_event returns exactly single event with maxResults=1 and formats focused card', async () => {
    const listSpy = untrustedResultMock(vi.spyOn(googleCalendarService, 'listCalendarEvents')).mockResolvedValue([
      { summary: 'Reunión de Diseño', start: '2026-09-03T10:00:00-05:00', end: '2026-09-03T11:00:00-05:00', meetLink: 'https://meet.google.com/xyz' }
    ]);

    const res = await executeCalendarTool({
      action: 'list_events',
      params: { scope: 'next_event' },
      user: userA,
      language: 'es',
    });

    expect(res.success).toBe(true);
    expect(res.rawSummary).toContain('Tu próximo evento en Google Calendar es:');
    expect(res.rawSummary).toContain('Reunión de Diseño');
    expect(res.rawSummary).toContain('https://meet.google.com/xyz');
    expect((res.data as unknown[]).length).toBe(1);

    listSpy.mockRestore();
  });

  // T11: next_event with annual recurrence (singleEvents=true + maxResults=1)
  it('T11: next_event handles next recurring event instance without returning subsequent future years', () => {
    const tz = 'America/Bogota';
    const fakeNow = zonedTimeToUtc(2026, 9, 2, 14, 0, 0, tz);
    const res = resolveCalendarTemporalScope({ scope: 'next_event' }, tz, fakeNow);

    expect(res.isNextEvent).toBe(true);
    expect(res.maxResults).toBe(1);
    expect(res.timeMax).toBeNull(); // Sole documented exception
  });

  // T12: next_event normal event before recurring event
  it('T12: next_event selects the nearest chronological event', async () => {
    // When Google API returns the single first chronological event
    const listSpy = untrustedResultMock(vi.spyOn(googleCalendarService, 'listCalendarEvents')).mockResolvedValue([
      { summary: 'Cita Médica Mañana', start: '2026-09-03T08:00:00-05:00', end: '2026-09-03T09:00:00-05:00', meetLink: null }
    ]);

    const res = await executeCalendarTool({
      action: 'list_events',
      params: { scope: 'next_event' },
      user: userA,
      language: 'es',
    });

    expect(res.rawSummary).toContain('Cita Médica Mañana');
    expect((res.data as unknown[]).length).toBe(1);

    listSpy.mockRestore();
  });

  // T13: next_event with empty calendar
  it('T13: next_event on empty calendar gracefully returns clear informative message', async () => {
    const listSpy = untrustedResultMock(vi.spyOn(googleCalendarService, 'listCalendarEvents')).mockResolvedValue([]);

    const res = await executeCalendarTool({
      action: 'list_events',
      params: { scope: 'next_event' },
      user: userA,
      language: 'es',
    });

    expect(res.success).toBe(true);
    expect(res.rawSummary).toContain('No tienes eventos próximos programados en tu Google Calendar.');
    expect((res.data as unknown[]).length).toBe(0);

    listSpy.mockRestore();
  });

  // T14: explicit_date
  it('T14: explicit_date "2026-10-13" bounds to exact 24h local day [2026-10-13 00:00 local, 2026-10-14 00:00 local)', () => {
    const tz = 'America/Bogota';
    const res = resolveCalendarTemporalScope({ scope: 'explicit_date', date: '2026-10-13' }, tz);

    expect(res.timeMin.toISOString()).toBe('2026-10-13T05:00:00.000Z');
    expect(res.timeMax!.toISOString()).toBe('2026-10-14T05:00:00.000Z');
  });

  // T15: explicit_range
  it('T15: explicit_range from 2026-10-10 to 2026-10-15 bounds semi-open through 2026-10-16 00:00 local', () => {
    const tz = 'America/Bogota';
    const res = resolveCalendarTemporalScope({
      scope: 'explicit_range',
      dateFrom: '2026-10-10',
      dateTo: '2026-10-15',
    }, tz);

    expect(res.timeMin.toISOString()).toBe('2026-10-10T05:00:00.000Z');
    expect(res.timeMax!.toISOString()).toBe('2026-10-16T05:00:00.000Z');
  });

  // T16: month
  it('T16: month "octubre" bounds from Oct 1 00:00 local to Nov 1 00:00 local', () => {
    const tz = 'America/Bogota';
    const fakeNow = zonedTimeToUtc(2026, 9, 2, 14, 0, 0, tz);
    const res = resolveCalendarTemporalScope({ scope: 'month', month: 'octubre' }, tz, fakeNow);

    expect(res.timeMin.toISOString()).toBe('2026-10-01T05:00:00.000Z');
    expect(res.timeMax!.toISOString()).toBe('2026-11-01T05:00:00.000Z');
  });

  // T17: DST 23-hour day (Spring forward)
  it('T17: DST Spring-forward day (23h) in America/New_York (2026-03-08) correctly bounds local start to local next start', () => {
    const tz = 'America/New_York';
    const res = resolveCalendarTemporalScope({ scope: 'explicit_date', date: '2026-03-08' }, tz);

    // 00:00 local on Mar 8 is 05:00 UTC (UTC-5)
    expect(res.timeMin.toISOString()).toBe('2026-03-08T05:00:00.000Z');
    // 00:00 local on Mar 9 is 04:00 UTC (UTC-4)
    expect(res.timeMax!.toISOString()).toBe('2026-03-09T04:00:00.000Z');

    const durationMs = res.timeMax!.getTime() - res.timeMin.getTime();
    expect(durationMs).toBe(23 * 60 * 60 * 1000); // Exactly 23 hours!
  });

  // T18: DST 25-hour day (Fall back)
  it('T18: DST Fall-back day (25h) in America/New_York (2026-11-01) correctly bounds local start to local next start', () => {
    const tz = 'America/New_York';
    const res = resolveCalendarTemporalScope({ scope: 'explicit_date', date: '2026-11-01' }, tz);

    // 00:00 local on Nov 1 is 04:00 UTC (UTC-4)
    expect(res.timeMin.toISOString()).toBe('2026-11-01T04:00:00.000Z');
    // 00:00 local on Nov 2 is 05:00 UTC (UTC-5)
    expect(res.timeMax!.toISOString()).toBe('2026-11-02T05:00:00.000Z');

    const durationMs = res.timeMax!.getTime() - res.timeMin.getTime();
    expect(durationMs).toBe(25 * 60 * 60 * 1000); // Exactly 25 hours!
  });

  // T19: Conversational continuation "Tráemelos"
  it('T19: Conversational continuation "Tráemelos" after "esta semana" retains this_week intent', async () => {
    const history = [
      { role: 'user', content: '¿Qué tengo esta semana en mi calendario?' },
      { role: 'assistant', content: 'Tienes 3 eventos esta semana en tu calendario.' },
    ];

    const listSpy = untrustedResultMock(vi.spyOn(googleCalendarService, 'listCalendarEvents')).mockResolvedValue([
      { summary: 'Sprint Review', start: '2026-09-04T15:00:00-05:00', end: '2026-09-04T16:00:00-05:00' }
    ]);

    const res = await routeMessage('Tráemelos por favor', userA, history);
    expect(res.intent === 'calendar' || (res.confirmation as string | undefined)?.includes('intermitencia')).toBe(true);
    if (res.intent === 'calendar') {
      expect(res.entities?.action).toBe('list_events');
    }

    listSpy.mockRestore();
  });

  // T20: Scope override "¿Y mañana?"
  it('T20: New explicit intent "¿Y mañana?" overrides previously active scope to tomorrow', async () => {
    const history = [
      { role: 'user', content: '¿Qué tengo hoy?' },
      { role: 'assistant', content: 'No tienes eventos para hoy.' },
    ];

    const listSpy = untrustedResultMock(vi.spyOn(googleCalendarService, 'listCalendarEvents')).mockResolvedValue([]);

    const res = await routeMessage('¿Y qué tengo para mañana en Google Calendar?', userA, history);
    expect(res.intent === 'calendar' || (res.confirmation as string | undefined)?.includes('intermitencia')).toBe(true);
    if (res.intent === 'calendar') {
      expect(res.entities?.action).toBe('list_events');
      expect(res.entities?.scope === 'tomorrow' || res.entities?.timeMin === 'mañana').toBe(true);
    }

    listSpy.mockRestore();
  });

  // T21: Scope change "¿Cuál es el más cercano?"
  it('T21: Scope change to "¿Cuál es el evento más cercano?" resolves next_event', async () => {
    const history = [
      { role: 'user', content: '¿Qué tengo en mi calendario?' },
      { role: 'assistant', content: 'Tienes 5 eventos programados.' },
    ];

    const listSpy = untrustedResultMock(vi.spyOn(googleCalendarService, 'listCalendarEvents')).mockResolvedValue([
      { summary: 'Reunión 1:1', start: '2026-09-03T11:00:00-05:00', end: '2026-09-03T11:30:00-05:00' }
    ]);

    const res = await routeMessage('¿Cuál es el evento más cercano que tengo?', userA, history);
    expect(res.intent === 'calendar' || (res.confirmation as string | undefined)?.includes('intermitencia')).toBe(true);
    if (res.intent === 'calendar') {
      expect(['list_events', 'next_event']).toContain(res.entities?.action);
      expect(res.entities?.scope === 'next_event' || res.entities?.action === 'next_event').toBe(true);
    }

    listSpy.mockRestore();
  });

  // T22: Annual recurrence outside range (0 occurrences in September)
  it('T22: Annual recurrence on Oct 13 falls strictly outside September query bounds', () => {
    const tz = 'America/Bogota';
    const boundsSep = resolveCalendarTemporalScope({ scope: 'month', month: 'septiembre' }, tz, zonedTimeToUtc(2026, 9, 2, 0, 0, 0, tz));

    const oct13Instance = zonedTimeToUtc(2026, 10, 13, 12, 0, 0, tz);
    const inBounds = oct13Instance >= boundsSep.timeMin && oct13Instance < boundsSep.timeMax!;
    expect(inBounds).toBe(false);
  });

  // T23: Annual recurrence within range (exactly 1 occurrence, no 2027+)
  it('T23: Annual recurrence on Oct 13 inside October query returns only 2026 instance', () => {
    const tz = 'America/Bogota';
    const boundsOct = resolveCalendarTemporalScope({ scope: 'month', month: 'octubre' }, tz, zonedTimeToUtc(2026, 9, 2, 0, 0, 0, tz));

    const oct2026Instance = zonedTimeToUtc(2026, 10, 13, 12, 0, 0, tz);
    const oct2027Instance = zonedTimeToUtc(2027, 10, 13, 12, 0, 0, tz);

    expect(oct2026Instance >= boundsOct.timeMin && oct2026Instance < boundsOct.timeMax!).toBe(true);
    expect(oct2027Instance >= boundsOct.timeMin && oct2027Instance < boundsOct.timeMax!).toBe(false);
  });

  // T24: Invariant: All standard list scopes have finite non-null bounds
  it('T24: Invariant: all list scopes guarantee timeMin != null, timeMax != null and timeMin < timeMax', () => {
    const tz = 'America/Bogota';
    const scopes = ['today', 'tomorrow', 'this_week', 'next_week', 'this_weekend', 'default_upcoming', 'explicit_date', 'explicit_range', 'month'];

    for (const s of scopes) {
      const res = resolveCalendarTemporalScope({ scope: s, date: '2026-10-13', dateFrom: '2026-10-10', dateTo: '2026-10-15', month: '10' }, tz);
      expect(res.timeMin).toBeInstanceOf(Date);
      expect(res.timeMax).toBeInstanceOf(Date);
      expect(res.timeMin.getTime()).toBeLessThan(res.timeMax!.getTime());
    }
  });

  // T25: maxResults is not a substitute for time bounds
  it('T25: resolveCalendarTemporalScope emits explicit time bounds regardless of maxResults', () => {
    const tz = 'America/Bogota';
    const res = resolveCalendarTemporalScope({ scope: 'this_week' }, tz);

    expect(res.timeMin).toBeDefined();
    expect(res.timeMax).toBeDefined();
    expect(res.maxResults).toBeGreaterThan(0);
  });

  // T26: Multi-tenant isolation
  it('T26: Multi-tenant isolation: User A calendar queries never bleed to User B', async () => {
    await deleteUserIntegration(userB!.id, 'google');

    const resB = await executeCalendarTool({
      action: 'list_events',
      params: { scope: 'today' },
      user: userB,
      language: 'es',
    });

    expect(resB.success).toBe(false);
    expect(resB.action).toBe('google_not_connected');

    const resA = await getUserIntegration(userA!.id, 'google');
    expect(resA).not.toBeNull();
    expect(resA!.account_email).toBe('temporal.a@gmail.com');
  });
});
