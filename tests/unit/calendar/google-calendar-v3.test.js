import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { describe, it, expect, vi } from 'vitest';
import { resolveCalendarTemporalScope } from '../../../src/shared/time.js';
import { generateDeterministicCalendarEventId } from '../../../src/integrations/google/calendar.js';
import {
  normalizeCalendarEvent,
  formatCalendarEventLine,
  executeCalendarTool,
  sanitizeCalendarQueryAndScope,
} from '../../../src/agent/tools/calendar.js';
import { buildAgentCorePrompt } from '../../../src/agent/core/agent-core.js';
import { getIntentToolDefinitions, validateTurnIntent } from '../../../src/agent/contracts/intent-contracts.js';
import { normalizeTurnIntentForRuntime } from '../../../src/agent/orchestration/intent-normalizer.js';
import { getGoogleRedirectUri, hasUsableGoogleCredentials, isGoogleAuthError } from '../../../src/integrations/google/auth.js';
import { formatCanonicalAgenda } from '../../../src/shared/agenda-presentation.js';
import { formatMorningBriefingMessage } from '../../../src/jobs/morning-briefing.js';
import * as dbIntegrations from '../../../src/infrastructure/database/integrations.js';
import * as dbIndex from '../../../src/infrastructure/database/index.js';
import * as googleCalendar from '../../../src/integrations/google/calendar.js';

