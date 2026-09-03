import 'dotenv/config';
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { routeMessage } from '../src/ai/router.js';
import { executeTool } from '../src/ai/tools.js';
import { getUnifiedAgenda } from '../src/services/unifiedAgendaService.js';
import { saveWorkingMemory, getWorkingMemory, clearWorkingMemory, sanitizeResponseText } from '../src/ai/workingMemory.js';
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
} from '../src/db/index.js';
import * as googleCalendarService from '../src/services/googleCalendar.js';
import * as aiClient from '../src/ai/client.js';

describe('Agent Behavioral Contract & End-to-End Orchestration Test Suite', () => {
  const testPhone = '573990001122';
  let testUser = null;

  beforeAll(async () => {
    testUser = await getOrCreateUserByPhone(testPhone, 'America/Bogota', 'es-CO', 'Behavioral Test User');
  });

  beforeEach(async () => {
    vi.restoreAllMocks();
    clearWorkingMemory(testPhone);
    clearWorkingMemory(testUser.id);
    if (testUser?.id) {
      await supabase.from('reminders').delete().or(`user_id.eq.${testUser.id},phone_number.eq.${testPhone}`);
      await supabase.from('tasks').delete().eq('user_id', testUser.id);
    }
  });

  afterAll(async () => {
    if (testUser?.id) {
      await deleteUserIntegration(testUser.id, 'google');
      await supabase.from('reminders').delete().or(`user_id.eq.${testUser.id},phone_number.eq.${testPhone}`);
      await supabase.from('tasks').delete().eq('user_id', testUser.id);
    }
  });

  // TEST 1: Unified Agenda selection for temporal question
  it('TEST 1: "¿Qué tengo mañana?" selects Unified Agenda and aggregates Calendar + Reminder + Task', async () => {
    await saveUserIntegration(testUser.id, {
      provider: 'google',
      accessToken: 'valid-mock-token',
      refreshToken: 'valid-mock-refresh',
      accountEmail: 'behavioral@gmail.com',
    });

    const listEventsSpy = vi.spyOn(googleCalendarService, 'listCalendarEvents').mockResolvedValue([
      { summary: 'Cita Médica Dr. Pérez', start: '2026-09-03T08:00:00-05:00', end: '2026-09-03T09:00:00-05:00' },
    ]);

    const tomorrowDate = new Date();
    tomorrowDate.setDate(tomorrowDate.getDate() + 1);
    tomorrowDate.setHours(10, 0, 0, 0);

    await saveReminder({
      userId: testUser.id,
      phoneNumber: testPhone,
      content: 'Tomar pastilla para la tensión',
      sendAt: tomorrowDate.toISOString(),
      requiresConfirmation: true,
    });

    await createTask({
      userId: testUser.id,
      title: 'Enviar reporte mensual de ventas',
      dueDate: tomorrowDate.toISOString(),
      priority: 'high',
    });

    vi.spyOn(aiClient, 'callChatCompletion').mockResolvedValue(JSON.stringify({
      reasoning: "El usuario consulta su agenda para mañana. Debo usar get_unified_agenda.",
      type: "tool_call",
      tool: "get_unified_agenda",
      params: { scope: "tomorrow" },
      intent: "unified_agenda",
    }));

    const res = await routeMessage('¿Qué tengo mañana?', testUser);

    expect(res.intent).toBe('unified_agenda');
    expect(res.confirmation).toContain('CALENDARIO');
    expect(res.confirmation).toContain('Cita Médica Dr. Pérez');
    expect(res.confirmation).toContain('RECORDATORIOS');
    expect(res.confirmation).toContain('Tomar pastilla para la tensión');
    expect(res.confirmation).toContain('TAREAS');
    expect(res.confirmation).toContain('Enviar reporte mensual de ventas');

    const wm = getWorkingMemory(testUser);
    expect(wm).not.toBeNull();
    expect(wm.source).toBe('unified');
    expect(wm.items.length).toBeGreaterThanOrEqual(2);

    listEventsSpy.mockRestore();
  });

  // TEST 2: Explicit Google Calendar query
  it('TEST 2: "¿Qué tengo en Google Calendar mañana?" selects Calendar tool, NOT Unified Agenda', async () => {
    await saveUserIntegration(testUser.id, {
      provider: 'google',
      accessToken: 'valid-mock-token',
      refreshToken: 'valid-mock-refresh',
      accountEmail: 'behavioral@gmail.com',
    });

    const listEventsSpy = vi.spyOn(googleCalendarService, 'listCalendarEvents').mockResolvedValue([
      { summary: 'Reunión de Directorio', start: '2026-09-03T14:00:00-05:00', end: '2026-09-03T15:00:00-05:00' },
    ]);

    vi.spyOn(aiClient, 'callChatCompletion').mockResolvedValue(JSON.stringify({
      reasoning: "El usuario consulta específicamente Google Calendar.",
      type: "tool_call",
      tool: "manage_google_calendar",
      params: { action: "list_events", scope: "tomorrow" },
      intent: "calendar",
    }));

    const res = await routeMessage('¿Qué tengo en Google Calendar mañana?', testUser);

    expect(res.intent).toBe('calendar');
    expect(res.entities?.action).toBe('list_events');
    expect(res.confirmation).toContain('Reunión de Directorio');

    listEventsSpy.mockRestore();
  });

  // TEST 3: Explicit Reminders query
  it('TEST 3: "¿Qué recordatorios tengo?" routes to manage_reminder list', async () => {
    const tomorrowDate = new Date();
    tomorrowDate.setDate(tomorrowDate.getDate() + 1);
    await saveReminder({
      userId: testUser.id,
      phoneNumber: testPhone,
      content: 'Comprar alimento para Borona',
      sendAt: tomorrowDate.toISOString(),
    });

    vi.spyOn(aiClient, 'callChatCompletion').mockResolvedValue(JSON.stringify({
      reasoning: "El usuario pide ver sus recordatorios.",
      type: "tool_call",
      tool: "manage_reminder",
      params: { action: "list" },
      intent: "reminder",
    }));

    const res = await routeMessage('¿Qué recordatorios tengo?', testUser);

    expect(res.intent).toBe('reminder');
    expect(res.confirmation).toContain('Comprar alimento para Borona');
  });

  // TEST 4: Explicit Tasks query
  it('TEST 4: "¿Cuáles son mis tareas?" routes to manage_task list', async () => {
    await createTask({
      userId: testUser.id,
      title: 'Revisar métricas del sprint',
      priority: 'urgent',
    });

    vi.spyOn(aiClient, 'callChatCompletion').mockResolvedValue(JSON.stringify({
      reasoning: "El usuario consulta sus tareas.",
      type: "tool_call",
      tool: "manage_task",
      params: { action: "list" },
      intent: "task",
    }));

    const res = await routeMessage('¿Cuáles son mis tareas?', testUser);

    expect(res.intent).toBe('task');
    expect(res.confirmation).toContain('Revisar métricas del sprint');
  });

  // TEST 5: Birthday filter in Google Calendar
  it('TEST 5: "¿Qué cumpleaños tengo en Google Calendar?" routes to Calendar search with birthday filter', async () => {
    await saveUserIntegration(testUser.id, {
      provider: 'google',
      accessToken: 'valid-mock-token',
      refreshToken: 'valid-mock-refresh',
      accountEmail: 'behavioral@gmail.com',
    });

    const searchEventsSpy = vi.spyOn(googleCalendarService, 'listCalendarEvents').mockResolvedValue([
      { summary: 'Cumpleaños de Valentina', start: '2026-10-15', end: '2026-10-16' },
    ]);

    vi.spyOn(aiClient, 'callChatCompletion').mockResolvedValue(JSON.stringify({
      reasoning: "Búsqueda de eventos tipo cumpleaños en Google Calendar para todo el año.",
      type: "tool_call",
      tool: "manage_google_calendar",
      params: { action: "search_events", scope: "full_year", query: "cumpleaños" },
      intent: "calendar",
    }));

    const res = await routeMessage('¿Qué cumpleaños tengo en Google Calendar?', testUser);

    expect(res.intent).toBe('calendar');
    expect(res.entities?.action).toBe('search_events');
    expect(res.entities?.query).toMatch(/cumpleaños|birthday/i);

    searchEventsSpy.mockRestore();
  });

  // TEST 6: Memory query
  it('TEST 6: "¿Qué sabes de mi cumpleaños?" queries persistent memory', async () => {
    vi.spyOn(aiClient, 'callChatCompletion').mockResolvedValue(JSON.stringify({
      reasoning: "El usuario pregunta sobre una memoria de cumpleaños.",
      type: "chat",
      tool: null,
      reply: "Según lo que recuerdo, tu cumpleaños es el 14 de octubre.",
      intent: "memory",
    }));

    const res = await routeMessage('¿Qué sabes de mi cumpleaños?', testUser);

    expect(res.intent === 'memory' || res.intent === 'chat').toBe(true);
    expect(res.confirmation).toContain('14 de octubre');
  });

  // TEST 7: Acknowledge with semantic variation mutates DB
  it('TEST 7: "Ya hablé con la veterinaria" acknowledges reminder and updates acknowledged_at in DB', async () => {
    const saved = await saveReminder({
      userId: testUser.id,
      phoneNumber: testPhone,
      content: 'Escribirle a la veterinaria para comprar más vendaje a Borona',
      sendAt: new Date().toISOString(),
      requiresConfirmation: true,
    });

    vi.spyOn(aiClient, 'callChatCompletion').mockResolvedValue(JSON.stringify({
      reasoning: "El usuario confirma que ya realizó la acción del recordatorio activo sobre la veterinaria.",
      type: "tool_call",
      tool: "manage_reminder",
      params: { action: "acknowledge", target: "veterinaria" },
      intent: "reminder",
    }));

    const res = await routeMessage('Ya hablé con la veterinaria.', testUser);

    expect(res.intent).toBe('reminder');
    expect(res.confirmation).toContain('confirmado');

    const { data: updatedRem } = await supabase.from('reminders').select('*').eq('id', saved.id).single();
    expect(updatedRem.acknowledged_at).not.toBeNull();
  });

  // TEST 8: Linguistic variations for Acknowledge
  it('TEST 8: Linguistic variations ("Ya le escribí", "Ya compré el vendaje") acknowledge correctly', async () => {
    const saved = await saveReminder({
      userId: testUser.id,
      phoneNumber: testPhone,
      content: 'Comprar más vendaje a Borona en la droguería',
      sendAt: new Date().toISOString(),
      requiresConfirmation: true,
    });

    vi.spyOn(aiClient, 'callChatCompletion').mockResolvedValue(JSON.stringify({
      reasoning: "El usuario confirma que ya compró el vendaje para Borona.",
      type: "tool_call",
      tool: "manage_reminder",
      params: { action: "acknowledge", target: "vendaje" },
      intent: "reminder",
    }));

    const res = await routeMessage('Ya compré el vendaje para Borona', testUser);

    expect(res.intent).toBe('reminder');
    expect(res.confirmation).toContain('confirmado');

    const { data: updatedRem } = await supabase.from('reminders').select('*').eq('id', saved.id).single();
    expect(updatedRem.acknowledged_at).not.toBeNull();
  });

  // TEST 9: Ambiguous candidates -> asks clarification, ZERO database mutations
  it('TEST 9: Multiple ambiguous reminders trigger clarification question and DO NOT mutate DB', async () => {
    const rem1 = await saveReminder({
      userId: testUser.id,
      phoneNumber: testPhone,
      content: 'Llamar a la doctora María para la cita de control',
      sendAt: new Date().toISOString(),
      requiresConfirmation: true,
    });

    const rem2 = await saveReminder({
      userId: testUser.id,
      phoneNumber: testPhone,
      content: 'Llamar a la doctora Marcela para los exámenes',
      sendAt: new Date().toISOString(),
      requiresConfirmation: true,
    });

    vi.spyOn(aiClient, 'callChatCompletion').mockResolvedValue(JSON.stringify({
      reasoning: "El usuario dice 'Ya llamé a la doctora', intento confirmar.",
      type: "tool_call",
      tool: "manage_reminder",
      params: { action: "acknowledge", target: "doctora" },
      intent: "reminder",
    }));

    const res = await routeMessage('Ya llamé a la doctora', testUser);

    expect(res.confirmation).toMatch(/más de un recordatorio|múltiples recordatorios|aclara cuál|especifica/i);

    // Verify ZERO mutations in DB
    const { data: r1 } = await supabase.from('reminders').select('*').eq('id', rem1.id).single();
    const { data: r2 } = await supabase.from('reminders').select('*').eq('id', rem2.id).single();
    expect(r1.acknowledged_at).toBeNull();
    expect(r2.acknowledged_at).toBeNull();
  });

  // TEST 10: Calendar disconnected preserves Reminder and Task
  it('TEST 10: Disconnected Calendar retains Reminders and Tasks in Unified Agenda', async () => {
    await deleteUserIntegration(testUser.id, 'google');

    const tomorrowDate = new Date();
    tomorrowDate.setDate(tomorrowDate.getDate() + 1);
    tomorrowDate.setHours(9, 0, 0, 0);

    await saveReminder({
      userId: testUser.id,
      phoneNumber: testPhone,
      content: 'Tomar vitamina C',
      sendAt: tomorrowDate.toISOString(),
    });

    await createTask({
      userId: testUser.id,
      title: 'Pagar factura de internet',
      dueDate: tomorrowDate.toISOString(),
    });

    vi.spyOn(aiClient, 'callChatCompletion').mockResolvedValue(JSON.stringify({
      reasoning: "Consulta de agenda para mañana con get_unified_agenda.",
      type: "tool_call",
      tool: "get_unified_agenda",
      params: { scope: "tomorrow" },
      intent: "unified_agenda",
    }));

    const res = await routeMessage('¿Qué tengo mañana?', testUser);

    expect(res.intent).toBe('unified_agenda');
    expect(res.confirmation).toContain('Tomar vitamina C');
    expect(res.confirmation).toContain('Pagar factura de internet');
    expect(res.confirmation).not.toMatch(/No tienes eventos.*ni tareas/i);
  });

  // TEST 11: Calendar error does NOT mean empty agenda
  it('TEST 11: Calendar error is handled gracefully and preserves available Reminders and Tasks', async () => {
    await saveUserIntegration(testUser.id, {
      provider: 'google',
      accessToken: 'bad-token',
      refreshToken: 'bad-refresh',
      accountEmail: 'error@gmail.com',
    });

    const listEventsSpy = vi.spyOn(googleCalendarService, 'listCalendarEvents').mockRejectedValue(new Error('Google API 503 Service Unavailable'));

    const tomorrowDate = new Date();
    tomorrowDate.setDate(tomorrowDate.getDate() + 1);
    tomorrowDate.setHours(9, 0, 0, 0);

    await saveReminder({
      userId: testUser.id,
      phoneNumber: testPhone,
      content: 'Revisar correo urgente',
      sendAt: tomorrowDate.toISOString(),
    });

    const agenda = await getUnifiedAgenda({
      userId: testUser.id,
      phoneNumber: testPhone,
      timezone: 'America/Bogota',
      scope: 'tomorrow',
    });

    expect(agenda.calendar.state).toBe('ERROR');
    expect(agenda.reminders.length).toBe(1);
    expect(agenda.formattedCard).toContain('Revisar correo urgente');
    expect(agenda.formattedCard).toContain('Google Calendar no disponible temporalmente');

    listEventsSpy.mockRestore();
  });

  // TEST 12: Multi-turn continuation with Working Memory & Ordinal reference
  it('TEST 12: Multi-turn: T1 agenda -> T2 relative inquiry -> T3 relative mutation cancels correct item in DB', async () => {
    const tomorrow1 = new Date();
    tomorrow1.setDate(tomorrow1.getDate() + 1);
    tomorrow1.setHours(8, 0, 0, 0);

    const tomorrow2 = new Date();
    tomorrow2.setDate(tomorrow2.getDate() + 1);
    tomorrow2.setHours(11, 0, 0, 0);

    const r1 = await saveReminder({
      userId: testUser.id,
      phoneNumber: testPhone,
      content: 'Cita con el dentista a las 8am',
      sendAt: tomorrow1.toISOString(),
    });

    const r2 = await saveReminder({
      userId: testUser.id,
      phoneNumber: testPhone,
      content: 'Almuerzo con el cliente a las 11am',
      sendAt: tomorrow2.toISOString(),
    });

    // Turn 1: List agenda
    vi.spyOn(aiClient, 'callChatCompletion').mockResolvedValueOnce(JSON.stringify({
      reasoning: "Listar agenda de mañana con get_unified_agenda.",
      type: "tool_call",
      tool: "get_unified_agenda",
      params: { scope: "tomorrow" },
      intent: "unified_agenda",
    }));

    const t1Res = await routeMessage('¿Qué tengo mañana?', testUser);
    expect(t1Res.confirmation).toContain('Cita con el dentista');

    // Turn 2: Relative question using working memory
    vi.spyOn(aiClient, 'callChatCompletion').mockResolvedValueOnce(JSON.stringify({
      reasoning: "El usuario pregunta cuál es el más temprano según la memoria de trabajo.",
      type: "chat",
      tool: null,
      reply: "El compromiso más temprano es la Cita con el dentista a las 8:00 AM.",
      intent: "query",
    }));

    const historyT2 = [
      { role: 'user', content: '¿Qué tengo mañana?' },
      { role: 'assistant', content: t1Res.confirmation },
    ];
    const t2Res = await routeMessage('¿Cuál es el más temprano?', testUser, historyT2);
    expect(t2Res.confirmation).toContain('dentista');

    // Turn 3: Relative mutation "cancela el primero"
    vi.spyOn(aiClient, 'callChatCompletion').mockResolvedValueOnce(JSON.stringify({
      reasoning: "El usuario pide cancelar el primer elemento de la lista.",
      type: "tool_call",
      tool: "manage_reminder",
      params: { action: "cancel", target: "1" },
      intent: "reminder",
    }));

    const historyT3 = [
      ...historyT2,
      { role: 'user', content: '¿Cuál es el más temprano?' },
      { role: 'assistant', content: t2Res.confirmation },
    ];
    const t3Res = await routeMessage('Cancela el primero', testUser, historyT3);
    expect(t3Res.confirmation).toContain('cancelado');

    // Verify DB: r1 cancelled, r2 still pending
    const { data: checkR1 } = await supabase.from('reminders').select('*').eq('id', r1.id).single();
    const { data: checkR2 } = await supabase.from('reminders').select('*').eq('id', r2.id).single();
    expect(checkR1.status).toBe('cancelled');
    expect(checkR2.status).toBe('pending');
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
    vi.spyOn(aiClient, 'callChatCompletion').mockResolvedValue(JSON.stringify({
      reasoning: "Operación compuesta: crear recordatorio y crear tarea.",
      type: "tool_call",
      tool: "manage_reminder",
      params: {
        action: "create",
        items: [{ content: "Llamar al banco", targetTime: "5:00 PM" }],
      },
      secondary_plan: {
        tool: "manage_task",
        params: {
          action: "create",
          items: [{ title: "Reporte de finanzas", entityName: "Proyecto Alfa" }],
        },
      },
      intent: "reminder",
    }));

    const res = await routeMessage('Recuérdame hoy a las 5pm llamar al banco y crea la tarea reporte de finanzas en Proyecto Alfa', testUser);

    expect(res.confirmation).toBeDefined();

    // Verify both records created in DB
    const { data: rems } = await supabase.from('reminders').select('*').eq('user_id', testUser.id);
    const { data: tasks } = await supabase.from('tasks').select('*').eq('user_id', testUser.id);

    expect(rems.length).toBeGreaterThanOrEqual(1);
    expect(rems.some(r => r.content.includes('banco') || r.content.includes('Banco'))).toBe(true);

    expect(tasks.length).toBeGreaterThanOrEqual(1);
    expect(tasks.some(t => t.title.includes('reporte') || t.title.includes('Reporte') || t.title.includes('finanzas'))).toBe(true);
  });

  // TEST 15 (Negative): Ambiguous / question input never triggers accidental completion or deletion
  it('TEST 15 (Negative): Informative question "¿cómo así?" or "¿qué pasó?" never executes mutation', async () => {
    await saveReminder({
      userId: testUser.id,
      phoneNumber: testPhone,
      content: 'Comprar café',
      sendAt: new Date().toISOString(),
    });

    vi.spyOn(aiClient, 'callChatCompletion').mockResolvedValue(JSON.stringify({
      reasoning: "Pregunta aclaratoria / duda del usuario.",
      type: "chat",
      tool: null,
      reply: "¿En qué te puedo colaborar o aclarar? Cuéntame y con gusto revisamos.",
      intent: "chat",
    }));

    const res = await routeMessage('¿cómo así? no entendí lo que dijiste', testUser);

    expect(res.intent).toBe('chat');
    expect(res.confirmation).not.toMatch(/cancelado|completado|eliminado/i);

    const { data: rems } = await supabase.from('reminders').select('*').eq('user_id', testUser.id).eq('status', 'pending');
    expect(rems.length).toBe(1);
  });

  // TEST 16 (Negative): Non-existent target fails with clear error and NO false green
  it('TEST 16 (Negative): Non-existent reminder ID returns NOT_FOUND error and does NOT report false success', async () => {
    const toolRes = await executeTool({
      toolName: 'manage_reminder',
      params: { action: 'cancel', reminderId: 'non-existent-uuid-12345678' },
      user: testUser,
      language: 'es',
    });

    expect(toolRes.success).toBe(false);
    expect(toolRes.errorCode).toBe('NOT_FOUND');
    expect(toolRes.confirmation).toContain('No se encontró');
  });

  // TEST 17: Creating Google Calendar event automatically creates a linked WhatsApp reminder
  it('TEST 17: Creating Google Calendar event creates synchronized WhatsApp reminder', async () => {
    await saveUserIntegration(testUser.id, {
      provider: 'google',
      accessToken: 'valid-mock-token',
      refreshToken: 'valid-mock-refresh',
      accountEmail: 'calendar-sync@gmail.com',
    });

    const createEventSpy = vi.spyOn(googleCalendarService, 'createCalendarEvent').mockResolvedValue({
      id: 'gcal-event-12345',
      summary: 'Reunión de trabajo',
      startDateTime: '2026-09-03T14:00:00.000Z',
      endDateTime: '2026-09-03T15:00:00.000Z',
      meetLink: 'https://meet.google.com/abc-defg-hij',
    });

    vi.spyOn(aiClient, 'callChatCompletion').mockResolvedValue(JSON.stringify({
      reasoning: "El usuario agenda una reunión en Google Calendar.",
      type: "tool_call",
      tool: "manage_google_calendar",
      params: { action: "create_event", summary: "Reunión de trabajo", startDateTime: "2026-09-03T14:00:00-05:00" },
      intent: "calendar",
    }));

    const res = await routeMessage('mañana tengo una reunión del trabajo a las 9am', testUser);

    expect(res.intent).toBe('calendar');
    expect(res.confirmation).toContain('Evento agendado en Google Calendar');
    expect(res.confirmation).toContain('Recordatorio programado en WhatsApp');

    // Verify reminder was created in DB
    const { data: rems } = await supabase.from('reminders').select('*').eq('user_id', testUser.id);
    expect(rems.length).toBeGreaterThanOrEqual(1);
    expect(rems.some(r => r.content.includes('Reunión de trabajo'))).toBe(true);

    createEventSpy.mockRestore();
  });

  // TEST 18: "Avísame 15 minutos antes" creates a NEW advance notice reminder and does NOT replace the original
  it('TEST 18: "Avísame 15 minutos antes" creates a NEW advance notice reminder and leaves original intact', async () => {
    const mainTime = new Date();
    mainTime.setDate(mainTime.getDate() + 1);
    mainTime.setHours(10, 0, 0, 0);

    const mainRem = await saveReminder({
      userId: testUser.id,
      phoneNumber: testPhone,
      content: 'Cita con el cliente',
      sendAt: mainTime.toISOString(),
      requiresConfirmation: true,
    });

    // LLM creates a new advance notice reminder or routes update with advance notice
    vi.spyOn(aiClient, 'callChatCompletion').mockResolvedValue(JSON.stringify({
      reasoning: "El usuario pide un aviso previo 15 minutos antes de su cita.",
      type: "tool_call",
      tool: "manage_reminder",
      params: {
        action: "create",
        items: [{
          content: "[Aviso previo] Cita con el cliente",
          targetTime: new Date(mainTime.getTime() - 15 * 60 * 1000).toISOString(),
        }],
      },
      intent: "reminder",
    }));

    const history = [
      { role: 'user', content: 'Recuérdame la cita con el cliente mañana a las 10am' },
      { role: 'assistant', content: '✅ Recordatorio programado para las 10:00 AM' },
    ];

    const res = await routeMessage('Recuérdame 15 minutos antes', testUser, history);

    expect(res.intent).toBe('reminder');

    // Verify DB: BOTH reminders exist! The 10:00 AM main reminder and the 9:45 AM advance reminder
    const { data: rems } = await supabase.from('reminders').select('*').eq('user_id', testUser.id).eq('status', 'pending');
    expect(rems.length).toBe(2);

    const original = rems.find(r => r.id === mainRem.id);
    expect(original).toBeDefined();
    expect(new Date(original.send_at).getTime()).toBe(mainTime.getTime()); // UNTOUCHED!

    const advance = rems.find(r => r.id !== mainRem.id);
    expect(advance).toBeDefined();
    expect(new Date(advance.send_at).getTime()).toBe(mainTime.getTime() - 15 * 60 * 1000);
  });

  // TEST 19: Explicit date in update_event bounds lookup to that specific date and ignores unrelated Working Memory from previous turn
  it('TEST 19: "9 de septiembre" explicitly sets timeMin/timeMax of Calendar lookup and ignores Sept 3 Working Memory', async () => {
    await saveUserIntegration(testUser.id, {
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
    let capturedListParams = null;
    const listEventsSpy = vi.spyOn(googleCalendarService, 'listCalendarEvents').mockImplementation(async (userId, options) => {
      capturedListParams = options;
      // Google Calendar returns 1 single event on September 9
      return [
        { id: 'gcal-sept-9-event-uuid', summary: 'Cita previa con proveedor', start: '2026-09-09T10:00:00-05:00', end: '2026-09-09T11:00:00-05:00' },
      ];
    });

    let capturedUpdateParams = null;
    const updateEventSpy = vi.spyOn(googleCalendarService, 'updateCalendarEvent').mockImplementation(async (userId, options) => {
      capturedUpdateParams = options;
      return { id: options.eventId, summary: options.summary };
    });

    // 3. Mock LLM emitting tool_call with explicit date parameter extracted from user request
    vi.spyOn(aiClient, 'callChatCompletion').mockResolvedValue(JSON.stringify({
      reasoning: "El usuario actualiza la cita del 9 de septiembre a Reunión en Ceramica italia de barranquilla.",
      type: "tool_call",
      tool: "manage_google_calendar",
      params: {
        action: "update_event",
        date: "2026-09-09",
        target: "cita",
        summary: "Reunión en Ceramica italia de barranquilla",
      },
      intent: "calendar",
    }));

    const historyTurn1 = [
      { role: 'user', content: '¿Entonces que tenemos para mañana?' },
      { role: 'assistant', content: 'Tienes 2 reuniones de trabajo agendadas.' },
    ];

    const res = await routeMessage(
      'la cita que tengo el 9 de septiembre ahora es -> Reunión en Ceramica italia de barranquilla',
      testUser,
      historyTurn1
    );

    // 4. Strict Behavioral Assertions:
    // Assert 1: The tool call must have queried Calendar specifically for September 9
    expect(capturedListParams).not.toBeNull();
    const timeMinStr = new Date(capturedListParams.timeMin).toISOString();
    const timeMaxStr = new Date(capturedListParams.timeMax).toISOString();

    // Must be bounded to 2026-09-09 (and NOT 2026-09-03)
    expect(timeMinStr).toMatch(/^2026-09-09/);
    expect(timeMaxStr).toMatch(/^2026-09-10/);

    // Assert 2: updateCalendarEvent must be invoked with the resolved September 9 event ID (and NOT the September 3 ones)
    expect(capturedUpdateParams).not.toBeNull();
    expect(capturedUpdateParams.eventId).toBe('gcal-sept-9-event-uuid');
    expect(capturedUpdateParams.summary).toBe('Reunión en Ceramica italia de barranquilla');

    // Assert 3: The user confirmation must report success and NOT "Hay múltiples eventos que coinciden"
    expect(res.confirmation).toContain('Evento actualizado en Google Calendar');
    expect(res.confirmation).toContain('Reunión en Ceramica italia de barranquilla');
    expect(res.confirmation).not.toContain('múltiples eventos');

    listEventsSpy.mockRestore();
    updateEventSpy.mockRestore();
  });

  // TEST 20: "Dame todos mis pendientes" uses upcoming scope, excludes past morning reminders, and includes future dates
  it('TEST 20: "Dame todos mis pendientes porfa" routes to scope: upcoming and presents multi-day chronological schedule', async () => {
    // 1. Create a past morning reminder (8:00 AM today), a future reminder (tomorrow 8:00 AM), and a far future reminder (Sept 9)
    const now = new Date();
    const pastSendAt = new Date(now.getTime() - 2 * 60 * 60 * 1000).toISOString(); // 2 hours ago
    const tomorrowSendAt = new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString(); // tomorrow
    const sept9SendAt = new Date('2026-09-09T10:00:00-05:00').toISOString();

    await supabase.from('reminders').insert([
      { user_id: testUser.id, phone_number: testUser.phone_number, content: 'Recordatorio pasado de la mañana', send_at: pastSendAt, status: 'pending' },
      { user_id: testUser.id, phone_number: testUser.phone_number, content: 'Cita médica mañana', send_at: tomorrowSendAt, status: 'pending' },
      { user_id: testUser.id, phone_number: testUser.phone_number, content: 'Reunión en Cerámica Italia', send_at: sept9SendAt, status: 'pending' },
    ]);

    vi.spyOn(aiClient, 'callChatCompletion').mockResolvedValue(JSON.stringify({
      reasoning: "El usuario pide todos sus pendientes en general.",
      type: "tool_call",
      tool: "get_unified_agenda",
      params: { scope: "upcoming" },
      intent: "query",
    }));

    const res = await routeMessage('Dame todos mis pendientes porfa', testUser);

    expect(res.intent).toBe('unified_agenda');
    expect(res.confirmation).toContain('Tu agenda');
    expect(res.confirmation).toContain('Cita médica mañana');
    expect(res.confirmation).toContain('Reunión en Cerámica Italia');
    // Past reminder is excluded from upcoming agenda
    expect(res.confirmation).not.toContain('Recordatorio pasado de la mañana');
  });

  // TEST 21: Conversational affirmation "Ya fui" acknowledges the active nudge reminder without error
  it('TEST 21: Conversational confirmation "Ya fui" to a nudge acknowledges the active reminder in DB', async () => {
    // Insert an active nudged reminder for the user
    const { data: insertedRem } = await supabase.from('reminders').insert({
      user_id: testUser.id,
      phone_number: testUser.phone_number,
      content: 'Ir al baño',
      send_at: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
      status: 'sent',
      requires_confirmation: true,
      nudge_count: 1,
      last_nudged_at: new Date().toISOString(),
    }).select('*').single();

    vi.spyOn(aiClient, 'callChatCompletion').mockResolvedValue(JSON.stringify({
      reasoning: "El usuario responde al aviso de ir al baño confirmando que ya fue.",
      type: "tool_call",
      tool: "manage_reminder",
      params: { action: "acknowledge", target: "fui" },
      intent: "reminder",
    }));

    const historyWithNudge = [
      { role: 'assistant', content: '🔔 Recordatorio pendiente: Ir al baño (Aviso #1). Escribe "Listo" o "OK" cuando lo hayas completado.' },
    ];

    const res = await routeMessage('Ya fui', testUser, historyWithNudge);

    expect(res.intent).toBe('reminder');
    expect(res.confirmation).toContain('Recordatorio confirmado');
    expect(res.confirmation).toContain('Ir al baño');
    expect(res.confirmation).not.toContain('No se encontró el recordatorio');

    // Verify DB: reminder is acknowledged
    const { data: updatedDb } = await supabase.from('reminders').select('*').eq('id', insertedRem.id).single();
    expect(updatedDb.acknowledged_at).not.toBeNull();
  });
});
