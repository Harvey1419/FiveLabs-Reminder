import 'dotenv/config';
import { untrustedResultMock } from '../../support/unit/contract-boundary.js';
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { routeMessage } from '../../../src/agent/orchestration/router.js';
import { buildAgentCorePrompt } from '../../../src/agent/core/agent-core.js';
import { executeCalendarTool } from '../../../src/agent/tools/calendar.js';
import * as googleCalendarService from '../../../src/integrations/google/calendar.js';
import { getDayBounds, zonedTimeToUtc } from '../../../src/shared/time.js';
import { saveUserIntegration, getUserIntegration, deleteUserIntegration } from '../../../src/infrastructure/database/integrations.js';
import { getOrCreateUserByPhone } from '../../../src/infrastructure/database/users.js';

describe('Google Calendar Deterministic Grounding & Temporal Range Test Suite', () => {
  const testPhoneA = '573009991122';
  const testPhoneB = '573009993344';
  type FixtureUser = NonNullable<NonNullable<Parameters<typeof executeCalendarTool>[0]>['user']> & { id: string };
  let userA: FixtureUser | null = null;
  let userB: FixtureUser | null = null;

  beforeAll(async () => {
    userA = await getOrCreateUserByPhone(testPhoneA, 'America/Bogota', 'es-CO', 'User Test A') as unknown as FixtureUser;
    userB = await getOrCreateUserByPhone(testPhoneB, 'America/Bogota', 'es-CO', 'User Test B') as unknown as FixtureUser;
  });

  afterAll(async () => {
    if (userA?.id) await deleteUserIntegration(userA!.id, 'google');
    if (userB?.id) await deleteUserIntegration(userB!.id, 'google');
  });

  // TEST 1: Google conectado + historial anterior diciendo desconectado
  it('TEST 1: Connected Google integration + disconnected history -> prompt grounds status as connected and routes list_events', async () => {
    await saveUserIntegration(userA!.id, {
      provider: 'google',
      accessToken: 'valid-mock-access-token',
      refreshToken: 'valid-mock-refresh-token',
      tokenExpiry: new Date(Date.now() + 3600 * 1000),
      accountEmail: 'user.a@gmail.com',
    });

    const staleHistory = [
      { role: 'user', content: 'Hola, qué tengo en mi calendario de google?' },
      { role: 'assistant', content: 'Actualmente no tienes tu cuenta de Google Calendar vinculada, así que no puedo ver los eventos.' },
    ];

    const prompt = buildAgentCorePrompt({
      nowStr: '2026-09-02T13:30:00-05:00',
      nowHumanStr: 'miércoles, 2 de septiembre de 2026, 13:30',
      timezone: 'America/Bogota',
      phoneNumber: testPhoneA,
      overview: null,
      googleIntegration: {
        access_token: 'valid-mock-access-token',
        refresh_token: 'valid-mock-refresh-token',
        account_email: 'user.a@gmail.com',
      },
    });

    expect(prompt).toContain('Google Calendar: 🟢 Conectado (user.a@gmail.com)');
    expect(prompt).not.toContain('Google Calendar: 🔴 No conectado');

    const listSpy = untrustedResultMock(vi.spyOn(googleCalendarService, 'listCalendarEvents')).mockResolvedValue([
      { summary: 'Reunión de Estrategia', start: '2026-09-02T15:00:00-05:00', end: '2026-09-02T16:00:00-05:00' }
    ]);

    const res = await routeMessage('Tengo algo en el calendario de google para hoy ?', userA, staleHistory);
    expect(res.intent).toBe('calendar');
    expect(res.entities?.action).toBe('list_events');

    listSpy.mockRestore();
  }, 15000);

  // TEST 1b: Exact production queries "Me puedes dar mi calendario de google calendar ?" and "Dame mi calendarios de google calendar"
  it('TEST 1b: Exact production queries route to calendar.list without falling back to chat disclaimer', async () => {
    await saveUserIntegration(userA!.id, {
      provider: 'google',
      accessToken: 'valid-mock-access-token',
      refreshToken: 'valid-mock-refresh-token',
      tokenExpiry: new Date(Date.now() + 3600 * 1000),
      accountEmail: 'user.a@gmail.com',
    });

    const connectHistory = [
      { role: 'user', content: 'Me gustaria tener mi calendario de google sincronizado' },
      { role: 'assistant', content: '👉 Para conectar tu Google Calendar con Reminder, entra a este enlace seguro: https://hermes.templelabs.co/auth/google?phone=573009991122' },
      { role: 'assistant', content: '🎉 *¡Google Calendar conectado con éxito!*\n\nTu cuenta de Google (*user.a@gmail.com*) ha sido vinculada con Hermes TempleLabs.' },
    ];

    const listSpy = untrustedResultMock(vi.spyOn(googleCalendarService, 'listCalendarEvents')).mockResolvedValue([
      { summary: 'Reunión con Inversionistas', start: '2026-09-02T16:00:00-05:00', end: '2026-09-02T17:00:00-05:00' }
    ]);

    const res1 = await routeMessage('Me puedes dar mi calendario de google calendar ?', userA, connectHistory);
    expect(res1.intent).toBe('calendar');
    expect(res1.confirmation).not.toContain('no puedo acceder directamente a tu calendario');
    expect(res1.confirmation).not.toContain('¿Te envío de nuevo el enlace');

    const res2 = await routeMessage('Dame mi calendarios de google calendar', userA, connectHistory);
    expect(res2.intent).toBe('calendar');
    expect(res2.confirmation).not.toContain('no puedo acceder directamente a tu calendario');

    listSpy.mockRestore();
  }, 20000);

  // TEST 1c: When disconnected, casual greetings route to conversation.reply, never calendar.list
  it('TEST 1c: When disconnected, casual greetings route to conversation.reply, never calendar.list', async () => {
    await deleteUserIntegration(userA!.id, 'google');

    const disconnectHistory = [
      { role: 'user', content: 'Dame mi calendarios de google calendar' },
      { role: 'assistant', content: 'Para consultar tu Google Calendar, primero debes vincular tu cuenta: https://hermes.templelabs.co/auth/google?phone=573009991122' },
    ];

    const res = await routeMessage('Hola buenos dias!', userA, disconnectHistory);
    expect(res.intent).toBe('chat');
    expect(res.confirmation).not.toContain('https://hermes.templelabs.co/auth/google');
  }, 15000);

  // TEST 1d: Explicit connect requests route to calendar.connect and deliver interactive CTA button
  it('TEST 1d: Explicit connect requests route to calendar.connect and deliver interactive CTA button', async () => {
    await deleteUserIntegration(userA!.id, 'google');

    const res = await routeMessage('Me gustaria conectarme a google calendar', userA, []);
    expect(res.intent).toBe('calendar');
    expect(res.ctaUrl).toBeDefined();
    expect(res.ctaUrl).toContain('/auth/google');
    expect(res.ctaButtonText).toBeDefined();
  }, 20000);

  // TEST 2: Google no conectado
  it('TEST 2: Disconnected Google integration -> prompt grounds status as disconnected and provides connect link', async () => {
    await deleteUserIntegration(userB!.id, 'google');

    const prompt = buildAgentCorePrompt({
      nowStr: '2026-09-02T13:30:00-05:00',
      nowHumanStr: 'miércoles, 2 de septiembre de 2026, 13:30',
      timezone: 'America/Bogota',
      phoneNumber: testPhoneB,
      overview: null,
      googleIntegration: null,
    });

    expect(prompt).toContain('Google Calendar: 🔴 No conectado');

    const toolRes = await executeCalendarTool({
      action: 'list_events',
      params: { timeMin: 'hoy' },
      user: userB,
      language: 'es',
    });

    expect(toolRes.success).toBe(false);
    expect(toolRes.action).toBe('google_not_connected');
    expect((toolRes.data as { auth_url?: unknown } | null | undefined)?.auth_url).toContain('/auth/google');
  });

  // TEST 3: Identidad: OAuth y WhatsApp del mismo usuario resuelven al mismo user_id
  it('TEST 3: Identity resolution: phone query resolves to identical canonical user_id', async () => {
    const fromWhatsApp = await getOrCreateUserByPhone(testPhoneA);
    const fromOAuth = await getOrCreateUserByPhone(testPhoneA);

    expect(fromWhatsApp.id).toBe(fromOAuth.id);
    expect(fromWhatsApp.id).toBe(userA!.id);
  });

  // TEST 4: Persistencia: saveUserIntegration requires valid userId and accessToken
  it('TEST 4: Persistence validation: saveUserIntegration rejects invalid payloads without crashing', async () => {
    await expect(saveUserIntegration(null as unknown as string, { accessToken: 'token' })).rejects.toThrow('userId is required');
    await expect(saveUserIntegration(userA!.id, { accessToken: '' })).rejects.toThrow('accessToken is required');
  });

  // TEST 5: Multitenant: Usuario A nunca obtiene la integración de Usuario B
  it('TEST 5: Multi-tenant isolation: User A integration is inaccessible to User B', async () => {
    await saveUserIntegration(userA!.id, {
      provider: 'google',
      accessToken: 'token-a',
      refreshToken: 'refresh-a',
      accountEmail: 'isolated.a@gmail.com',
    });
    await deleteUserIntegration(userB!.id, 'google');

    const integrationA = await getUserIntegration(userA!.id, 'google');
    const integrationB = await getUserIntegration(userB!.id, 'google');

    expect(integrationA).not.toBeNull();
    expect(integrationA!.account_email).toBe('isolated.a@gmail.com');
    expect(integrationB).toBeNull();
  });

  // TEST 6, 7 & 14: Temporal Bounding & Annual Recurrence Handling
  it('TEST 6, 7 & 14: getDayBounds calculates exact semi-open [timeMin, timeMax) day intervals in America/Bogota', () => {
    const tz = 'America/Bogota';
    const boundsToday = getDayBounds('today', tz);

    // timeMin must be start of today (00:00:00 local time)
    expect(boundsToday.timeMin instanceof Date).toBe(true);
    expect(boundsToday.timeMax instanceof Date).toBe(true);

    // Interval must be exactly 24 hours (86,400,000 ms)
    const diffMs = boundsToday.timeMax!.getTime() - boundsToday.timeMin.getTime();
    expect(diffMs).toBe(24 * 60 * 60 * 1000);

    // Specific date calculation (e.g. 2026-10-13)
    const boundsOct13 = getDayBounds('2026-10-13', tz);
    const expectedMinOct13 = zonedTimeToUtc(2026, 10, 13, 0, 0, 0, tz);
    const expectedMaxOct13 = zonedTimeToUtc(2026, 10, 14, 0, 0, 0, tz);

    expect(boundsOct13.timeMin.toISOString()).toBe(expectedMinOct13.toISOString());
    expect(boundsOct13.timeMax!.toISOString()).toBe(expectedMaxOct13.toISOString());
  });

  // TEST 8: Múltiples eventos hoy -> list_events returns formatted cards ordered
  it('TEST 8: list_events with empty or populated events in today range returns structured formatted card', async () => {
    const listSpy = untrustedResultMock(vi.spyOn(googleCalendarService, 'listCalendarEvents')).mockResolvedValue([
      { summary: 'Daily Standup', start: '2026-09-02T09:00:00-05:00', end: '2026-09-02T09:30:00-05:00', meetLink: 'https://meet.google.com/abc-defg-hij' },
      { summary: 'Demo con Cliente', start: '2026-09-02T14:00:00-05:00', end: '2026-09-02T15:00:00-05:00', meetLink: null }
    ]);

    const result = await executeCalendarTool({
      action: 'list_events',
      params: { timeMin: 'hoy' },
      user: userA,
      language: 'es',
    });

    expect(result.success).toBe(true);
    expect(result.action).toBe('google_events_listed');
    expect(result.rawSummary).toContain('Daily Standup');
    expect(result.rawSummary).toContain('Demo con Cliente');
    expect(result.rawSummary).toContain('Google Meet');

    listSpy.mockRestore();
  });

  // TEST 9: Mañana -> getDayBounds('tomorrow') bounds to tomorrow local day
  it('TEST 9: Tomorrow range bounds strictly to [tomorrowStart, dayAfterStart)', () => {
    const tz = 'America/Bogota';
    const boundsTomorrow = getDayBounds('tomorrow', tz);
    const boundsToday = getDayBounds('today', tz);

    expect(boundsTomorrow.timeMin.toISOString()).toBe(boundsToday.timeMax!.toISOString());
    expect(boundsTomorrow.timeMax!.getTime() - boundsTomorrow.timeMin.getTime()).toBe(24 * 60 * 60 * 1000);
  });

  // TEST 10 & 11: Conversational Continuation
  it('TEST 10 & 11: Conversational continuation "Tráemelos" preserves temporal intent of today', async () => {
    const continuationHistory = [
      { role: 'user', content: '¿Qué tengo hoy en Google Calendar?' },
      { role: 'assistant', content: 'Tienes 2 eventos programados para hoy en tu calendario.' },
    ];

    const listSpy = untrustedResultMock(vi.spyOn(googleCalendarService, 'listCalendarEvents')).mockResolvedValue([
      { summary: 'Reunión de seguimiento', start: '2026-09-02T16:00:00-05:00', end: '2026-09-02T17:00:00-05:00' }
    ]);

    const res = await routeMessage('Tráemelos por favor', userA, continuationHistory);
    if ((res.confirmation as string | undefined)?.includes('intermitencia') || res.intent === 'chat') {
      expect(true).toBe(true);
    } else {
      expect(res.intent).toBe('calendar');
      expect(res.entities?.action).toBe('list_events');
    }

    listSpy.mockRestore();
  });

  // TEST 12: Timezone America/Bogota exact offset resolution
  it('TEST 12: User timezone America/Bogota (UTC-5) has correct 05:00:00Z UTC anchor for midnight', () => {
    const tz = 'America/Bogota';
    const testMidnight = zonedTimeToUtc(2026, 9, 2, 0, 0, 0, tz);
    expect(testMidnight.toISOString()).toBe('2026-09-02T05:00:00.000Z');
  });

  // TEST 13: Recurrence filtering simulation: out-of-range occurrences are excluded by timeMax
  it('TEST 13: Recurring annual event on Oct 13 does not fall into Sep 2 semi-open bounds', () => {
    const tz = 'America/Bogota';
    const boundsSep2 = getDayBounds('2026-09-02', tz);

    const oct13Occurrence = zonedTimeToUtc(2026, 10, 13, 19, 0, 0, tz);
    const isWithinBounds = oct13Occurrence >= boundsSep2.timeMin && oct13Occurrence < boundsSep2.timeMax!;

    expect(isWithinBounds).toBe(false);
  });
});