describe('Google Calendar current architecture', () => {
  describe('connection states', () => {
    it('distinguishes usable, refreshable and expired credentials', () => {
      const expired = new Date(Date.now() - 60_000).toISOString();
      expect(hasUsableGoogleCredentials({ access_token: 'old', token_expiry: expired })).toBe(false);
      expect(hasUsableGoogleCredentials({ access_token: 'old', refresh_token: 'refresh', token_expiry: expired })).toBe(true);
      expect(hasUsableGoogleCredentials(null)).toBe(false);
    });

    it('distinguishes auth failures from generic Google service errors', () => {
      expect(isGoogleAuthError({ response: { status: 401, data: { error: 'invalid_token' } } })).toBe(true);
      expect(isGoogleAuthError({ response: { status: 400, data: { error: 'unauthorized_client' } } })).toBe(true);
      expect(isGoogleAuthError({ response: { status: 403, data: { error: { message: 'Quota exceeded' } } } })).toBe(false);
    });

    it('sanitizes a malformed redirect URI path', () => {
      const previousRedirect = process.env.GOOGLE_REDIRECT_URI;
      const previousBase = process.env.APP_BASE_URL;
      process.env.APP_BASE_URL = 'https://hermes.example.test';
      process.env.GOOGLE_REDIRECT_URI = 'https://hermes.example.test/auth/google/callback,';
      expect(getGoogleRedirectUri()).toBe('https://hermes.example.test/auth/google/callback');
      if (previousRedirect === undefined) delete process.env.GOOGLE_REDIRECT_URI;
      else process.env.GOOGLE_REDIRECT_URI = previousRedirect;
      if (previousBase === undefined) delete process.env.APP_BASE_URL;
      else process.env.APP_BASE_URL = previousBase;
    });

    it('returns AUTH_REQUIRED without calling Google when disconnected', async () => {
      vi.spyOn(dbIntegrations, 'getUserIntegration').mockResolvedValue(null);
      const res = await executeCalendarTool({
        action: 'list_events',
        params: { scope: 'today' },
        user: { id: 'u_no_google_v3', phone_number: '+573000000000', timezone: 'America/Bogota' },
        language: 'es',
      });
      expect(res.success).toBe(false);
      expect(res.errorCode).toBe('AUTH_REQUIRED');
      expect(res.ctaUrl).toBeDefined();
      vi.restoreAllMocks();
    });
  });

  describe('normalization, idempotency and temporal truth', () => {
    it('formats timed events in user local time', () => {
      const normalized = normalizeCalendarEvent({
        id: 'evt_101', summary: 'Reunión de Estrategia',
        start: '2026-09-03T10:00:00-05:00', end: '2026-09-03T11:00:00-05:00',
      }, 'America/Bogota');
      expect(normalized.type).toBe('timed');
      expect(formatCalendarEventLine(normalized, 'America/Bogota', 'es')).toContain('10:00 AM');
    });

    it('generates the same deterministic event ID across equivalent retries', () => {
      const id1 = generateDeterministicCalendarEventId('user_123', 'Cita médica', '2026-09-03T09:00:00.000Z');
      const id2 = generateDeterministicCalendarEventId('user_123', 'cita médica ', '2026-09-03T09:00:00.000Z');
      expect(id1).toBe(id2);
      expect(id1).toMatch(/^[a-v0-9]{5,1024}$/);
    });

    it('preserves all-day civil dates without UTC day shifts', () => {
      const normalized = normalizeCalendarEvent({
        id: 'evt_bday', summary: 'Cumpleaños',
        start: { date: '2026-10-14' }, end: { date: '2026-10-15' },
      }, 'America/Bogota');
      expect(normalized.type).toBe('all_day');
      expect(normalized.localDate).toBe('2026-10-14');
      expect(formatCalendarEventLine(normalized, 'America/Bogota', 'es')).toContain('14/10/2026');
    });

    it('resolves core temporal scopes deterministically', () => {
      const now = new Date('2026-09-02T19:00:00.000Z');
      const tz = 'America/Bogota';
      const today = resolveCalendarTemporalScope({ scope: 'today' }, tz, now);
      const tomorrow = resolveCalendarTemporalScope({ scope: 'tomorrow' }, tz, now);
      const nextWeek = resolveCalendarTemporalScope({ scope: 'next_week' }, tz, now);
      expect(today.timeMin.toISOString()).toBe('2026-09-02T05:00:00.000Z');
      expect(tomorrow.timeMin.toISOString()).toBe('2026-09-03T05:00:00.000Z');
      expect(nextWeek.timeMin.toISOString()).toBe('2026-09-07T05:00:00.000Z');
    });

    it('sanitizes calendar queries, extracts temporal scopes and removes filler stopwords', () => {
      const q1 = sanitizeCalendarQueryAndScope({ query: 'reuniones mañana' });
      expect(q1.scope).toBe('tomorrow');
      expect(q1.query).toBeNull();

      const q2 = sanitizeCalendarQueryAndScope({ query: 'reunión con el médico mañana' });
      expect(q2.scope).toBe('tomorrow');
      expect(q2.query).toBe('médico');

      const q3 = sanitizeCalendarQueryAndScope({ query: 'Revisa mi calendario de google' });
      expect(q3.scope).toBeNull();
      expect(q3.query).toBeNull();

      const q4 = sanitizeCalendarQueryAndScope({ query: 'que reuniones tengo hoy' });
      expect(q4.scope).toBe('today');
      expect(q4.query).toBeNull();

      const q5 = sanitizeCalendarQueryAndScope({ query: 'cita con Carlos el viernes' });
      expect(q5.scope).toBe('friday');
      expect(q5.query).toBe('carlos');
    });
  });

  describe('current TurnIntent and presentation boundaries', () => {
    it('exposes one semantic execute_turn contract rather than legacy tool contracts', () => {
      const definitions = getIntentToolDefinitions();
      expect(definitions).toHaveLength(1);
      expect(definitions[0].function.name).toBe('execute_turn');
      const actionProps = definitions[0].function.parameters.properties.actions.items.properties;
      expect(actionProps.domain.enum).toContain('calendar');
      expect(actionProps.action).toBeDefined();
      expect(actionProps.target.description.toLowerCase()).toContain('never an internal id');
    });

    it('keeps calendar mutation identity separate from patch fields and legacy aliases', () => {
      const source = readFileSync(new URL('../../../src/agent/tools/calendar.js', import.meta.url), 'utf8');
      expect(source).toContain("String(params.target || '').trim()");
      expect(source).not.toContain('params.eventId || params.id');
      expect(source).not.toContain('params.query || params.q || params.semanticFilter');
      expect(source).not.toContain('Boolean(params.date || params.startDateTime || params.scope)');
      expect(source).not.toContain("case 'connect':");
    });

    it('prompt exposes Calendar connection state and keeps Node authoritative', () => {
      const prompt = buildAgentCorePrompt({
        nowStr: '2026-09-02T14:00:00-05:00',
        nowHumanStr: 'Miércoles, 2 de Septiembre de 2026, 02:00 PM',
        timezone: 'America/Bogota', phoneNumber: '+573000000000',
        memoryHints: '', overview: null,
        googleIntegration: { access_token: 'valid_token', account_email: 'user@gmail.com' },
        isAdmin: false, isPro: true,
      });
      expect(prompt).toContain('Google Calendar: 🟢 Conectado');
      expect(prompt).toContain('Node es la autoridad final');
    });

    it('canonical agenda renders AUTH_REQUIRED as reconnection, not outage', () => {
      const card = formatCanonicalAgenda({
        calendar: { state: 'AUTH_REQUIRED', events: [] },
        reminders: [{ content: 'Llamar', localTime: '9:00 a. m.' }],
        tasks: [], scope: 'today', timezone: 'America/Bogota',
      }, { language: 'es', timezone: 'America/Bogota' });
      expect(card).toContain('🔒 No conectado');
      expect(card).not.toContain('No disponible temporalmente');

      const briefing = formatMorningBriefingMessage({
        overview: { timedRemindersToday: [{ content: 'Llamar', localTime: '9:00 a. m.' }] },
        calendar: { state: 'AUTH_REQUIRED', events: [] },
        timezone: 'America/Bogota',
      });
      expect(briefing).toContain('Necesita conexión');
    });

    it('grounds connected and disconnected Google Calendar states explicitly in prompt', () => {
      const connectedPrompt = buildAgentCorePrompt({
        nowStr: '2026-09-12T14:00:00-05:00',
        nowHumanStr: 'Sábado, 12 de Septiembre de 2026, 02:00 PM',
        timezone: 'America/Bogota', phoneNumber: '+19164158325',
        googleIntegration: { access_token: 'valid_token', account_email: 'iab.billionaire@gmail.com' },
      });
      expect(connectedPrompt).toContain('Google Calendar: 🟢 Conectado (iab.billionaire@gmail.com)');
      expect(connectedPrompt).toContain('calendar.list');
      expect(connectedPrompt).toContain('NUNCA afirmes en conversation.reply que no puedes acceder al calendario');

      const disconnectedPrompt = buildAgentCorePrompt({
        nowStr: '2026-09-12T14:00:00-05:00',
        nowHumanStr: 'Sábado, 12 de Septiembre de 2026, 02:00 PM',
        timezone: 'America/Bogota', phoneNumber: '+19164158325',
        googleIntegration: null,
      });
      expect(disconnectedPrompt).toContain('Google Calendar: 🔴 No conectado');
      expect(disconnectedPrompt).toContain('emite calendar.list igualmente');
    });

    it('normalizes calendar.list temporal schedules into canonical scopes', () => {
      const context = {
        user: { id: 'test-user-123' },
        referenceTime: new Date('2026-09-12T19:00:00.000Z'),
        timezone: 'America/Bogota',
      };

      const todayIntent = {
        actions: [{ domain: 'calendar', action: 'list', schedule: { kind: 'relative_day_time', dayOffset: 0 } }],
      };
      const normalizedToday = normalizeTurnIntentForRuntime(todayIntent, context);
      expect(normalizedToday.actions[0].scope).toBe('today');

      const tomorrowIntent = {
        actions: [{ domain: 'calendar', action: 'list', schedule: { kind: 'relative_day_time', dayOffset: 1 } }],
      };
      const normalizedTomorrow = normalizeTurnIntentForRuntime(tomorrowIntent, context);
      expect(normalizedTomorrow.actions[0].scope).toBe('tomorrow');

      const weekdayIntent = {
        actions: [{ domain: 'calendar', action: 'list', schedule: { kind: 'weekday_time', weekday: 'friday' } }],
      };
      const normalizedWeekday = normalizeTurnIntentForRuntime(weekdayIntent, context);
      expect(normalizedWeekday.actions[0].scope).toBe('friday');

      const rawScopeIntent = {
        actions: [{ domain: 'calendar', action: 'list', scope: 'hoy' }],
      };
      const normalizedRaw = normalizeTurnIntentForRuntime(rawScopeIntent, context);
      expect(normalizedRaw.actions[0].scope).toBe('today');
    });

    it('normalizes calendar search actions with temporal queries into canonical list actions', () => {
      const context = {
        user: { id: 'test-user-123' },
        referenceTime: new Date('2026-09-12T19:00:00.000Z'),
        timezone: 'America/Bogota',
      };

      const searchTomorrow = {
        actions: [{ domain: 'calendar', action: 'search', query: 'reuniones mañana' }],
      };
      const normalizedTomorrow = normalizeTurnIntentForRuntime(searchTomorrow, context);
      expect(normalizedTomorrow.actions[0].action).toBe('list');
      expect(normalizedTomorrow.actions[0].scope).toBe('tomorrow');
      expect(normalizedTomorrow.actions[0].query).toBeUndefined();

      const searchSpecific = {
        actions: [{ domain: 'calendar', action: 'search', query: 'reunión con Carlos mañana' }],
      };
      const normalizedSpecific = normalizeTurnIntentForRuntime(searchSpecific, context);
      expect(normalizedSpecific.actions[0].action).toBe('search');
      expect(normalizedSpecific.actions[0].scope).toBe('tomorrow');
      expect(normalizedSpecific.actions[0].query).toBe('carlos');

      const searchGeneric = {
        actions: [{ domain: 'calendar', action: 'search', query: 'revisar mi calendario de google' }],
      };
      const normalizedGeneric = normalizeTurnIntentForRuntime(searchGeneric, context);
      expect(normalizedGeneric.actions[0].action).toBe('list');
      expect(normalizedGeneric.actions[0].scope).toBe('today');
    });

    it('validates canonical calendar operations in TurnIntent schema', () => {
      const listResult = validateTurnIntent({
        actions: [{ domain: 'calendar', action: 'list' }],
      });
      expect(listResult.valid).toBe(true);

      const connectResult = validateTurnIntent({
        actions: [{ domain: 'calendar', action: 'connect' }],
      });
      expect(connectResult.valid).toBe(true);

      const createResult = validateTurnIntent({
        actions: [{
          domain: 'calendar',
          action: 'create',
          title: 'Reunión con Inversionistas',
          schedule: { kind: 'relative_day_time', dayOffset: 1, hour: 10, minute: 0 },
        }],
      });
      expect(createResult.valid).toBe(true);
    });
  });

  describe('dual persistence companion reminders and lifecycle cascade', () => {
    it('create_event links WhatsApp reminder with deliveryId=gcal:id and renders unified card', async () => {
      vi.spyOn(dbIntegrations, 'getUserIntegration').mockResolvedValue({
        access_token: 'valid_token',
        account_email: 'test@example.com',
      });
      const createEventSpy = vi.spyOn(googleCalendar, 'createCalendarEvent').mockResolvedValue({
        id: 'evt-test-dual-123',
        summary: 'Cita médica',
        startDateTime: '2099-10-15T16:00:00-05:00',
        endDateTime: '2099-10-15T17:00:00-05:00',
      });
      const saveReminderSpy = vi.spyOn(dbIndex, 'saveReminder').mockResolvedValue({
        id: 'rem-dual-1',
        content: '🔔 [Google Calendar] Cita médica en 30 minutos',
        send_at: '2099-10-15T15:30:00.000Z',
      });

      const res = await executeCalendarTool({
        action: 'create_event',
        params: {
          summary: 'Cita médica',
          startDateTime: '2099-10-15T16:00:00-05:00',
          advanceMinutes: 30,
        },
        user: { id: 'u-dual-1', phone_number: '+573001112233', timezone: 'America/Bogota' },
        language: 'es',
      });

      expect(res.success).toBe(true);
      expect(saveReminderSpy).toHaveBeenCalledWith(expect.objectContaining({
        deliveryId: 'gcal:evt-test-dual-123',
        content: expect.stringContaining('Cita médica'),
      }));
      expect(res.data.reminderCreated).toBe(true);
      expect(res.formattedCard).toContain('Evento agendado en Google Calendar');
      expect(res.formattedCard).toContain('Recordatorio programado en WhatsApp');
      expect(res.formattedCard).toContain('30 minutos antes');

      createEventSpy.mockRestore();
      saveReminderSpy.mockRestore();
      vi.restoreAllMocks();
    });

    it('delete_event cascades cancellation to companion reminders and renders cancellation fact', async () => {
      vi.spyOn(dbIntegrations, 'getUserIntegration').mockResolvedValue({
        access_token: 'valid_token',
        account_email: 'test@example.com',
      });
      const listEventsSpy = vi.spyOn(googleCalendar, 'listCalendarEvents').mockResolvedValue([
        { id: 'evt-to-delete', summary: 'Cita médica' },
      ]);
      const deleteEventSpy = vi.spyOn(googleCalendar, 'deleteCalendarEvent').mockResolvedValue(true);
      const cancelCompanionSpy = vi.spyOn(dbIndex, 'cancelCalendarCompanionReminders').mockResolvedValue({ cancelled: 1 });

      const res = await executeCalendarTool({
        action: 'delete_event',
        params: { target: 'Cita médica' },
        user: { id: 'u-dual-1', phone_number: '+573001112233', timezone: 'America/Bogota' },
        language: 'es',
      });

      expect(res.success).toBe(true);
      expect(deleteEventSpy).toHaveBeenCalled();
      expect(cancelCompanionSpy).toHaveBeenCalled();
      expect(res.formattedCard).toContain('Evento eliminado');
      expect(res.formattedCard).toContain('Recordatorio de WhatsApp asociado cancelado');

      listEventsSpy.mockRestore();
      deleteEventSpy.mockRestore();
      cancelCompanionSpy.mockRestore();
      vi.restoreAllMocks();
    });

    it('update_event cascades reschedule to companion reminders when start time shifts', async () => {
      vi.spyOn(dbIntegrations, 'getUserIntegration').mockResolvedValue({
        access_token: 'valid_token',
        account_email: 'test@example.com',
      });
      const listEventsSpy = vi.spyOn(googleCalendar, 'listCalendarEvents').mockResolvedValue([
        { id: 'evt-to-update', summary: 'Cita médica' },
      ]);
      const updateEventSpy = vi.spyOn(googleCalendar, 'updateCalendarEvent').mockResolvedValue({
        id: 'evt-to-update',
        summary: 'Cita médica reprogramada',
        startDateTime: '2099-10-15T17:00:00-05:00',
      });
      const rescheduleCompanionSpy = vi.spyOn(dbIndex, 'rescheduleCalendarCompanionReminders').mockResolvedValue({
        rescheduled: 1,
        newSendAt: '2099-10-15T16:30:00.000Z',
      });

      const res = await executeCalendarTool({
        action: 'update_event',
        params: {
          target: 'Cita médica',
          startDateTime: '2099-10-15T17:00:00-05:00',
          summary: 'Cita médica reprogramada',
        },
        user: { id: 'u-dual-1', phone_number: '+573001112233', timezone: 'America/Bogota' },
        language: 'es',
      });

      expect(res.success).toBe(true);
      expect(updateEventSpy).toHaveBeenCalled();
      expect(rescheduleCompanionSpy).toHaveBeenCalled();
      expect(res.formattedCard).toContain('Evento actualizado');
      expect(res.formattedCard).toContain('Recordatorio en WhatsApp reprogramado');

      listEventsSpy.mockRestore();
      updateEventSpy.mockRestore();
      rescheduleCompanionSpy.mockRestore();
      vi.restoreAllMocks();
    });

    it('search_events with temporal query sanitizes q to null and queries tomorrow window', async () => {
      vi.spyOn(dbIntegrations, 'getUserIntegration').mockResolvedValue({
        access_token: 'valid_token',
        account_email: 'test@example.com',
      });
      let capturedParams = null;
      const listEventsSpy = vi.spyOn(googleCalendar, 'listCalendarEvents').mockImplementation(async (userId, params) => {
        capturedParams = params;
        return [
          {
            id: 'evt-ccs-daily',
            summary: 'CCS Daily interna',
            start: { dateTime: '2026-09-17T09:00:00-05:00' },
            end: { dateTime: '2026-09-17T09:30:00-05:00' },
          },
        ];
      });

      const res = await executeCalendarTool({
        action: 'search_events',
        params: { query: 'reuniones mañana' },
        user: { id: 'u-juan', phone_number: '+573046154163', timezone: 'America/Bogota' },
        language: 'es',
      });

      expect(res.success).toBe(true);
      expect(capturedParams).not.toBeNull();
      expect(capturedParams.q).toBeNull();
      expect(res.rawSummary).toContain('CCS Daily interna');
      listEventsSpy.mockRestore();
      vi.restoreAllMocks();
    });
  });
});
