import 'dotenv/config';
import { finalSafetyMessage } from '../../fixtures/agent/behavioral-final-safety-fixtures.js';
import { taskCalendarMutationMessage } from '../../fixtures/agent/behavioral-task-calendar-mutation-fixtures.js';
import { noticeWeekdayMessage } from '../../fixtures/agent/behavioral-notice-weekday-fixtures.js';
import { reminderDateMessage } from '../../fixtures/agent/behavioral-reminder-date-fixtures.js';
import { activeNoticeMessage } from '../../fixtures/agent/behavioral-active-notice-fixtures.js';
import { datedCalendarRenameMessage } from '../../fixtures/agent/behavioral-calendar-lookup-fixture.js';
import { behavioralCalendarDeliveryMessage } from '../../fixtures/agent/behavioral-calendar-delivery-fixtures.js';
import { behavioralContinuityMessage, earliestReminderObservationMessage, observedReadPayload } from '../../fixtures/agent/behavioral-continuity-fixtures.js';
import { behavioralFollowupMessage } from '../../fixtures/agent/behavioral-followup-fixtures.js';
import { behavioralReadMessage } from '../../fixtures/agent/behavioral-read-fixtures.js';
import { formatCanonicalAgenda } from '../../../src/shared/agenda-presentation.js';
import { untrustedResultMock } from '../../support/unit/contract-boundary.js';
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { routeMessage } from '../../../src/agent/orchestration/router.js';
import { executeTool } from '../../../src/agent/tools/index.js';
import { getUnifiedAgenda } from '../../../src/features/agenda/service.js';
import { saveWorkingMemory, getWorkingMemory, clearWorkingMemory, sanitizeResponseText } from '../../../src/agent/core/working-memory.js';
import {
  getOrCreateUserByPhone,
  saveReminder,
  getRemindersByPhone,
  markReminderAsCancelled,
  createTask,
  getTasks,
  deleteTask,
  saveUserIntegration,
  deleteUserIntegration,
  supabase,
} from '../../../src/infrastructure/database/index.js';
import * as googleCalendarService from '../../../src/integrations/google/calendar.js';
import * as aiClient from '../../../src/agent/providers/client.js';

type FixtureRow = { id: string; title: string; content: string; send_at: string; lock_until: string; status: string; name: string; metadata: Record<string, unknown>; [key: string]: unknown };
type FixtureQuery = PromiseLike<{ data: FixtureRow[] | null; error: { message?: string } | null; count?: number | null }> & {
  select(columns?: string, options?: { count: 'exact'; head: boolean }): FixtureQuery;
  eq(column: string, value: unknown): FixtureQuery; or(filter: string): FixtureQuery;
  ilike(column: string, pattern: string): FixtureQuery;
  insert(row: unknown): FixtureQuery; delete(): FixtureQuery;
  single(): PromiseLike<{ data: FixtureRow | null; error: unknown }>;
  maybeSingle(): PromiseLike<{ data: FixtureRow | null; error: unknown }>;
};
type FixtureClient = { from(table: string): FixtureQuery };
type FixtureUser = NonNullable<Parameters<typeof executeTool>[2]> & { id: string; phone_number: string; timezone: string; isPro?: boolean };
type FixtureRoute = { executionFacts?: { errorCode?: string }[]; confirmation: string; intent?: string; entities?: Record<string, unknown> };

