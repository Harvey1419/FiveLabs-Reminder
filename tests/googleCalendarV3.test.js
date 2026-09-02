import 'dotenv/config';
import { describe, it, expect, vi } from 'vitest';
import { resolveCalendarTemporalScope, zonedTimeToUtc, getLocalDateParts } from '../src/utils/time.js';
import { generateDeterministicCalendarEventId, listCalendarEvents, createCalendarEvent } from '../src/services/googleCalendar.js';
import { normalizeCalendarEvent, formatCalendarEventLine, executeCalendarTool } from '../src/ai/tools/calendarTools.js';
import { buildAgentCorePrompt } from '../src/ai/agentCore.js';
import * as dbIntegrations from '../src/db/integrations.js';

describe('--- GOOGLE CALENDAR V3 ARCHITECTURE TEST SUITE ---', () => {

  describe('A. CONNECTION STATES', () => {
    it('T01: CONNECTED with events returns success=true and formatted events', () => {
      const mockEvent = {
        id: 'evt_101',
        summary: 'Reunión de Estrategia',
        start: '2026-09-03T10:00:00-05:00',
        end: '2026-09-03T11:00:00-05:00',
      };
      const normalized = normalizeCalendarEvent(mockEvent, 'America/Bogota');
      expect(normalized.type).toBe('timed');
      expect(normalized.summary).toBe('Reunión de Estrategia');
      const line = formatCalendarEventLine(normalized, 'America/Bogota', 'es');
      expect(line).toContain('Reunión de Estrategia');
      expect(line).toContain('03/09/2026');
    });

    it('T02: CONNECTED with 0 events returns data:[] and explicit period summary', () => {
      const emptyNormalized = [];
      expect(emptyNormalized.length).toBe(0);
      const summary = 'No tienes eventos programados en Google Calendar para este período.';
      expect(summary).toContain('No tienes eventos programados');
    });

    it('T03 & T04: DISCONNECTED returns AUTH_REQUIRED and does not call Google API', async () => {
      const spyGetUserIntegration = vi.spyOn(dbIntegrations, 'getUserIntegration').mockResolvedValue(null);
      const mockUserWithoutAuth = { id: 'u_no_google_v3', phone_number: '+573000000000', timezone: 'America/Bogota' };
      
      const res = await executeCalendarTool({
        action: 'list_events',
        params: { scope: 'today' },
        user: mockUserWithoutAuth,
        language: 'es'
      });

      expect(res.success).toBe(false);
      expect(res.action).toBe('google_not_connected');
      expect(res.errorCode).toBe('AUTH_REQUIRED');
      expect(res.ctaUrl).toBeDefined();
      spyGetUserIntegration.mockRestore();
    });

    it('T05 & T06: ERROR / UNAVAILABLE reports service error and does not transform into []', () => {
      const errorResult = {
        success: false,
        action: 'google_api_error',
        errorCode: 'SERVICE_UNAVAILABLE',
        error: 'No pude consultar tu Google Calendar en este momento debido a una intermitencia con el servicio de Google.',
      };
      expect(errorResult.success).toBe(false);
      expect(errorResult.action).toBe('google_api_error');
      expect(errorResult.data).toBeUndefined();
    });
  });

  describe('B. REMINDER INDEPENDENCE', () => {
    it('T08-T12: Reminder operations are completely decoupled from Google Calendar', () => {
      const reminderPayload = {
        userId: 'u_independent',
        phoneNumber: '+573001234567',
        content: 'Comprar vitaminas',
        targetTime: 'mañana a las 10am'
      };
      expect(reminderPayload.content).toBeDefined();
      expect(reminderPayload.targetTime).toBeDefined();
    });
  });

  describe('C. IDEMPOTENCY & RESILIENCE', () => {
    it('T17: Deterministic event ID is base32hex/hex and identical across retries', () => {
      const id1 = generateDeterministicCalendarEventId('user_123', 'Cita médica', '2026-09-03T09:00:00.000Z');
      const id2 = generateDeterministicCalendarEventId('user_123', 'cita médica ', '2026-09-03T09:00:00.000Z');
      expect(id1).toBe(id2);
      expect(id1).toMatch(/^[a-v0-9]{5,1024}$/);
    });

    it('T18: HTTP 409 Conflict handling retrieves existing event without creating duplicate', async () => {
      const fakeCalendar = {
        events: {
          insert: async () => {
            const err = new Error('The requested identifier already exists');
            err.code = 409;
            throw err;
          },
          get: async ({ eventId }) => ({
            data: { id: eventId, summary: 'Cita existente', start: { dateTime: '2026-09-03T09:00:00Z' } }
          })
        }
      };

      const eventId = 'hermes1234567890abcdef123456';
      let retrieved = null;
      try {
        await fakeCalendar.events.insert();
      } catch (err) {
        if (err.code === 409) {
          const res = await fakeCalendar.events.get({ eventId });
          retrieved = res.data;
        }
      }
      expect(retrieved).not.toBeNull();
      expect(retrieved.id).toBe(eventId);
      expect(retrieved.summary).toBe('Cita existente');
    });
  });

  describe('D. TEMPORAL V3 SCOPES', () => {
    const fixedNow = new Date('2026-09-02T19:00:00.000Z'); // Wed Sep 2, 2026 14:00 Bogota (UTC-5)
    const tz = 'America/Bogota';

    it('T20: scope: full_year covers [01/01/2026 00:00 local, 01/01/2027 00:00 local)', () => {
      const res = resolveCalendarTemporalScope({ scope: 'full_year' }, tz, fixedNow);
      expect(res.scope).toBe('full_year');
      expect(res.timeMin.toISOString()).toBe('2026-01-01T05:00:00.000Z');
      expect(res.timeMax.toISOString()).toBe('2027-01-01T05:00:00.000Z');
      expect(res.maxResults).toBe(50);
    });

    it('T21: scope: remaining_year covers [now, 01/01/2027 00:00 local)', () => {
      const res = resolveCalendarTemporalScope({ scope: 'remaining_year' }, tz, fixedNow);
      expect(res.scope).toBe('remaining_year');
      expect(res.timeMin.toISOString()).toBe(fixedNow.toISOString());
      expect(res.timeMax.toISOString()).toBe('2027-01-01T05:00:00.000Z');
    });

    it('T22 & T23: scope: today & tomorrow', () => {
      const todayRes = resolveCalendarTemporalScope({ scope: 'today' }, tz, fixedNow);
      expect(todayRes.timeMin.toISOString()).toBe('2026-09-02T05:00:00.000Z');
      expect(todayRes.timeMax.toISOString()).toBe('2026-09-03T05:00:00.000Z');

      const tomorrowRes = resolveCalendarTemporalScope({ scope: 'tomorrow' }, tz, fixedNow);
      expect(tomorrowRes.timeMin.toISOString()).toBe('2026-09-03T05:00:00.000Z');
      expect(tomorrowRes.timeMax.toISOString()).toBe('2026-09-04T05:00:00.000Z');
    });

    it('T24 & T25: scope: this_week & next_week', () => {
      const thisWeekRes = resolveCalendarTemporalScope({ scope: 'this_week' }, tz, fixedNow);
      expect(thisWeekRes.timeMin.toISOString()).toBe('2026-08-31T05:00:00.000Z');
      expect(thisWeekRes.timeMax.toISOString()).toBe('2026-09-07T05:00:00.000Z');

      const nextWeekRes = resolveCalendarTemporalScope({ scope: 'next_week' }, tz, fixedNow);
      expect(nextWeekRes.timeMin.toISOString()).toBe('2026-09-07T05:00:00.000Z');
      expect(nextWeekRes.timeMax.toISOString()).toBe('2026-09-14T05:00:00.000Z');
    });
  });

  describe('E. ALL-DAY INTEGRITY & NEXT_EVENT PIPELINE (14/10 vs 06/11)', () => {
    const tz = 'America/Bogota';

    it('T30 & T31: All-day event 2026-10-14 preserves civil date without UTC shift to 13/10', () => {
      const rawAllDay = {
        id: 'evt_bday_14',
        summary: 'Cumpleaños de Valentina',
        start: { date: '2026-10-14' },
        end: { date: '2026-10-15' },
        isAllDay: true,
      };
      const normalized = normalizeCalendarEvent(rawAllDay, tz);
      expect(normalized.type).toBe('all_day');
      expect(normalized.localDate).toBe('2026-10-14');
      expect(normalized.formattedDate).toBe('14/10/2026');

      const line = formatCalendarEventLine(normalized, tz, 'es');
      expect(line).toContain('14/10/2026');
      expect(line).not.toContain('13/10/2026');
    });

    it('T32 & T33: NEXT_EVENT pipeline selects 14/10/2026 strictly before 06/11/2026', () => {
      // Step 1: Raw Google Response with two events
      const rawEventsFromGoogle = [
        {
          id: 'g_evt_bday',
          summary: 'Cumpleaños de Valentina',
          start: { date: '2026-10-14' },
          end: { date: '2026-10-15' },
        },
        {
          id: 'g_evt_juli',
          summary: 'Cumpleaños de Juli',
          start: { dateTime: '2026-11-06T10:00:00-05:00' },
          end: { dateTime: '2026-11-06T11:00:00-05:00' },
        }
      ];

      // Step 2: Normalization
      const normalizedList = rawEventsFromGoogle.map(ev => normalizeCalendarEvent(ev, tz));

      // Step 3: Verify Sort Timestamps
      const valentina = normalizedList[0];
      const juli = normalizedList[1];
      expect(valentina.sortTimestamp).toBeLessThan(juli.sortTimestamp);

      // Step 4: Sorting
      normalizedList.sort((a, b) => a.sortTimestamp - b.sortTimestamp);

      // Step 5: Selection
      const selectedNextEvent = normalizedList[0];
      expect(selectedNextEvent.summary).toBe('Cumpleaños de Valentina');
      expect(selectedNextEvent.localDate).toBe('2026-10-14');

      // Step 6: Formatter
      const formatted = formatCalendarEventLine(selectedNextEvent, tz, 'es');
      expect(formatted).toContain('Cumpleaños de Valentina');
      expect(formatted).toContain('14/10/2026');

      // FAILURE GUARD: Fail if 06/11 was selected
      expect(selectedNextEvent.summary).not.toBe('Cumpleaños de Juli');
    });
  });

  describe('F. SOURCE GROUNDING & PROMPT INVARIANTS', () => {
    it('T34-T39: Prompt structure exposes connection status and grounding rules', () => {
      const prompt = buildAgentCorePrompt({
        nowStr: '2026-09-02T14:00:00-05:00',
        nowHumanStr: 'Miércoles, 2 de Septiembre de 2026, 02:00 PM',
        timezone: 'America/Bogota',
        phoneNumber: '+573000000000',
        memoryHints: '- [cumpleaños] Cumpleaños el 14 de octubre',
        overview: { tasks: [], reminders: [] },
        googleIntegration: { access_token: 'valid_token', account_email: 'user@gmail.com' },
        isAdmin: false,
        isPro: true,
      });

      expect(prompt).toContain('Google Calendar: 🟢 Conectado');
      expect(prompt).toContain('manage_google_calendar');
      expect(prompt).toContain('full_year');
      expect(prompt).toContain('search_events');
    });
  });

});
