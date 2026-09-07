import 'dotenv/config';
import { describe, it, expect, vi } from 'vitest';
import { resolveCalendarTemporalScope } from '../../../src/shared/time.js';
import { generateDeterministicCalendarEventId } from '../../../src/integrations/google/calendar.js';
import { normalizeCalendarEvent, formatCalendarEventLine, executeCalendarTool } from '../../../src/agent/tools/calendar.js';
import { buildAgentCorePrompt } from '../../../src/agent/core/agent-core.js';
import { getIntentToolDefinitions } from '../../../src/agent/contracts/intent-contracts.js';
import { getGoogleRedirectUri, hasUsableGoogleCredentials, isGoogleAuthError } from '../../../src/integrations/google/auth.js';
import { formatCanonicalAgenda } from '../../../src/shared/agenda-presentation.js';
import { formatMorningBriefingMessage } from '../../../src/jobs/morning-briefing.js';
import * as dbIntegrations from '../../../src/infrastructure/database/integrations.js';

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
  });

  describe('current TurnIntent and presentation boundaries', () => {
    it('exposes one semantic execute_turn contract rather than legacy tool contracts', () => {
      const definitions = getIntentToolDefinitions();
      expect(definitions).toHaveLength(1);
      expect(definitions[0].function.name).toBe('execute_turn');
      const actionProps = definitions[0].function.parameters.properties.actions.items.properties;
      expect(actionProps.domain.enum).toContain('calendar');
      expect(actionProps.action).toBeDefined();
      expect(actionProps.target.description).toContain('Never an internal ID');
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
  });
});