describe('Agent Behavioral Contract & End-to-End Orchestration Test Suite', () => {
  const testPhone = '573990001122';
  let testUser: FixtureUser | null = null;

  beforeAll(async () => {
    testUser = await getOrCreateUserByPhone(testPhone, 'America/Bogota', 'es-CO', 'Behavioral Test User') as unknown as FixtureUser;
  });

  beforeEach(async () => {
    vi.restoreAllMocks();
    clearWorkingMemory(testPhone);
    clearWorkingMemory(testUser!.id);
    if (testUser?.id) {
      await (supabase as unknown as FixtureClient).from('reminders').delete().or(`user_id.eq.${testUser!.id},phone_number.eq.${testPhone}`);
      await (supabase as unknown as FixtureClient).from('tasks').delete().eq('user_id', testUser!.id);
      await (supabase as unknown as FixtureClient).from('memories').delete().eq('user_id', testUser!.id).eq('topic_key', 'profile/behavioral_fixture_birthday');
    }
  });

  afterAll(async () => {
    if (testUser?.id) {
      await deleteUserIntegration(testUser!.id, 'google');
      await (supabase as unknown as FixtureClient).from('reminders').delete().or(`user_id.eq.${testUser!.id},phone_number.eq.${testPhone}`);
      await (supabase as unknown as FixtureClient).from('tasks').delete().eq('user_id', testUser!.id);
      await (supabase as unknown as FixtureClient).from('memories').delete().eq('user_id', testUser!.id).eq('topic_key', 'profile/behavioral_fixture_birthday');
    }
  });

  afterEach(() => vi.useRealTimers());

  function pinReadFixtureDate() {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-09-02T17:00:00.000Z'));
  }

  // TEST 1: Unified Agenda selection for temporal question
  it('TEST 1: "¿Qué tengo mañana?" selects Unified Agenda and aggregates Calendar + Reminder + Task', async () => {
    pinReadFixtureDate();
    await saveUserIntegration(testUser!.id, {
      provider: 'google',
      accessToken: 'valid-mock-token',
      refreshToken: 'valid-mock-refresh',
      accountEmail: 'behavioral@gmail.com',
    });

    const listEventsSpy = untrustedResultMock(vi.spyOn(googleCalendarService, 'listCalendarEvents')).mockResolvedValue([
      { id: 'behavior-calendar-medical', summary: 'Cita Médica Dr. Pérez', start: '2026-09-03T08:00:00-05:00', end: '2026-09-03T09:00:00-05:00' },
    ]);

    const tomorrowDate = new Date('2026-09-03T15:00:00.000Z');

    await saveReminder({
      userId: testUser!.id,
      phoneNumber: testPhone,
      content: 'Tomar pastilla para la tensión',
      sendAt: tomorrowDate.toISOString(),
      requiresConfirmation: true,
    }) as unknown as FixtureRow;

    await createTask({
      userId: testUser!.id,
      title: 'Enviar reporte mensual de ventas',
      dueDate: tomorrowDate.toISOString(),
      priority: 'high',
    }) as unknown as FixtureRow;

    untrustedResultMock(vi.spyOn(aiClient, 'callChatCompletion')).mockResolvedValue(behavioralReadMessage('agendaTomorrow'));

    const res = await routeMessage('¿Qué tengo mañana?', testUser) as unknown as FixtureRoute;

    expect(res.intent).toBe('unified_agenda');
    expect(res.confirmation).toContain('Google Calendar');
    expect(res.confirmation).toContain('Cita Médica Dr. Pérez');
    expect(res.confirmation).toContain('Recordatorios');
    expect(res.confirmation).toContain('Tomar pastilla para la tensión');
    expect(res.confirmation).toContain('Tareas');
    expect(res.confirmation).toContain('Enviar reporte mensual de ventas');

    const wm = getWorkingMemory(testUser);
    expect(wm).not.toBeNull();
    expect(wm!.source).toBe('unified');
    expect(wm!.items.length).toBeGreaterThanOrEqual(2);

    listEventsSpy.mockRestore();
  });

  // TEST 2: Explicit Google Calendar query
  it('TEST 2: "¿Qué tengo en Google Calendar mañana?" selects Calendar tool, NOT Unified Agenda', async () => {
    pinReadFixtureDate();
    await saveUserIntegration(testUser!.id, {
      provider: 'google',
      accessToken: 'valid-mock-token',
      refreshToken: 'valid-mock-refresh',
      accountEmail: 'behavioral@gmail.com',
    });

    const listEventsSpy = untrustedResultMock(vi.spyOn(googleCalendarService, 'listCalendarEvents')).mockResolvedValue([
      { id: 'behavior-calendar-board', summary: 'Reunión de Directorio', start: '2026-09-03T14:00:00-05:00', end: '2026-09-03T15:00:00-05:00' },
    ]);

    untrustedResultMock(vi.spyOn(aiClient, 'callChatCompletion')).mockResolvedValue(behavioralReadMessage('calendarTomorrow'));

    const res = await routeMessage('¿Qué tengo en Google Calendar mañana?', testUser) as unknown as FixtureRoute;

    expect(res.intent).toBe('calendar');
    expect(res.entities?.action).toBe('list_events');
    expect(res.confirmation).toContain('Reunión de Directorio');

    listEventsSpy.mockRestore();
  });

  // TEST 3: Explicit Reminders query
  it('TEST 3: "¿Qué recordatorios tengo?" routes to manage_reminder list', async () => {
    pinReadFixtureDate();
    const tomorrowDate = new Date('2026-09-03T17:00:00.000Z');
    await saveReminder({
      userId: testUser!.id,
      phoneNumber: testPhone,
      content: 'Comprar alimento para Borona',
      sendAt: tomorrowDate.toISOString(),
    }) as unknown as FixtureRow;

    untrustedResultMock(vi.spyOn(aiClient, 'callChatCompletion')).mockResolvedValue(behavioralReadMessage('reminderList'));

    const res = await routeMessage('¿Qué recordatorios tengo?', testUser) as unknown as FixtureRoute;

    expect(res.intent).toBe('reminder');
    expect(res.confirmation).toContain('Comprar alimento para Borona');
  });

  // TEST 4: Explicit Tasks query
  it('TEST 4: "¿Cuáles son mis tareas?" routes to manage_task list', async () => {
    pinReadFixtureDate();
    await createTask({
      userId: testUser!.id,
      title: 'Revisar métricas del sprint',
      priority: 'urgent',
    }) as unknown as FixtureRow;

    untrustedResultMock(vi.spyOn(aiClient, 'callChatCompletion')).mockResolvedValue(behavioralReadMessage('taskList'));

    const res = await routeMessage('¿Cuáles son mis tareas?', testUser) as unknown as FixtureRoute;

    expect(res.intent).toBe('task');
    expect(res.confirmation).toContain('Revisar métricas del sprint');
  });

  // TEST 5: Birthday filter in Google Calendar
  it('TEST 5: "¿Qué cumpleaños tengo en Google Calendar?" routes to Calendar search with birthday filter', async () => {
    pinReadFixtureDate();
    await saveUserIntegration(testUser!.id, {
      provider: 'google',
      accessToken: 'valid-mock-token',
      refreshToken: 'valid-mock-refresh',
      accountEmail: 'behavioral@gmail.com',
    });

    const searchEventsSpy = untrustedResultMock(vi.spyOn(googleCalendarService, 'listCalendarEvents')).mockResolvedValue([
      { id: 'behavior-calendar-birthday', summary: 'Cumpleaños de Valentina', start: '2026-10-15', end: '2026-10-16' },
    ]);

    untrustedResultMock(vi.spyOn(aiClient, 'callChatCompletion')).mockResolvedValue(behavioralFollowupMessage('calendarBirthdays'));

    const res = await routeMessage('¿Qué cumpleaños tengo en Google Calendar?', testUser) as unknown as FixtureRoute;

    expect(res.intent).toBe('calendar');
    expect(res.entities?.action).toBe('search_events');
    expect(res.confirmation).toContain('Cumpleaños de Valentina');
    expect(res.entities?.query).toMatch(/cumpleaños|birthday/i);

    searchEventsSpy.mockRestore();
  });

  // TEST 6: Memory query
  it('TEST 6: "¿Qué sabes de mi cumpleaños?" queries persistent memory', async () => {
    pinReadFixtureDate();
    const { data: seededMemory, error: seedError } = await (supabase as unknown as FixtureClient)
      .from('memories').insert({
        user_id: testUser!.id, topic_key: 'profile/behavioral_fixture_birthday',
        category: 'fact', content: 'Mi cumpleaños es el 14 de octubre.',
        is_active: true, confidence: 1,
      }).select('id, content').single();
    expect(seedError).toBeNull();
    expect(seededMemory?.id).toBeTruthy();

    untrustedResultMock(vi.spyOn(aiClient, 'callChatCompletion')).mockResolvedValue(behavioralFollowupMessage('memoryInventory'));

    const res = await routeMessage('¿Qué sabes de mi cumpleaños?', testUser) as unknown as FixtureRoute;

    expect(res.intent).toBe('memory');
    expect(res.entities?.action).toBe('list');
    expect(res.confirmation).toContain('14 de octubre');
  });

  // TEST 7: Acknowledge with semantic variation mutates DB
  it('TEST 7: "Ya hablé con la veterinaria" acknowledges reminder and updates acknowledged_at in DB', async () => {
    pinReadFixtureDate();
    const saved = await saveReminder({
      userId: testUser!.id,
      phoneNumber: testPhone,
      content: 'Escribirle a la veterinaria para comprar más vendaje a Borona',
      sendAt: new Date().toISOString(),
      requiresConfirmation: true,
    }) as unknown as FixtureRow;

    untrustedResultMock(vi.spyOn(aiClient, 'callChatCompletion')).mockResolvedValue(behavioralFollowupMessage('acknowledgeVeterinary'));

    const res = await routeMessage('Ya hablé con la veterinaria.', testUser) as unknown as FixtureRoute;

    expect(res.intent).toBe('reminder');
    expect(res.confirmation).toMatch(/confirmado/i);

    const { data: updatedRem } = await (supabase as unknown as FixtureClient).from('reminders').select('*').eq('id', saved.id).single();
    expect(updatedRem!.acknowledged_at).not.toBeNull();
  });

  // TEST 8: Linguistic variations for Acknowledge
  it('TEST 8: Linguistic variations ("Ya le escribí", "Ya compré el vendaje") acknowledge correctly', async () => {
    pinReadFixtureDate();
    const saved = await saveReminder({
      userId: testUser!.id,
      phoneNumber: testPhone,
      content: 'Comprar más vendaje a Borona en la droguería',
      sendAt: new Date().toISOString(),
      requiresConfirmation: true,
    }) as unknown as FixtureRow;

    untrustedResultMock(vi.spyOn(aiClient, 'callChatCompletion')).mockResolvedValue(behavioralFollowupMessage('acknowledgeBandage'));

    const res = await routeMessage('Ya compré el vendaje para Borona', testUser) as unknown as FixtureRoute;

    expect(res.intent).toBe('reminder');
    expect(res.confirmation).toMatch(/confirmado/i);

    const { data: updatedRem } = await (supabase as unknown as FixtureClient).from('reminders').select('*').eq('id', saved.id).single();
    expect(updatedRem!.acknowledged_at).not.toBeNull();
  });

  // TEST 9: Ambiguous candidates -> asks clarification, ZERO database mutations
  it('TEST 9: Multiple ambiguous reminders trigger clarification question and DO NOT mutate DB', async () => {
    pinReadFixtureDate();
    const rem1 = await saveReminder({
      userId: testUser!.id,
      phoneNumber: testPhone,
      content: 'Llamar a la doctora María para la cita de control',
      sendAt: new Date().toISOString(),
      requiresConfirmation: true,
    }) as unknown as FixtureRow;

    const rem2 = await saveReminder({
      userId: testUser!.id,
      phoneNumber: testPhone,
      content: 'Llamar a la doctora Marcela para los exámenes',
      sendAt: new Date().toISOString(),
      requiresConfirmation: true,
    }) as unknown as FixtureRow;

    untrustedResultMock(vi.spyOn(aiClient, 'callChatCompletion')).mockResolvedValue(behavioralFollowupMessage('ambiguousDoctor'));

    const res = await routeMessage('Ya llamé a la doctora', testUser) as unknown as FixtureRoute;

    expect(res.confirmation).toMatch(/varios recordatorios|más de un recordatorio|múltiples recordatorios|aclara cuál|especifica/i);

    // Verify ZERO mutations in DB
    const { data: r1 } = await (supabase as unknown as FixtureClient).from('reminders').select('*').eq('id', rem1.id).single();
    const { data: r2 } = await (supabase as unknown as FixtureClient).from('reminders').select('*').eq('id', rem2.id).single();
    expect(r1!.acknowledged_at).toBeNull();
    expect(r2!.acknowledged_at).toBeNull();
  });

  // TEST 10: Calendar disconnected preserves Reminder and Task
  it('TEST 10: Disconnected Calendar retains Reminders and Tasks in Unified Agenda', async () => {
    pinReadFixtureDate();
    await deleteUserIntegration(testUser!.id, 'google');

    const tomorrowDate = new Date('2026-09-03T14:00:00.000Z');

    await saveReminder({
      userId: testUser!.id,
      phoneNumber: testPhone,
      content: 'Tomar vitamina C',
      sendAt: tomorrowDate.toISOString(),
    }) as unknown as FixtureRow;

    await createTask({
      userId: testUser!.id,
      title: 'Pagar factura de internet',
      dueDate: tomorrowDate.toISOString(),
    }) as unknown as FixtureRow;

    untrustedResultMock(vi.spyOn(aiClient, 'callChatCompletion')).mockResolvedValue(behavioralReadMessage('agendaTomorrow'));

    const res = await routeMessage('¿Qué tengo mañana?', testUser) as unknown as FixtureRoute;

    expect(res.intent).toBe('unified_agenda');
    expect(res.confirmation).toContain('Tomar vitamina C');
    expect(res.confirmation).toContain('Pagar factura de internet');
    expect(res.confirmation).not.toMatch(/No tienes eventos.*ni tareas/i);
  });

  // TEST 11: Calendar error does NOT mean empty agenda
  it('TEST 11: Calendar error is handled gracefully and preserves available Reminders and Tasks', async () => {
    pinReadFixtureDate();
    await saveUserIntegration(testUser!.id, {
      provider: 'google',
      accessToken: 'bad-token',
      refreshToken: 'bad-refresh',
      accountEmail: 'error@gmail.com',
    });

    const listEventsSpy = untrustedResultMock(vi.spyOn(googleCalendarService, 'listCalendarEvents')).mockRejectedValue(new Error('Google API 503 Service Unavailable'));

    const tomorrowDate = new Date('2026-09-03T14:00:00.000Z');

    await saveReminder({
      userId: testUser!.id,
      phoneNumber: testPhone,
      content: 'Revisar correo urgente',
      sendAt: tomorrowDate.toISOString(),
    }) as unknown as FixtureRow;

    await createTask({
      userId: testUser!.id, title: 'Pagar factura de internet',
      dueDate: tomorrowDate.toISOString(),
    });

    const agenda = await getUnifiedAgenda({
      userId: testUser!.id,
      phoneNumber: testPhone,
      timezone: 'America/Bogota',
      scope: 'tomorrow',
    });

    expect(agenda.calendar.state).toBe('ERROR');
    expect(agenda.reminders.length).toBe(1);
    expect(agenda.tasks.length).toBe(1);
    expect(agenda.complete).toBe(false);
    const card = formatCanonicalAgenda(agenda, { language: 'es', timezone: 'America/Bogota' });
    expect(card).toContain('Revisar correo urgente');
    expect(card).toContain('Pagar factura de internet');
    expect(card).toContain('Google Calendar');
    expect(card).toContain('No disponible temporalmente');

    listEventsSpy.mockRestore();
  });

  // TEST 12: Multi-turn continuation with Working Memory & Ordinal reference
  it('TEST 12: Multi-turn: T1 agenda -> T2 relative inquiry -> T3 relative mutation cancels correct item in DB', async () => {
    pinReadFixtureDate();
    await deleteUserIntegration(testUser!.id, 'google');
    const tomorrow1 = new Date('2026-09-03T13:00:00.000Z');

    const tomorrow2 = new Date('2026-09-03T16:00:00.000Z');

    const r1 = await saveReminder({
      userId: testUser!.id,
      phoneNumber: testPhone,
      content: 'Cita con el dentista a las 8am',
      sendAt: tomorrow1.toISOString(),
    }) as unknown as FixtureRow;

    const r2 = await saveReminder({
      userId: testUser!.id,
      phoneNumber: testPhone,
      content: 'Almuerzo con el cliente a las 11am',
      sendAt: tomorrow2.toISOString(),
    }) as unknown as FixtureRow;

    // Turn 1: List agenda
    untrustedResultMock(vi.spyOn(aiClient, 'callChatCompletion')).mockResolvedValueOnce(behavioralContinuityMessage('agendaTomorrow'));

    const t1Res = await routeMessage('¿Qué tengo mañana?', testUser) as unknown as FixtureRoute;
    expect(t1Res.confirmation).toContain('Cita con el dentista');

    // Turn 2: Relative question using working memory
    untrustedResultMock(vi.spyOn(aiClient, 'callChatCompletion')).mockResolvedValueOnce(behavioralContinuityMessage('earliestReminder'))
      .mockImplementationOnce(async (messages, options) => {
        expect(options?.purpose).toBe('observed_answer');
        const payload = observedReadPayload(messages);
        if (typeof payload !== 'string') throw new Error('Expected observed answer payload');
        return earliestReminderObservationMessage(payload);
      });

    const historyT2 = [
      { role: 'user', content: '¿Qué tengo mañana?' },
      { role: 'assistant', content: t1Res.confirmation },
    ];
    const t2Res = await routeMessage('¿Cuál es el más temprano?', testUser, historyT2) as unknown as FixtureRoute;
    expect(t2Res.confirmation).toContain('más temprano');
    expect(t2Res.confirmation).toContain('dentista');
    expect(getWorkingMemory(testUser)?.items[0]?.internalId).toBe(r1.id);

    // Turn 3: Relative mutation "cancela el primero"
    untrustedResultMock(vi.spyOn(aiClient, 'callChatCompletion')).mockResolvedValueOnce(behavioralContinuityMessage('cancelFirst'));

    const historyT3 = [
      ...historyT2,
      { role: 'user', content: '¿Cuál es el más temprano?' },
      { role: 'assistant', content: t2Res.confirmation },
    ];
    const t3Res = await routeMessage('Cancela el primero', testUser, historyT3) as unknown as FixtureRoute;
    expect(t3Res.confirmation).toMatch(/cancelado/i);

    // Verify DB: r1 cancelled, r2 still pending
    const { data: checkR1 } = await (supabase as unknown as FixtureClient).from('reminders').select('*').eq('id', r1.id).single();
    const { data: checkR2 } = await (supabase as unknown as FixtureClient).from('reminders').select('*').eq('id', r2.id).single();
    expect(checkR1!.status).toBe('cancelled');
    expect(checkR2!.status).toBe('pending');
  });

  // TEST 13: ID Security Rule: No internal IDs/UUIDs leaked to user
  it('TEST 13: Internal IDs, [id: ...] tags and UUIDs are NEVER exposed in user-facing confirmation', () => {
    const rawAiReply = 'Tus tareas son: [id: 79f71c4c] Comprar pan y [id: 550e8400-e29b-41d4-a716-446655440000] Enviar correo a hermes7a8f9b00112233.';
    const cleanOutput = sanitizeResponseText(rawAiReply);

    expect(cleanOutput).not.toContain('[id:');
    expect(cleanOutput).not.toContain('79f71c4c');
    expect(cleanOutput).not.toContain('550e8400-e29b-41d4-a716-446655440000');
    expect(cleanOutput).not.toContain('hermes7a8f9b00112233');
    expect(cleanOutput).toContain('Comprar pan');
    expect(cleanOutput).toContain('Enviar correo');
  });

  // TEST 14: Compound Operation (Reminder + Task in single turn)
  it('TEST 14: Compound operation creates both reminder and task without dropping intentions', async () => {
    pinReadFixtureDate();
    untrustedResultMock(vi.spyOn(aiClient, 'callChatCompletion')).mockResolvedValue(behavioralContinuityMessage('compoundCreation'));

    const res = await routeMessage('Recuérdame hoy a las 5pm llamar al banco y crea la tarea reporte de finanzas en Proyecto Alfa', testUser) as unknown as FixtureRoute;

    expect(res.confirmation).toContain('Llamar al banco');
    expect(res.confirmation).toContain('Reporte de finanzas');

    // Verify both records created in DB
    const { data: rems } = await (supabase as unknown as FixtureClient).from('reminders').select('*').eq('user_id', testUser!.id);
    const { data: tasks } = await (supabase as unknown as FixtureClient).from('tasks').select('*').eq('user_id', testUser!.id);

    expect(rems!.length).toBeGreaterThanOrEqual(1);
    expect(rems!.some(r => r.content.includes('banco') || r.content.includes('Banco'))).toBe(true);

    expect(tasks!.length).toBeGreaterThanOrEqual(1);
    expect(tasks!.some(t => t.title.includes('reporte') || t.title.includes('Reporte') || t.title.includes('finanzas'))).toBe(true);
  });

  // TEST 15 (Negative): Ambiguous / question input never triggers accidental completion or deletion
  it('TEST 15 (Negative): Informative question "¿cómo así?" or "¿qué pasó?" never executes mutation', async () => {
    pinReadFixtureDate();
    const saved = await saveReminder({
      userId: testUser!.id,
      phoneNumber: testPhone,
      content: 'Comprar café',
      sendAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    }) as unknown as FixtureRow;

    untrustedResultMock(vi.spyOn(aiClient, 'callChatCompletion')).mockResolvedValue(behavioralContinuityMessage('clarificationOnly'));

    const res = await routeMessage('¿cómo así? no entendí lo que dijiste', testUser) as unknown as FixtureRoute;

    expect(res.intent).toBe('chat');
    expect(res.confirmation).not.toMatch(/cancelado|completado|eliminado/i);

    const { data: rems } = await (supabase as unknown as FixtureClient).from('reminders').select('*').eq('user_id', testUser!.id).eq('status', 'pending');
    expect(rems!.length).toBe(1);
    expect(rems![0]!.id).toBe((saved as unknown as FixtureRow).id);
    expect(rems![0]!.acknowledged_at).toBeNull();
  });

  // TEST 16 (Negative): Non-existent target fails with clear error and NO false green
  it('TEST 16 (Negative): Non-existent reminder ID returns NOT_FOUND error and does NOT report false success', async () => {
    const toolRes = await executeTool({
      toolName: 'manage_reminder',
      params: { action: 'cancel', target: 'non-existent-uuid-12345678' },
      user: testUser,
      language: 'es',
    });

    expect(toolRes.success).toBe(false);
    expect(toolRes.errorCode).toBe('NOT_FOUND');
    expect(toolRes.error).toBe('No encontré ese recordatorio.');
  });

  // TEST 17: Creating Google Calendar event automatically creates a linked WhatsApp reminder
  it('TEST 17: Creating Google Calendar event creates synchronized WhatsApp reminder', async () => {
    pinReadFixtureDate();
    await saveUserIntegration(testUser!.id, {
      provider: 'google',
      accessToken: 'valid-mock-token',
      refreshToken: 'valid-mock-refresh',
      accountEmail: 'calendar-sync@gmail.com',
    });

    const createEventSpy = untrustedResultMock(vi.spyOn(googleCalendarService, 'createCalendarEvent')).mockResolvedValue({
      id: 'gcal-event-12345',
      summary: 'Reunión de trabajo',
      startDateTime: '2026-09-03T14:00:00.000Z',
      endDateTime: '2026-09-03T15:00:00.000Z',
      meetLink: 'https://meet.google.com/abc-defg-hij',
    });

    untrustedResultMock(vi.spyOn(aiClient, 'callChatCompletion')).mockResolvedValue(behavioralCalendarDeliveryMessage('calendarWithNotice'));

    const res = await routeMessage('mañana tengo una reunión del trabajo a las 9am, avísame 15 minutos antes', testUser) as unknown as FixtureRoute;

    expect(res.intent).toBe('calendar');
    expect(res.confirmation).toContain('Evento agendado en Google Calendar');
    expect(res.confirmation).toContain('Recordatorio programado en WhatsApp');

    // Verify reminder was created in DB
    const { data: rems } = await (supabase as unknown as FixtureClient).from('reminders').select('*').eq('user_id', testUser!.id);
    expect(rems!.length).toBeGreaterThanOrEqual(1);
    const companion = rems!.find(r => r.delivery_id === 'gcal:gcal-event-12345');
    expect(companion).toBeDefined();
    expect(companion!.content).toContain('Reunión de trabajo');
    expect(companion!.source).toBe('gcal_companion');
    expect(new Date(companion!.send_at).toISOString()).toBe('2026-09-03T13:45:00.000Z');

    createEventSpy.mockRestore();
  });

  // TEST 18: "Avísame 15 minutos antes" creates a NEW advance notice reminder and does NOT replace the original
  it('TEST 18: "Avísame 15 minutos antes" creates a NEW advance notice reminder and leaves original intact', async () => {
    pinReadFixtureDate();
    const mainTime = new Date('2026-09-03T15:00:00.000Z');

    const mainRem = await saveReminder({
      userId: testUser!.id,
      phoneNumber: testPhone,
      content: 'Cita con el cliente',
      sendAt: mainTime.toISOString(),
      requiresConfirmation: true,
    }) as unknown as FixtureRow;

    saveWorkingMemory(testUser, { source: 'reminder', items: [{
      type: 'reminder', internalId: mainRem.id, summary: mainRem.content, time: mainRem.send_at,
    }] });

    // Desired delivery state adds a linked advance notice without moving the primary.
    untrustedResultMock(vi.spyOn(aiClient, 'callChatCompletion')).mockResolvedValue(behavioralCalendarDeliveryMessage('advanceExisting'));

    const history = [
      { role: 'user', content: 'Recuérdame la cita con el cliente mañana a las 10am' },
      { role: 'assistant', content: '✅ Recordatorio programado para las 10:00 AM' },
    ];

    const res = await routeMessage('Recuérdame 15 minutos antes', testUser, history) as unknown as FixtureRoute;

    expect(res.intent).toBe('reminder');

    // Verify DB: BOTH reminders exist! The 10:00 AM main reminder and the 9:45 AM advance reminder
    const { data: rems } = await (supabase as unknown as FixtureClient).from('reminders').select('*').eq('user_id', testUser!.id).eq('status', 'pending');
    expect(rems!.length).toBe(2);

    const original = rems!.find(r => r.id === mainRem.id);
    expect(original).toBeDefined();
    expect(new Date(original!.send_at).getTime()).toBe(mainTime.getTime()); // UNTOUCHED!

    const advance = rems!.find(r => r.id !== mainRem.id);
    expect(advance).toBeDefined();
    expect(advance!.parent_reminder_id).toBe(mainRem.id);
    expect(advance!.source).toBe('advance_notice');
    expect(original!.content).toBe('Cita con el cliente');
    expect(new Date(advance!.send_at).getTime()).toBe(mainTime.getTime() - 15 * 60 * 1000);
  });

  // TEST 19: Explicit date in update_event bounds lookup to that specific date and ignores unrelated Working Memory from previous turn
  it('TEST 19: "9 de septiembre" explicitly sets timeMin/timeMax of Calendar lookup and ignores Sept 3 Working Memory', async () => {
    pinReadFixtureDate();
    await saveUserIntegration(testUser!.id, {
      provider: 'google',
      accessToken: 'valid-mock-token',
      refreshToken: 'valid-mock-refresh',
      accountEmail: 'calendar-date-bounds@gmail.com',
    });

    // 1. Setup Turn 1 Working Memory for September 3 (containing 2 similar meetings that previously triggered false ambiguity)
    saveWorkingMemory(testUser, {
      source: 'unified',
      scope: 'tomorrow',
      semanticQuery: 'mañana',
      items: [
        { position: 1, type: 'calendar_event', internalId: 'gcal-sept-3-event-1', summary: 'Reunión de trabajo', time: '09:00 AM', source: 'calendar' },
        { position: 2, type: 'calendar_event', internalId: 'gcal-sept-3-event-2', summary: 'Reunión de trabajo', time: '09:30 AM', source: 'calendar' },
      ],
    });

    // 2. Setup Spies on listCalendarEvents and updateCalendarEvent
    let capturedListParams: Parameters<typeof googleCalendarService.listCalendarEvents>[1] | null = null;
    const listEventsSpy = untrustedResultMock(vi.spyOn(googleCalendarService, 'listCalendarEvents')).mockImplementation(async (userId, options) => {
      capturedListParams = options;
      // Google Calendar returns 1 single event on September 9
      return [
        { id: 'gcal-sept-9-event-uuid', summary: 'Cita previa con proveedor', start: '2026-09-09T10:00:00-05:00', end: '2026-09-09T11:00:00-05:00' },
      ];
    });

    let capturedUpdateParams: Parameters<typeof googleCalendarService.updateCalendarEvent>[1] | null = null;
    const updateEventSpy = untrustedResultMock(vi.spyOn(googleCalendarService, 'updateCalendarEvent')).mockImplementation(async (userId, options) => {
      capturedUpdateParams = options;
      return { id: options.eventId, summary: options.summary };
    });

    // 3. Current scope is a lookup date; no schedule change is requested.
    untrustedResultMock(vi.spyOn(aiClient, 'callChatCompletion')).mockResolvedValue(datedCalendarRenameMessage());

    const historyTurn1 = [
      { role: 'user', content: '¿Entonces que tenemos para mañana?' },
      { role: 'assistant', content: 'Tienes 2 reuniones de trabajo agendadas.' },
    ];

    const res = await routeMessage(
      'la cita que tengo el 9 de septiembre ahora es -> Reunión en Ceramica italia de barranquilla',
      testUser,
      historyTurn1
    ) as unknown as FixtureRoute;

    // 4. Strict Behavioral Assertions:
    // Assert 1: The tool call must have queried Calendar specifically for September 9
    expect(capturedListParams).not.toBeNull();
    const timeMinStr = new Date((capturedListParams as unknown as { timeMin: string }).timeMin).toISOString();
    const timeMaxStr = new Date((capturedListParams as unknown as { timeMax: string }).timeMax).toISOString();

    // Must be bounded to 2026-09-09 (and NOT 2026-09-03)
    expect(timeMinStr).toBe('2026-09-09T05:00:00.000Z');
    expect(timeMaxStr).toBe('2026-09-10T05:00:00.000Z');

    // Assert 2: updateCalendarEvent must be invoked with the resolved September 9 event ID (and NOT the September 3 ones)
    expect(capturedUpdateParams).not.toBeNull();
    expect((capturedUpdateParams as unknown as { eventId: string }).eventId).toBe('gcal-sept-9-event-uuid');
    expect((capturedUpdateParams as unknown as { summary: string }).summary).toBe('Reunión en Ceramica italia de barranquilla');

    // Assert 3: The user confirmation must report success and NOT "Hay múltiples eventos que coinciden"
    expect((capturedUpdateParams as unknown as { startDateTime?: unknown }).startDateTime).toBeUndefined();
    expect((capturedUpdateParams as unknown as { endDateTime?: unknown }).endDateTime).toBeUndefined();
    expect(res.confirmation).toContain('Evento actualizado');
    expect(res.confirmation).toContain('Google Calendar');
    expect(res.confirmation).toContain('Reunión en Ceramica italia de barranquilla');
    expect(res.confirmation).not.toContain('múltiples eventos');

    listEventsSpy.mockRestore();
    updateEventSpy.mockRestore();
  });

  // TEST 20: "Dame todos mis pendientes" uses upcoming scope, excludes past morning reminders, and includes future dates
  it('TEST 20: "Dame todos mis pendientes porfa" routes to scope: upcoming and presents multi-day chronological schedule', async () => {
    pinReadFixtureDate();
    await deleteUserIntegration(testUser!.id, 'google');
    // 1. Create a past morning reminder (8:00 AM today), a future reminder (tomorrow 8:00 AM), and a far future reminder (Sept 9)
    const now = new Date();
    const pastSendAt = new Date(now.getTime() - 2 * 60 * 60 * 1000).toISOString(); // 2 hours ago
    const tomorrowSendAt = new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString(); // tomorrow
    const sept9SendAt = new Date('2026-09-09T10:00:00-05:00').toISOString();

    const { error: seedError } = await (supabase as unknown as FixtureClient).from('reminders').insert([
      { user_id: testUser!.id, phone_number: testUser!.phone_number, content: 'Recordatorio pasado de la mañana', send_at: pastSendAt, status: 'pending' },
      { user_id: testUser!.id, phone_number: testUser!.phone_number, content: 'Cita médica mañana', send_at: tomorrowSendAt, status: 'pending' },
      { user_id: testUser!.id, phone_number: testUser!.phone_number, content: 'Reunión en Cerámica Italia', send_at: sept9SendAt, status: 'pending' },
    ]);
    expect(seedError).toBeNull();

    untrustedResultMock(vi.spyOn(aiClient, 'callChatCompletion')).mockResolvedValue(behavioralCalendarDeliveryMessage('upcomingAgenda'));

    const res = await routeMessage('Dame todos mis pendientes porfa', testUser) as unknown as FixtureRoute;

    expect(res.intent).toBe('unified_agenda');
    expect(res.confirmation).toContain('Tu agenda');
    expect(res.confirmation).toContain('Cita médica mañana');
    expect(res.confirmation).toContain('Reunión en Cerámica Italia');
    // Past reminder is excluded from upcoming agenda
    expect(res.confirmation).not.toContain('Recordatorio pasado de la mañana');
  });

  // TEST 21: Conversational affirmation "Ya fui" acknowledges the active nudge reminder without error
  it('TEST 21: Conversational confirmation "Ya fui" to a nudge acknowledges the active reminder in DB', async () => {
    pinReadFixtureDate();
    // Insert an active nudged reminder for the user
    const { data: insertedRem, error: insertError } = await (supabase as unknown as FixtureClient).from('reminders').insert({
      user_id: testUser!.id,
      phone_number: testUser!.phone_number,
      content: 'Ir al baño',
      send_at: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
      status: 'sent',
      requires_confirmation: true,
      nudge_count: 1,
      last_nudged_at: new Date().toISOString(),
    }).select('*').single();

    expect(insertError).toBeNull();
    expect(insertedRem?.id).toBeTruthy();
    saveWorkingMemory(testUser, { source: 'reminder', lastAction: 'nudge',
      notificationReminderId: insertedRem!.id, notificationContent: insertedRem!.content,
      items: [{ type: 'reminder', internalId: insertedRem!.id, summary: insertedRem!.content }] });

    untrustedResultMock(vi.spyOn(aiClient, 'callChatCompletion')).mockResolvedValue(activeNoticeMessage('acknowledgeActive'));

    const historyWithNudge = [
      { role: 'assistant', content: '🔔 Recordatorio pendiente: Ir al baño (Aviso #1). Escribe "Listo" o "OK" cuando lo hayas completado.' },
    ];

    const res = await routeMessage('Ya fui', testUser, historyWithNudge) as unknown as FixtureRoute;

    expect(res.intent).toBe('reminder');
    expect(res.confirmation).toContain('Recordatorio confirmado');
    expect(res.confirmation).toContain('Ir al baño');
    expect(res.confirmation).not.toContain('No se encontró el recordatorio');

    // Verify DB: reminder is acknowledged
    const { data: updatedDb } = await (supabase as unknown as FixtureClient).from('reminders').select('*').eq('id', insertedRem!.id).single();
    expect(updatedDb!.acknowledged_at).not.toBeNull();
  });

  // TEST 22: Natural completion variations ("Ya lo hice", "Ya está", "Ya quedó", "Lo terminé", "Ya terminé")
  it('TEST 22: Natural completion variations acknowledge the active notified reminder correctly', async () => {
    pinReadFixtureDate();
    const variations = ['Ya lo hice', 'Ya está', 'Ya quedó', 'Lo terminé', 'Ya terminé'];

    for (const expr of variations) {
      const { data: rem, error: insertError } = await (supabase as unknown as FixtureClient).from('reminders').insert({
        user_id: testUser!.id,
        phone_number: testUser!.phone_number,
        content: `Tomar medicamento ${expr}`,
        send_at: new Date(Date.now() - 2 * 60 * 1000).toISOString(),
        status: 'sent',
        requires_confirmation: true,
        nudge_count: 1,
        last_nudged_at: new Date().toISOString(),
      }).select('*').single();

      expect(insertError).toBeNull();
      expect(rem?.id).toBeTruthy();
      saveWorkingMemory(testUser, { source: 'reminder', lastAction: 'nudge',
        notificationReminderId: rem!.id, notificationContent: rem!.content,
        items: [{ type: 'reminder', internalId: rem!.id, summary: rem!.content }] });

      untrustedResultMock(vi.spyOn(aiClient, 'callChatCompletion')).mockResolvedValue(activeNoticeMessage('acknowledgeActive'));

      const res = await routeMessage(expr, testUser) as unknown as FixtureRoute;
      expect(res.confirmation).toContain('Recordatorio confirmado');
      expect(res.confirmation).toContain(`Tomar medicamento ${expr}`);

      const { data: updated } = await (supabase as unknown as FixtureClient).from('reminders').select('*').eq('id', rem!.id).single();
      expect(updated!.acknowledged_at).not.toBeNull();
    }
  });

  // TEST 23: "Ya fui" without notification context and without active reminder asks for context and does not mutate arbitrarily
  it('TEST 23: "Ya fui" without notification context or pending reminders asks for missing context without arbitrary mutation', async () => {
    pinReadFixtureDate();
    // Clear reminders
    await (supabase as unknown as FixtureClient).from('reminders').delete().eq('user_id', testUser!.id);

    untrustedResultMock(vi.spyOn(aiClient, 'callChatCompletion')).mockResolvedValue(activeNoticeMessage('acknowledgeActive'));

    const res = await routeMessage('Ya fui', testUser) as unknown as FixtureRoute;
    expect(res.executionFacts?.[0]?.errorCode).toBe('MISSING_REQUIRED_CONTEXT');
    expect(res.confirmation).not.toMatch(/Recordatorio confirmado/i);
    const { data: remaining, error: readError } = await (supabase as unknown as FixtureClient).from('reminders').select('id').eq('user_id', testUser!.id);
    expect(readError).toBeNull();
    expect(remaining).toEqual([]);
  });

  // TEST 24: Repeated acknowledge returns idempotent success and does not produce NOT_FOUND
  it('TEST 24: Repeated acknowledge returns idempotent confirmation and does not error', async () => {
    pinReadFixtureDate();
    const { data: rem, error: insertError } = await (supabase as unknown as FixtureClient).from('reminders').insert({
      user_id: testUser!.id,
      phone_number: testUser!.phone_number,
      content: 'Comprar fruta',
      send_at: new Date().toISOString(),
      status: 'sent',
      requires_confirmation: true,
      acknowledged_at: new Date().toISOString(),
    }).select('*').single();

    expect(insertError).toBeNull();
    expect(rem?.id).toBeTruthy();

    untrustedResultMock(vi.spyOn(aiClient, 'callChatCompletion')).mockResolvedValue(activeNoticeMessage('acknowledgeNamed'));

    const res = await routeMessage('Listo fruta', testUser) as unknown as FixtureRoute;
    expect(res.confirmation).toContain('Recordatorio confirmado');
    expect(res.confirmation).toContain('Comprar fruta');
    expect(res.confirmation).not.toContain('No se encontró');
    const { data: after, error: readError } = await (supabase as unknown as FixtureClient).from('reminders').select('id, acknowledged_at').eq('id', rem!.id).single();
    expect(readError).toBeNull();
    expect(after!.acknowledged_at).toBe(rem!.acknowledged_at);
  });

  // TEST 25: Acknowledged reminder is never returned by getRemindersDueForNudge
  it('TEST 25: Acknowledged reminder is excluded from getRemindersDueForNudge (scheduler stops nudges)', async () => {
    pinReadFixtureDate();
    const { getRemindersDueForNudge } = await import('../../../src/infrastructure/database/index.js');

    const { data: rem, error: insertError } = await (supabase as unknown as FixtureClient).from('reminders').insert({
      user_id: testUser!.id,
      phone_number: testUser!.phone_number,
      content: 'Ejercicio matutino',
      send_at: new Date(Date.now() - 30 * 60 * 1000).toISOString(),
      sent_at: new Date(Date.now() - 30 * 60 * 1000).toISOString(),
      status: 'sent',
      requires_confirmation: true,
      nudge_interval_minutes: 15,
      acknowledged_at: new Date().toISOString(), // Already acknowledged
    }).select('*').single();

    expect(insertError).toBeNull();
    expect(rem?.id).toBeTruthy();

    const due = await getRemindersDueForNudge();
    const isDue = due.some(r => r.id === rem!.id);
    expect(isDue).toBe(false);
  });

  // TEST 26: Explicit date in Google Calendar lookup with 0 candidates offers creation without creating automatically
  it('TEST 26: Explicit date update with 0 candidates on Google Calendar informs user and does NOT mutate or auto-create', async () => {
    pinReadFixtureDate();
    await saveUserIntegration(testUser!.id, { provider: 'google', accessToken: 'fake_token', refreshToken: 'fake_refresh_token', accountEmail: 'fixture@example.test' });

    untrustedResultMock(vi.spyOn(googleCalendarService, 'listCalendarEvents')).mockResolvedValue([]);
    const createSpy = vi.spyOn(googleCalendarService, 'createCalendarEvent');
    const updateSpy = vi.spyOn(googleCalendarService, 'updateCalendarEvent');

    untrustedResultMock(vi.spyOn(aiClient, 'callChatCompletion')).mockResolvedValue(activeNoticeMessage('missingDatedEvent'));

    const res = await routeMessage('la cita que tengo el 9 de septiembre ahora es Reunión en Cerámica Italia', testUser) as unknown as FixtureRoute;

    expect(res.executionFacts?.[0]?.errorCode).toBe('NOT_FOUND');
    expect(res.confirmation).toContain('No encontré ese evento en Google Calendar.');
    expect(createSpy).not.toHaveBeenCalled();
    expect(updateSpy).not.toHaveBeenCalled();
  });

  // TEST 27: List Reminders Semantics ("Dame mis pendientes de hoy", "Qué recordatorios creamos hoy", "Qué completé hoy")
  it('TEST 27: List reminders correctly distinguishes pending_today (A), created_today (B+C), and completed_today (C)', async () => {
    pinReadFixtureDate();
    // A: creado ayer, programado hoy, pendiente
    // B: creado hoy, programado mañana, pendiente
    // C: creado hoy, programado hoy, completado

    const yesterday = new Date('2026-09-01T10:00:00Z').toISOString();
    const todayScheduled = new Date('2026-09-02T10:00:00-05:00').toISOString();
    const tomorrowScheduled = new Date('2026-09-03T15:00:00-05:00').toISOString();
    const todayAck = new Date('2026-09-02T11:00:00-05:00').toISOString();

    await (supabase as unknown as FixtureClient).from('reminders').delete().eq('user_id', testUser!.id);

    const { error: insertError } = await (supabase as unknown as FixtureClient).from('reminders').insert([
      {
        user_id: testUser!.id,
        phone_number: testUser!.phone_number,
        content: 'Reminder A: Creado ayer programado hoy',
        created_at: yesterday,
        send_at: todayScheduled,
        status: 'pending',
        acknowledged_at: null,
      },
      {
        user_id: testUser!.id,
        phone_number: testUser!.phone_number,
        content: 'Reminder B: Creado hoy programado mañana',
        created_at: new Date().toISOString(),
        send_at: tomorrowScheduled,
        status: 'pending',
        acknowledged_at: null,
      },
      {
        user_id: testUser!.id,
        phone_number: testUser!.phone_number,
        content: 'Reminder C: Creado hoy programado hoy completado',
        created_at: new Date().toISOString(),
        send_at: todayScheduled,
        status: 'sent',
        acknowledged_at: todayAck,
      },
    ]);
    expect(insertError).toBeNull();

    // 1. "Dame mis pendientes de hoy" -> only A
    untrustedResultMock(vi.spyOn(aiClient, 'callChatCompletion')).mockResolvedValue(reminderDateMessage('pendingToday'));
    const resA = await routeMessage('Dame mis pendientes de hoy', testUser) as unknown as FixtureRoute;
    expect(resA.confirmation).toContain('Reminder A');
    expect(resA.confirmation).not.toContain('Reminder B');
    expect(resA.confirmation).not.toContain('Reminder C');

    // 2. "Qué recordatorios creamos hoy" -> B + C
    untrustedResultMock(vi.spyOn(aiClient, 'callChatCompletion')).mockResolvedValue(reminderDateMessage('createdToday'));
    const resB = await routeMessage('Qué recordatorios creamos hoy', testUser) as unknown as FixtureRoute;
    expect(resB.confirmation).toContain('Recordatorios creados hoy');
    expect(resB.confirmation).toContain('Reminder B');
    expect(resB.confirmation).toContain('Reminder C');
    expect(resB.confirmation).not.toContain('Reminder A');

    // 3. "Qué completé hoy" -> C
    untrustedResultMock(vi.spyOn(aiClient, 'callChatCompletion')).mockResolvedValue(reminderDateMessage('completedToday'));
    const resC = await routeMessage('Qué completé hoy', testUser) as unknown as FixtureRoute;
    expect(resC.confirmation).toContain('Recordatorios completados hoy');
    expect(resC.confirmation).toContain('Reminder C');
    expect(resC.confirmation).not.toContain('Reminder A');
    expect(resC.confirmation).not.toContain('Reminder B');
  });

  // TEST 28: "Qué pendientes nos quedan hoy" / "Qué falta por hacer hoy" strictly filters [now, todayEnd) and differentiates from "pendientes de hoy"
  it('TEST 28: "Qué pendientes nos quedan hoy" / "Qué falta por hacer hoy" strictly filters [now, todayEnd) and differentiates from "pendientes de hoy"', async () => {
    // Current simulated local time: 2026-09-02T21:45:00 in America/Bogota (UTC-5 -> 2026-09-03T02:45:00Z)
    const simulatedNow = new Date('2026-09-03T02:45:00.000Z');
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(simulatedNow);

    // R1: 08:00 AM today (2026-09-02T13:00:00Z) -> past today
    const { error: insertError1 } = await (supabase as unknown as FixtureClient).from('reminders').insert({
      user_id: testUser!.id,
      phone_number: testPhone,
      content: 'Reminder R1: Tomar café en la mañana 8am',
      send_at: '2026-09-02T13:00:00.000Z',
      status: 'pending',
      created_at: '2026-09-02T12:00:00.000Z',
    });

    expect(insertError1).toBeNull();

    // R2: 21:41 today (2026-09-03T02:41:00Z) -> past today (4 minutes ago)
    const { error: insertError2 } = await (supabase as unknown as FixtureClient).from('reminders').insert({
      user_id: testUser!.id,
      phone_number: testPhone,
      content: 'Reminder R2: Sacar basura 21:41',
      send_at: '2026-09-03T02:41:00.000Z',
      status: 'pending',
      created_at: '2026-09-02T12:00:00.000Z',
    });

    expect(insertError2).toBeNull();

    // R3: 22:30 today (2026-09-03T03:30:00Z) -> future today (in 45 minutes)
    const { error: insertError3 } = await (supabase as unknown as FixtureClient).from('reminders').insert({
      user_id: testUser!.id,
      phone_number: testPhone,
      content: 'Reminder R3: Bloquear puertas 22:30',
      send_at: '2026-09-03T03:30:00.000Z',
      status: 'pending',
      created_at: '2026-09-02T12:00:00.000Z',
    });

    expect(insertError3).toBeNull();

    // R4: 08:00 AM tomorrow (2026-09-03T13:00:00Z) -> future tomorrow
    const { error: insertError4 } = await (supabase as unknown as FixtureClient).from('reminders').insert({
      user_id: testUser!.id,
      phone_number: testPhone,
      content: 'Reminder R4: Despertador mañana 8am',
      send_at: '2026-09-03T13:00:00.000Z',
      status: 'pending',
      created_at: '2026-09-02T12:00:00.000Z',
    });

    expect(insertError4).toBeNull();

    // 1. "Dame mis pendientes de hoy" -> includes all today (R1, R2, R3), excludes tomorrow (R4)
    untrustedResultMock(vi.spyOn(aiClient, 'callChatCompletion')).mockResolvedValue(reminderDateMessage('pendingToday'));
    const resAllToday = await routeMessage('Dame mis pendientes de hoy', testUser) as unknown as FixtureRoute;
    expect(resAllToday.confirmation).toContain('Reminder R1');
    expect(resAllToday.confirmation).toContain('Reminder R2');
    expect(resAllToday.confirmation).toContain('Reminder R3');
    expect(resAllToday.confirmation).not.toContain('Reminder R4');

    // 2. Variations of "qué nos queda hoy" -> includes ONLY R3, excludes past today (R1, R2) and tomorrow (R4)
    const naturalRemainingPhrases = [
      '¿Qué pendientes nos quedan hoy?',
      '¿Qué nos queda pendiente hoy?',
      '¿Qué falta por hacer hoy?',
      '¿Qué queda para hoy?',
    ];

    for (const phrase of naturalRemainingPhrases) {
      untrustedResultMock(vi.spyOn(aiClient, 'callChatCompletion')).mockResolvedValue(reminderDateMessage('remainingToday'));
      const resRemaining = await routeMessage(phrase, testUser) as unknown as FixtureRoute;
      expect(resRemaining.confirmation).toContain('Recordatorios de hoy');
      expect(resRemaining.confirmation).toContain('Reminder R3');
      expect(resRemaining.confirmation).not.toContain('Reminder R1');
      expect(resRemaining.confirmation).not.toContain('Reminder R2');
      expect(resRemaining.confirmation).not.toContain('Reminder R4');
    }

    vi.useRealTimers();
  });

  // TEST 29: Production Bug E2E: Notification "Ir al baño" -> "Ya fui" strictly preserves reminderId, confirms "Ir al baño", and NEVER mentions another existing reminder
  it('TEST 29: Production Bug E2E: "Ir al baño" notification -> "Ya fui" acknowledges exact reminderId and never mentions other existing reminders', async () => {
    pinReadFixtureDate();
    // Clear reminders
    await (supabase as unknown as FixtureClient).from('reminders').delete().eq('user_id', testUser!.id);

    // Insert Reminder 1: "Eres muy importante y podemos controlar nuestros impulsos" (older pending reminder with earlier nudge)
    const { data: remOther, error: otherInsertError } = await (supabase as unknown as FixtureClient).from('reminders').insert({
      user_id: testUser!.id,
      phone_number: testUser!.phone_number,
      content: 'Eres muy importante y podemos controlar nuestros impulsos',
      send_at: new Date(Date.now() - 30 * 60 * 1000).toISOString(),
      status: 'sent',
      requires_confirmation: true,
      nudge_count: 1,
      last_nudged_at: new Date(Date.now() - 25 * 60 * 1000).toISOString(),
      created_at: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
    }).select().single();

    // Insert Reminder 2: "Ir al baño" (active notified reminder)
    const { data: remTarget, error: targetInsertError } = await (supabase as unknown as FixtureClient).from('reminders').insert({
      user_id: testUser!.id,
      phone_number: testUser!.phone_number,
      content: 'Ir al baño',
      send_at: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
      status: 'sent',
      requires_confirmation: true,
      nudge_count: 1,
      last_nudged_at: new Date().toISOString(),
      created_at: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
    }).select().single();

    expect(otherInsertError).toBeNull();
    expect(targetInsertError).toBeNull();
    expect(remOther?.id).toBeTruthy();
    expect(remTarget?.id).toBeTruthy();

    // 1. Simulate Notification Context in Working Memory from Scheduler
    saveWorkingMemory(testUser!.phone_number, {
      source: 'reminder',
      scope: 'today',
      lastAction: 'nudge',
      notificationReminderId: remTarget!.id,
      notificationContent: 'Ir al baño',
      items: [{
        position: 1,
        type: 'reminder',
        internalId: remTarget!.id,
        summary: 'Ir al baño',
        raw: remTarget!,
      }],
    });
    saveWorkingMemory(testUser!.id, {
      source: 'reminder',
      scope: 'today',
      lastAction: 'nudge',
      notificationReminderId: remTarget!.id,
      notificationContent: 'Ir al baño',
      items: [{
        position: 1,
        type: 'reminder',
        internalId: remTarget!.id,
        summary: 'Ir al baño',
        raw: remTarget!,
      }],
    });

    // 2. Semantic completion binds the trusted notification identity in Node.
    untrustedResultMock(vi.spyOn(aiClient, 'callChatCompletion')).mockResolvedValue(noticeWeekdayMessage('acknowledgeNotification'));

    const historyWithNotification = [
      { role: 'assistant', content: '🔔 Recordatorio pendiente: Ir al baño (Aviso #1). Escribe "Listo" o "OK" cuando lo hayas completado.' },
    ];

    const res = await routeMessage('Ya fui', testUser, historyWithNotification) as unknown as FixtureRoute;

    // Strict E2E Asserts
    expect(res.intent).toBe('reminder');
    expect(res.confirmation).toContain('Recordatorio confirmado');
    expect(res.confirmation).toContain('Ir al baño');
    expect(res.confirmation).not.toContain('Eres muy importante');
    expect(res.confirmation).not.toContain('controlar nuestros impulsos');

    // DB Verification: remTarget is acknowledged, remOther remains unacknowledged
    const { data: updatedTarget } = await (supabase as unknown as FixtureClient).from('reminders').select('*').eq('id', remTarget!.id).single();
    expect(updatedTarget!.acknowledged_at).not.toBeNull();

    const { data: updatedOther } = await (supabase as unknown as FixtureClient).from('reminders').select('*').eq('id', remOther!.id).single();
    expect(updatedOther!.acknowledged_at).toBeNull();

    // 3. Repeated Acknowledge Idempotency: "Ya fui" again
    untrustedResultMock(vi.spyOn(aiClient, 'callChatCompletion')).mockResolvedValue(noticeWeekdayMessage('repeatBathroom'));
    const repeatHistory = [...historyWithNotification, { role: 'user', content: 'Ya fui' }, { role: 'assistant', content: res.confirmation }];
    const resRepeat = await routeMessage('Ya fui', testUser, repeatHistory) as unknown as FixtureRoute;
    expect(resRepeat.confirmation).toContain('Recordatorio confirmado');
    expect(resRepeat.confirmation).toContain('Ir al baño');
    expect(resRepeat.confirmation).not.toContain('Eres muy importante');
    const { data: repeatedTarget } = await (supabase as unknown as FixtureClient).from('reminders').select('id, acknowledged_at').eq('id', remTarget!.id).single();
    const { data: untouchedOther } = await (supabase as unknown as FixtureClient).from('reminders').select('id, acknowledged_at').eq('id', remOther!.id).single();
    expect(repeatedTarget!.acknowledged_at).toBe(updatedTarget!.acknowledged_at);
    expect(untouchedOther!.acknowledged_at).toBeNull();
  });

  // =========================================================================
  // TEST 30: Weekday scope: "¿Qué reuniones tenemos el viernes?" only returns Friday
  // =========================================================================
  it('TEST 30: "¿Qué reuniones tenemos el viernes?" resolves deterministically to Friday [timeMin, timeMax)', async () => {
    pinReadFixtureDate();
    await saveUserIntegration(testUser!.id, { provider: 'google', accessToken: 'weekday-token', refreshToken: 'weekday-refresh', accountEmail: 'weekday@example.test' });
    // Wednesday Sept 2, 2026. Friday is Sept 4, 2026.
    const googleEvents = [
      { id: 'ev-thu', summary: 'Reunión Jueves', start: { dateTime: '2026-09-03T10:00:00-05:00' }, end: { dateTime: '2026-09-03T11:00:00-05:00' } },
      { id: 'ev-fri-1', summary: 'Reunión Planeación Viernes', start: { dateTime: '2026-09-04T10:00:00-05:00' }, end: { dateTime: '2026-09-04T11:00:00-05:00' } },
      { id: 'ev-fri-2', summary: 'Almuerzo Clientes Viernes', start: { dateTime: '2026-09-04T13:00:00-05:00' }, end: { dateTime: '2026-09-04T14:00:00-05:00' } },
      { id: 'ev-mon', summary: 'Reunión Lunes Próximo', start: { dateTime: '2026-09-07T09:00:00-05:00' }, end: { dateTime: '2026-09-07T10:00:00-05:00' } },
    ];

    let capturedTimeMin: string | Date | null | undefined = null;
    let capturedTimeMax: string | Date | null | undefined = null;

    untrustedResultMock(vi.spyOn(googleCalendarService, 'listCalendarEvents')).mockImplementation(async (userId, params) => {
      capturedTimeMin = params!.timeMin;
      capturedTimeMax = params!.timeMax;
      // Filter strictly by the requested [timeMin, timeMax)
      const minMs = new Date(params!.timeMin!).getTime();
      const maxMs = new Date(params!.timeMax!).getTime();
      return googleEvents.filter(e => {
        const evMs = new Date(e.start.dateTime).getTime();
        return evMs >= minMs && evMs < maxMs;
      });
    });

    untrustedResultMock(vi.spyOn(aiClient, 'callChatCompletion')).mockResolvedValue(noticeWeekdayMessage('fridayAgenda'));

    const res = await routeMessage('¿Qué reuniones tenemos el viernes?', testUser) as unknown as FixtureRoute;

    // Verify time range covers Friday Sept 4 exclusively
    expect(capturedTimeMin).toBeDefined();
    expect(capturedTimeMax).toBeDefined();
    const minDateStr = new Date(capturedTimeMin as unknown as string).toISOString();
    const maxDateStr = new Date(capturedTimeMax as unknown as string).toISOString();
    expect(minDateStr).toBe('2026-09-04T05:00:00.000Z');
    expect(maxDateStr).toBe('2026-09-05T05:00:00.000Z');

    // Asserts: ONLY Friday events are in the output
    expect(res.confirmation).toContain('Reunión Planeación Viernes');
    expect(res.confirmation).toContain('Almuerzo Clientes Viernes');
    expect(res.confirmation).not.toContain('Reunión Jueves');
    expect(res.confirmation).not.toContain('Reunión Lunes Próximo');
  });

  // =========================================================================
  // TEST 31: Task Title + "Ya lo hice" out-of-the-blue completes exact task
  // =========================================================================
  it('TEST 31: Task Title + "Ya lo hice" completes exact task in DB and confirms exclusively with title', async () => {
    pinReadFixtureDate();
    // Insert task in DB
    const { data: taskBAM, error: bamError } = await (supabase as unknown as FixtureClient).from('tasks').insert({
      user_id: testUser!.id,
      title: 'Diseñar el orden BAM para poder tener más dinero con la misma orden',
      status: 'pending',
      priority: 'high',
    }).select().single();

    const { data: otherTask, error: otherError } = await (supabase as unknown as FixtureClient).from('tasks').insert({
      user_id: testUser!.id,
      title: 'Comprar materiales de oficina',
      status: 'pending',
      priority: 'low',
    }).select().single();

    expect(bamError).toBeNull();
    expect(otherError).toBeNull();
    expect(taskBAM?.id).toBeTruthy();
    expect(otherTask?.id).toBeTruthy();

    // User sends explicit message
    untrustedResultMock(vi.spyOn(aiClient, 'callChatCompletion')).mockResolvedValue(taskCalendarMutationMessage('completeNamed'));

    const res = await routeMessage(
      'Diseñar el orden BAM para poder tener más dinero con la misma orden: Ya lo hice',
      testUser
    ) as unknown as FixtureRoute;

    expect(res.intent).toBe('task');
    expect(res.confirmation).toContain('Tarea completada');
    expect(res.confirmation).toContain('Diseñar el orden BAM para poder tener más dinero con la misma orden');
    expect(res.confirmation).not.toContain('Task not found');
    expect(res.confirmation).not.toContain('Comprar materiales');

    // DB Verification
    const { data: updatedBAM } = await (supabase as unknown as FixtureClient).from('tasks').select('*').eq('id', taskBAM!.id).single();
    expect(updatedBAM!.status).toBe('completed');

    const { data: updatedOther } = await (supabase as unknown as FixtureClient).from('tasks').select('*').eq('id', otherTask!.id).single();
    expect(updatedOther!.status).toBe('pending');
  });

  // =========================================================================
  // TEST 32: Multi-turn ordinal task completion (T1 list -> T2 "La segunda ya la hice")
  // =========================================================================
  it('TEST 32: Multi-turn: T1 list tasks -> T2 "La segunda ya la hice" completes 2nd task from T1', async () => {
    pinReadFixtureDate();
    const { data: task1, error: task1Error } = await (supabase as unknown as FixtureClient).from('tasks').insert({
      user_id: testUser!.id,
      title: 'Revisar métricas semanales',
      status: 'pending',
      due_date: '2026-09-03T10:00:00Z',
    }).select().single();

    const { data: task2, error: task2Error } = await (supabase as unknown as FixtureClient).from('tasks').insert({
      user_id: testUser!.id,
      title: 'Actualizar contrato con proveedor',
      status: 'pending',
      due_date: '2026-09-04T10:00:00Z',
    }).select().single();

    expect(task1Error).toBeNull();
    expect(task2Error).toBeNull();
    expect(task1?.id).toBeTruthy();
    expect(task2?.id).toBeTruthy();

    // T1: list tasks
    untrustedResultMock(vi.spyOn(aiClient, 'callChatCompletion')).mockResolvedValueOnce(taskCalendarMutationMessage('listTasks'));

    const resT1 = await routeMessage('¿Cuáles son mis tareas?', testUser) as unknown as FixtureRoute;
    expect(resT1.confirmation).toContain('Revisar métricas semanales');
    expect(resT1.confirmation).toContain('Actualizar contrato con proveedor');

    expect(getWorkingMemory(testUser)?.items.map(item => item.internalId)).toEqual([task1!.id, task2!.id]);

    // T2: "La segunda ya la hice"
    untrustedResultMock(vi.spyOn(aiClient, 'callChatCompletion')).mockResolvedValueOnce(taskCalendarMutationMessage('completeSecond'));

    const resT2 = await routeMessage('La segunda ya la hice', testUser) as unknown as FixtureRoute;
    expect(resT2.confirmation).toContain('Tarea completada');
    expect(resT2.confirmation).toContain('Actualizar contrato con proveedor');
    expect(resT2.confirmation).not.toContain('Revisar métricas semanales');

    // DB Verification
    const { data: updatedTask1 } = await (supabase as unknown as FixtureClient).from('tasks').select('*').eq('id', task1!.id).single();
    expect(updatedTask1!.status).toBe('pending');

    const { data: updatedTask2 } = await (supabase as unknown as FixtureClient).from('tasks').select('*').eq('id', task2!.id).single();
    expect(updatedTask2!.status).toBe('completed');
  });

  // =========================================================================
  // TEST 33: Multi-turn ordinal calendar cancellation (T1 Friday meetings -> T2 "Cancela la segunda")
  // =========================================================================
  it('TEST 33: Multi-turn: T1 Friday meetings -> T2 "Cancela la segunda" deletes 2nd Friday meeting', async () => {
    pinReadFixtureDate();
    await saveUserIntegration(testUser!.id, { provider: 'google', accessToken: 'ordinal-token', refreshToken: 'ordinal-refresh', accountEmail: 'ordinal@example.test' });
    const googleEvents = [
      { id: 'ev-fri-a', summary: 'Standup Viernes', start: { dateTime: '2026-09-04T09:00:00-05:00' }, end: { dateTime: '2026-09-04T09:30:00-05:00' } },
      { id: 'ev-fri-b', summary: 'Demostración de Producto', start: { dateTime: '2026-09-04T15:00:00-05:00' }, end: { dateTime: '2026-09-04T16:00:00-05:00' } },
    ];

    untrustedResultMock(vi.spyOn(googleCalendarService, 'listCalendarEvents')).mockImplementation(async (_userId, options) => options?.q ? [] : googleEvents);
    let deletedEventId: string | null = null;
    untrustedResultMock(vi.spyOn(googleCalendarService, 'deleteCalendarEvent')).mockImplementation(async (userId, eventId) => {
      deletedEventId = eventId;
      return true;
    });

    // T1: Friday meetings
    untrustedResultMock(vi.spyOn(aiClient, 'callChatCompletion')).mockResolvedValueOnce(taskCalendarMutationMessage('fridayCalendar'));

    const resT1 = await routeMessage('¿Qué reuniones tenemos el viernes?', testUser) as unknown as FixtureRoute;
    expect(resT1.confirmation).toContain('Standup Viernes');
    expect(resT1.confirmation).toContain('Demostración de Producto');

    expect(getWorkingMemory(testUser)?.items.map(item => item.internalId)).toEqual(['ev-fri-a', 'ev-fri-b']);

    // T2: "Cancela la segunda"
    untrustedResultMock(vi.spyOn(aiClient, 'callChatCompletion')).mockResolvedValueOnce(taskCalendarMutationMessage('deleteSecond'));

    const resT2 = await routeMessage('Cancela la segunda', testUser) as unknown as FixtureRoute;
    expect(deletedEventId).toBe('ev-fri-b');
    expect(googleCalendarService.deleteCalendarEvent).toHaveBeenCalledExactlyOnceWith(testUser!.id, 'ev-fri-b');
    expect(resT2.confirmation).toContain('eliminado');
    expect(resT2.confirmation).toContain('Demostración de Producto');
    expect(resT2.confirmation).not.toContain('Standup Viernes');
  });

  // =========================================================================
  // TEST 34: Ambiguous task match triggers clarification and does NOT mutate
  // =========================================================================
  it('TEST 34: Ambiguous task match returns AMBIGUOUS_TARGET and does NOT mutate database', async () => {
    pinReadFixtureDate();
    const { data: t1, error: t1Error } = await (supabase as unknown as FixtureClient).from('tasks').insert({
      user_id: testUser!.id,
      title: 'Reporte financiero Q3 para inversionistas',
      status: 'pending',
    }).select().single();

    const { data: t2, error: t2Error } = await (supabase as unknown as FixtureClient).from('tasks').insert({
      user_id: testUser!.id,
      title: 'Reporte financiero Q3 para la junta directiva',
      status: 'pending',
    }).select().single();

    expect(t1Error).toBeNull();
    expect(t2Error).toBeNull();
    expect(t1?.id).toBeTruthy();
    expect(t2?.id).toBeTruthy();
    untrustedResultMock(vi.spyOn(aiClient, 'callChatCompletion')).mockResolvedValue(finalSafetyMessage('ambiguousTask'));

    const res = await routeMessage('Ya terminé el reporte financiero Q3', testUser) as unknown as FixtureRoute;
    expect(res.confirmation).toContain('coinciden');
    expect(res.executionFacts?.[0]?.errorCode).toBe('AMBIGUOUS_TARGET');

    // Neither task should be mutated
    const { data: checkT1, error: checkT1Error } = await (supabase as unknown as FixtureClient).from('tasks').select('*').eq('id', t1!.id).single();
    const { data: checkT2, error: checkT2Error } = await (supabase as unknown as FixtureClient).from('tasks').select('*').eq('id', t2!.id).single();
    expect(checkT1Error).toBeNull();
    expect(checkT2Error).toBeNull();
    expect(checkT1!.status).toBe('pending');
    expect(checkT2!.status).toBe('pending');
  });

  // =========================================================================
  // TEST 35: Authoritative 0 candidates on explicit scope does NOT fallback to old WM
  // =========================================================================
  it('TEST 35: Authoritative 0 candidates on explicit date does NOT fallback to old Working Memory', async () => {
    pinReadFixtureDate();
    await saveUserIntegration(testUser!.id, { provider: 'google', accessToken: 'empty-date-token', refreshToken: 'empty-date-refresh', accountEmail: 'empty@example.test' });
    // Old working memory from Sept 2
    saveWorkingMemory(testUser!.id, {
      source: 'calendar',
      scope: 'today',
      items: [{ position: 1, type: 'calendar_event', internalId: 'ev-old', summary: 'Reunión Antigua' }],
    });

    untrustedResultMock(vi.spyOn(googleCalendarService, 'listCalendarEvents')).mockResolvedValue([]);

    untrustedResultMock(vi.spyOn(aiClient, 'callChatCompletion')).mockResolvedValue(finalSafetyMessage('datedEmptyCalendar'));

    const res = await routeMessage('¿Qué tengo el 15 de septiembre?', testUser) as unknown as FixtureRoute;
    expect(res.confirmation).toContain('No tienes eventos programados');
    expect(res.confirmation).not.toContain('Reunión Antigua');
    expect(googleCalendarService.listCalendarEvents).toHaveBeenCalledExactlyOnceWith(testUser!.id, expect.objectContaining({ timeMin: new Date('2026-09-15T05:00:00Z'), timeMax: new Date('2026-09-16T05:00:00Z') }));
  });

  // =========================================================================
  // TEST 36: Tenant Isolation: Cannot mutate task belonging to another user
  // =========================================================================
  it('TEST 36: Tenant Isolation: Cannot mutate task belonging to another user', async () => {
    pinReadFixtureDate();
    const otherUser = await getOrCreateUserByPhone('573990009999', 'America/Bogota', 'es-CO', 'Other Test User') as unknown as FixtureUser;
    const { data: victimTask, error: victimError } = await (supabase as unknown as FixtureClient).from('tasks').insert({
      user_id: otherUser.id,
      title: 'Tarea Confidencial del Otro Usuario',
      status: 'pending',
    }).select().single();

    expect(victimError).toBeNull();
    expect(victimTask?.id).toBeTruthy();
    // Inject a foreign identity into caller context to exercise storage ownership checks.
    saveWorkingMemory(testUser, { source: 'task', items: [{ type: 'task', internalId: victimTask!.id, summary: 'Tarea ajena' }] });

    untrustedResultMock(vi.spyOn(aiClient, 'callChatCompletion')).mockResolvedValue(finalSafetyMessage('completeDisplayed'));

    const res = await routeMessage(`Completar tarea ${victimTask!.id}`, testUser) as unknown as FixtureRoute;
    expect(res.executionFacts?.[0]?.errorCode).toBe('NOT_FOUND');
    expect(res.confirmation).not.toContain('Tarea completada');

    // DB: Task must still be pending
    const { data: checkVictim, error: victimReadError } = await (supabase as unknown as FixtureClient).from('tasks').select('*').eq('id', victimTask!.id).single();
    expect(victimReadError).toBeNull();
    expect(checkVictim!.status).toBe('pending');

    // Cleanup
    await (supabase as unknown as FixtureClient).from('tasks').delete().eq('user_id', otherUser.id);
  });

  // =========================================================================
  // TEST 37: Idempotent task completion
  // =========================================================================
  it('TEST 37: Idempotent task completion: Completing already completed task succeeds without error', async () => {
    pinReadFixtureDate();
    const { data: taskAlreadyDone, error: alreadyDoneError } = await (supabase as unknown as FixtureClient).from('tasks').insert({
      user_id: testUser!.id,
      title: 'Pagar suscripción de internet',
      status: 'completed',
    }).select().single();

    expect(alreadyDoneError).toBeNull();
    expect(taskAlreadyDone?.id).toBeTruthy();
    saveWorkingMemory(testUser, { source: 'task', items: [{ type: 'task', internalId: taskAlreadyDone!.id, summary: 'Pagar suscripción de internet' }] });

    untrustedResultMock(vi.spyOn(aiClient, 'callChatCompletion')).mockResolvedValue(finalSafetyMessage('completeDisplayed'));

    const res = await routeMessage('Ya pagué el internet', testUser) as unknown as FixtureRoute;
    expect(res.confirmation).toContain('Tarea ya completada');
    expect(res.confirmation).toContain('Pagar suscripción de internet');
    const { data: unchanged, error: unchangedError } = await (supabase as unknown as FixtureClient).from('tasks').select('*').eq('id', taskAlreadyDone!.id).single();
    expect(unchangedError).toBeNull();
    expect(unchanged).toEqual(taskAlreadyDone);
  });
});
