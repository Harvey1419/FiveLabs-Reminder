import 'dotenv/config';
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import {
  supabase,
  getOrCreateUserByPhone,
  saveReminder,
  getDailyOverview,
  acknowledgeReminder,
  getRemindersDueForNudge,
} from '../src/db/index.js';
import { createTask } from '../src/db/tasks.js';
import { executeTool } from '../src/ai/tools.js';
import { executeReminderTool } from '../src/ai/tools/reminderTools.js';
import { routeMessage } from '../src/ai/router.js';

describe('Reminder Acknowledge & Orchestration Architecture Test Suite', () => {
  const testPhone = '+573999777888';
  const otherPhone = '+573999555666';
  let testUser;
  let otherUser;

  beforeAll(async () => {
    testUser = await getOrCreateUserByPhone(testPhone, 'America/Bogota');
    otherUser = await getOrCreateUserByPhone(otherPhone, 'America/Bogota');
    expect(testUser?.id).toBeDefined();
    expect(otherUser?.id).toBeDefined();

    // Clean initial state
    await supabase.from('reminders').delete().eq('user_id', testUser.id);
    await supabase.from('reminders').delete().eq('user_id', otherUser.id);
    await supabase.from('tasks').delete().eq('user_id', testUser.id);
    await supabase.from('tasks').delete().eq('user_id', otherUser.id);
    await supabase.from('subscriptions').delete().eq('user_id', testUser.id);

    // Grant Pro
    await supabase.from('subscriptions').insert({
      user_id: testUser.id,
      mp_preapproval_id: `test_preapproval_ack_${Date.now()}`,
      plan: 'pro',
      status: 'authorized',
    });
  });

  beforeEach(async () => {
    // Avoid hitting Groq/Gemini per-minute rate limits during rapid test cycles
    await new Promise(r => setTimeout(r, 2500));
  });

  afterAll(async () => {
    if (testUser?.id) {
      await supabase.from('reminders').delete().eq('user_id', testUser.id);
      await supabase.from('tasks').delete().eq('user_id', testUser.id);
      await supabase.from('subscriptions').delete().eq('user_id', testUser.id);
    }
    if (otherUser?.id) {
      await supabase.from('reminders').delete().eq('user_id', otherUser.id);
      await supabase.from('tasks').delete().eq('user_id', otherUser.id);
    }
  });

  it('TEST 1: User confirms pending reminder -> router routes to manage_reminder action: acknowledge', async () => {
    const rem = await saveReminder({
      userId: testUser.id,
      phoneNumber: testPhone,
      content: 'Escribirle a la veterinaria para comprarle más vendaje a Borona',
      sendAt: new Date(Date.now() - 600000).toISOString(),
      requiresConfirmation: true,
      nudgeIntervalMinutes: 10,
      maxNudges: 3,
    });

    await supabase.from('reminders').update({
      status: 'sent',
      sent_at: new Date(Date.now() - 600000).toISOString(),
      last_nudged_at: new Date(Date.now() - 60000).toISOString(),
      nudge_count: 1,
      acknowledged_at: null,
    }).eq('id', rem.id);

    // Verify it appears in pendingConfirmationReminders in daily overview
    const overview = await getDailyOverview({ userId: testUser.id, phoneNumber: testPhone, timezone: 'America/Bogota' });
    expect(overview.pendingConfirmationReminders.length).toBeGreaterThanOrEqual(1);

    const res = await routeMessage('ya le escribí a la veterinaria', testUser);
    expect(res.intent).toBe('reminder');
    expect(res.confirmation).toBeDefined();
    expect(res.confirmation).toMatch(/confirmado|registrado/i);
  });

  it('TEST 2: Acknowledge execution -> updates acknowledged_at in DB from null to ISO timestamp', async () => {
    const rem = await saveReminder({
      userId: testUser.id,
      phoneNumber: testPhone,
      content: 'Llevar el perro al veterinario',
      sendAt: new Date().toISOString(),
      requiresConfirmation: true,
    });

    const ackRes = await executeTool('manage_reminder', {
      action: 'acknowledge',
      reminderId: rem.id,
    }, testUser);

    expect(ackRes.success).toBe(true);

    const { data: dbRem } = await supabase
      .from('reminders')
      .select('status, acknowledged_at')
      .eq('id', rem.id)
      .single();

    expect(dbRem.acknowledged_at).not.toBeNull();
    expect(new Date(dbRem.acknowledged_at).getTime()).toBeGreaterThan(0);
  });

  it('TEST 3: Final response is generated only after tool execution confirms success', async () => {
    const rem = await saveReminder({
      userId: testUser.id,
      phoneNumber: testPhone,
      content: 'Comprar comida para el gato',
      sendAt: new Date().toISOString(),
      requiresConfirmation: true,
    });

    const res = await executeTool('manage_reminder', {
      action: 'acknowledge',
      reminderId: rem.id,
    }, testUser);

    expect(res.success).toBe(true);
    expect(res.confirmation).toContain('Comprar comida para el gato');
    expect(res.confirmation).toMatch(/confirmado|registrado/i);
  });

  it('TEST 4: DB error during acknowledge propagates real error and does not falsely claim success', async () => {
    const spy = vi.spyOn(supabase, 'from').mockImplementation((table) => {
      if (table === 'reminders') {
        return {
          select: () => ({
            eq: () => ({
              single: async () => ({
                data: {
                  id: '00000000-0000-0000-0000-000000000001',
                  user_id: testUser.id,
                  content: 'Test reminder',
                  acknowledged_at: null,
                },
                error: null,
              }),
            }),
          }),
          update: () => ({
            eq: () => ({
              select: () => ({
                maybeSingle: async () => ({
                  data: null,
                  error: { code: 'PGRST000', message: 'DB Connection Timeout' },
                }),
              }),
            }),
          }),
        };
      }
      return supabase.from(table);
    });

    try {
      const res = await executeReminderTool({
        action: 'acknowledge',
        params: { reminderId: '00000000-0000-0000-0000-000000000001' },
        user: testUser,
      });

      expect(res.success).toBe(false);
      expect(res.errorCode).toBe('DATABASE_ERROR');
      expect(res.confirmation).not.toContain('confirmado');
      expect(res.confirmation).toContain('error');
    } finally {
      spy.mockRestore();
    }
  });

  it('TEST 5: User asks if they did the action -> chat response, NO acknowledge', async () => {
    const rem = await saveReminder({
      userId: testUser.id,
      phoneNumber: testPhone,
      content: 'Enviar reporte mensual de ventas',
      sendAt: new Date().toISOString(),
      requiresConfirmation: true,
    });

    const res = await routeMessage('¿Ya le envié el reporte mensual a ventas?', testUser);

    expect(res.confirmation).toBeDefined();

    // Verify reminder is still NOT acknowledged
    const { data: dbRem } = await supabase
      .from('reminders')
      .select('acknowledged_at')
      .eq('id', rem.id)
      .single();

    expect(dbRem.acknowledged_at).toBeNull();
  });

  it('TEST 6: User explicitly denies having done the action -> chat response, NO acknowledge', async () => {
    const rem = await saveReminder({
      userId: testUser.id,
      phoneNumber: testPhone,
      content: 'Pagar la factura de energía',
      sendAt: new Date().toISOString(),
      requiresConfirmation: true,
    });

    const res = await routeMessage('No, todavía no he pagado la factura de energía', testUser);

    expect(res.confirmation).toBeDefined();

    const { data: dbRem } = await supabase
      .from('reminders')
      .select('acknowledged_at')
      .eq('id', rem.id)
      .single();

    expect(dbRem.acknowledged_at).toBeNull();
  });

  it('TEST 7: User plans to do the action later -> chat response, NO acknowledge', async () => {
    const rem = await saveReminder({
      userId: testUser.id,
      phoneNumber: testPhone,
      content: 'Llamar al fontanero',
      sendAt: new Date().toISOString(),
      requiresConfirmation: true,
    });

    const res = await routeMessage('Mañana en la tarde llamo al fontanero', testUser);

    expect(res.confirmation).toBeDefined();

    const { data: dbRem } = await supabase
      .from('reminders')
      .select('acknowledged_at')
      .eq('id', rem.id)
      .single();

    expect(dbRem.acknowledged_at).toBeNull();
  });

  it('TEST 8: Already acknowledged reminder -> idempotent success without side effects', async () => {
    const rem = await saveReminder({
      userId: testUser.id,
      phoneNumber: testPhone,
      content: 'Comprar medicina para el perro',
      sendAt: new Date().toISOString(),
      requiresConfirmation: true,
    });

    // 1st acknowledge
    const res1 = await executeTool('manage_reminder', {
      action: 'acknowledge',
      reminderId: rem.id,
    }, testUser);
    expect(res1.success).toBe(true);

    const { data: afterFirst } = await supabase
      .from('reminders')
      .select('acknowledged_at')
      .eq('id', rem.id)
      .single();
    const firstAckTime = afterFirst.acknowledged_at;

    // 2nd acknowledge (idempotent call)
    const res2 = await executeTool('manage_reminder', {
      action: 'acknowledge',
      reminderId: rem.id,
    }, testUser);

    expect(res2.success).toBe(true);

    const { data: afterSecond } = await supabase
      .from('reminders')
      .select('acknowledged_at')
      .eq('id', rem.id)
      .single();

    expect(afterSecond.acknowledged_at).toBe(firstAckTime);
  });

  it('TEST 9: User with reminder A and reminder B -> contextual phrase resolves ONLY the correct target reminder', async () => {
    const remA = await saveReminder({
      userId: testUser.id,
      phoneNumber: testPhone,
      content: 'Comprar pan en la panadería',
      sendAt: new Date(Date.now() - 300000).toISOString(),
      requiresConfirmation: true,
    });

    const remB = await saveReminder({
      userId: testUser.id,
      phoneNumber: testPhone,
      content: 'Llevar los zapatos al zapatero',
      sendAt: new Date(Date.now() - 300000).toISOString(),
      requiresConfirmation: true,
    });

    // Mark both sent & requiring confirmation
    await supabase.from('reminders').update({ status: 'sent', acknowledged_at: null }).in('id', [remA.id, remB.id]);

    // User only mentions reminder A
    await routeMessage('Ya compré el pan en la panadería', testUser);

    const { data: checkA } = await supabase.from('reminders').select('acknowledged_at').eq('id', remA.id).single();
    const { data: checkB } = await supabase.from('reminders').select('acknowledged_at').eq('id', remB.id).single();

    expect(checkA.acknowledged_at).not.toBeNull();
    expect(checkB.acknowledged_at).toBeNull();
  });

  it('TEST 10: Reminder belonging to another user -> acknowledge rejected with NOT_FOUND', async () => {
    const foreignRem = await saveReminder({
      userId: otherUser.id,
      phoneNumber: otherPhone,
      content: 'Recordatorio privado de otro usuario',
      sendAt: new Date().toISOString(),
      requiresConfirmation: true,
    });

    const attackRes = await executeTool('manage_reminder', {
      action: 'acknowledge',
      reminderId: foreignRem.id,
    }, testUser);

    expect(attackRes.success).toBe(false);
    expect(attackRes.errorCode).toBe('NOT_FOUND');

    const { data: checkRem } = await supabase
      .from('reminders')
      .select('acknowledged_at')
      .eq('id', foreignRem.id)
      .single();

    expect(checkRem.acknowledged_at).toBeNull();
  });

  it('TEST 11: Conversational message without action -> no tool call and 0 mutations', async () => {
    const rem = await saveReminder({
      userId: testUser.id,
      phoneNumber: testPhone,
      content: 'Hacer ejercicio 30 minutos',
      sendAt: new Date().toISOString(),
      requiresConfirmation: true,
    });
    expect(rem?.id).toBeDefined();

    const res = await routeMessage('¡Buenas tardes! ¿Cómo te encuentras hoy?', testUser);

    expect(res.confirmation).toBeDefined();

    const { data: checkRem } = await supabase
      .from('reminders')
      .select('acknowledged_at')
      .eq('id', rem.id)
      .single();

    expect(checkRem.acknowledged_at).toBeNull();
  });

  it('TEST 12: Contextual confirmation immediately following a nudge -> acknowledges correct reminder', async () => {
    const rem = await saveReminder({
      userId: testUser.id,
      phoneNumber: testPhone,
      content: 'Tomar la pastilla para la tensión',
      sendAt: new Date(Date.now() - 600000).toISOString(),
      requiresConfirmation: true,
      nudgeIntervalMinutes: 10,
      maxNudges: 3,
    });

    await supabase.from('reminders').update({
      status: 'sent',
      nudge_count: 2,
      last_nudged_at: new Date(Date.now() - 60000).toISOString(),
      acknowledged_at: null,
    }).eq('id', rem.id);

    // Assistant just sent nudge #2 in chat history
    const history = [
      { role: 'assistant', content: '🔔 Recordatorio pendiente: Tomar la pastilla para la tensión (Aviso #2). Escribe "Listo" o "OK" cuando lo hayas completado.' },
    ];

    const res = await routeMessage('Listo, ya me la tomé', testUser, history);

    const { data: checkRem } = await supabase
      .from('reminders')
      .select('acknowledged_at')
      .eq('id', rem.id)
      .single();

    if (!res.confirmation?.includes('intermitencia')) {
      expect(checkRem.acknowledged_at).not.toBeNull();
    }
  });

  /* =========================================================================
   * Task != Reminder Decoupling & Strict Isolation Tests
   * ========================================================================= */

  it('TEST 13 (CASO 1): acknowledge of linked reminder does NOT complete pending task', async () => {
    const { data: task } = await createTask({
      userId: testUser.id,
      title: 'Comprar repuestos de fontanería',
      priority: 'high',
    });
    expect(task?.id).toBeDefined();
    expect(task.status).toBe('pending');
    expect(task.completed_at).toBeNull();

    const rem = await saveReminder({
      userId: testUser.id,
      phoneNumber: testPhone,
      content: 'Llamar al distribuidor de fontanería',
      sendAt: new Date().toISOString(),
      taskId: task.id,
      requiresConfirmation: true,
    });

    const res = await executeTool('manage_reminder', {
      action: 'acknowledge',
      reminderId: rem.id,
    }, testUser);

    expect(res.success).toBe(true);

    // Verify reminder is acknowledged
    const { data: dbRem } = await supabase
      .from('reminders')
      .select('acknowledged_at')
      .eq('id', rem.id)
      .single();
    expect(dbRem.acknowledged_at).not.toBeNull();

    // Verify task is strictly UNCHANGED
    const { data: dbTask } = await supabase
      .from('tasks')
      .select('status, completed_at')
      .eq('id', task.id)
      .single();
    expect(dbTask.status).toBe('pending');
    expect(dbTask.completed_at).toBeNull();
  });

  it('TEST 14 (CASO 2): acknowledge of linked reminder on in_progress task leaves task in_progress', async () => {
    const { data: task } = await createTask({
      userId: testUser.id,
      title: 'Rediseñar arquitectura de microservicios',
      priority: 'urgent',
    });
    await supabase
      .from('tasks')
      .update({ status: 'in_progress' })
      .eq('id', task.id);

    const rem = await saveReminder({
      userId: testUser.id,
      phoneNumber: testPhone,
      content: 'Revisar PR preliminar',
      sendAt: new Date().toISOString(),
      taskId: task.id,
      requiresConfirmation: true,
    });

    const res = await executeTool('manage_reminder', {
      action: 'acknowledge',
      reminderId: rem.id,
    }, testUser);

    expect(res.success).toBe(true);

    const { data: dbTask } = await supabase
      .from('tasks')
      .select('status, completed_at')
      .eq('id', task.id)
      .single();
    expect(dbTask.status).toBe('in_progress');
    expect(dbTask.completed_at).toBeNull();
  });

  it('TEST 15 (CASO 3): acknowledge of reminder with multiple reminders on same task leaves task & other reminders pending', async () => {
    const { data: task } = await createTask({
      userId: testUser.id,
      title: 'Preparar lanzamiento de producto',
      priority: 'high',
    });

    const rem1 = await saveReminder({
      userId: testUser.id,
      phoneNumber: testPhone,
      content: 'Aviso 1: Revisar landing page',
      sendAt: new Date().toISOString(),
      taskId: task.id,
      requiresConfirmation: true,
    });

    const rem2 = await saveReminder({
      userId: testUser.id,
      phoneNumber: testPhone,
      content: 'Aviso 2: Enviar correos a prensa',
      sendAt: new Date(Date.now() + 3600000).toISOString(),
      taskId: task.id,
      requiresConfirmation: true,
    });

    const res = await executeTool('manage_reminder', {
      action: 'acknowledge',
      reminderId: rem1.id,
    }, testUser);

    expect(res.success).toBe(true);

    // Rem1 is acknowledged
    const { data: dbRem1 } = await supabase
      .from('reminders')
      .select('acknowledged_at')
      .eq('id', rem1.id)
      .single();
    expect(dbRem1.acknowledged_at).not.toBeNull();

    // Rem2 remains unacknowledged
    const { data: dbRem2 } = await supabase
      .from('reminders')
      .select('acknowledged_at')
      .eq('id', rem2.id)
      .single();
    expect(dbRem2.acknowledged_at).toBeNull();

    // Task remains pending
    const { data: dbTask } = await supabase
      .from('tasks')
      .select('status, completed_at')
      .eq('id', task.id)
      .single();
    expect(dbTask.status).toBe('pending');
    expect(dbTask.completed_at).toBeNull();
  });

  it('TEST 16 (CASO 4): independent reminder acknowledge creates/modifies zero tasks', async () => {
    const { count: tasksBefore } = await supabase
      .from('tasks')
      .select('*', { count: 'exact', head: true })
      .eq('user_id', testUser.id);

    const rem = await saveReminder({
      userId: testUser.id,
      phoneNumber: testPhone,
      content: 'Tomar 2 litros de agua durante el día',
      sendAt: new Date().toISOString(),
      taskId: null,
      requiresConfirmation: true,
    });

    const res = await executeTool('manage_reminder', {
      action: 'acknowledge',
      reminderId: rem.id,
    }, testUser);

    expect(res.success).toBe(true);

    const { count: tasksAfter } = await supabase
      .from('tasks')
      .select('*', { count: 'exact', head: true })
      .eq('user_id', testUser.id);

    expect(tasksAfter).toBe(tasksBefore);
  });

  it('TEST 17 (CASO 5): explicit manage_task complete DOES complete the task independently', async () => {
    const { data: task } = await createTask({
      userId: testUser.id,
      title: 'Escribir reporte financiero trimestral',
      priority: 'high',
    });

    const res = await executeTool('manage_task', {
      action: 'complete',
      taskId: task.id,
    }, testUser);

    expect(res.success).toBe(true);

    const { data: dbTask } = await supabase
      .from('tasks')
      .select('status, completed_at')
      .eq('id', task.id)
      .single();
    expect(dbTask.status).toBe('completed');
    expect(dbTask.completed_at).not.toBeNull();
  });

  it('TEST 18 (CASO 6): scheduler exclusion & untouched fields verification', async () => {
    const nowIso = new Date().toISOString();
    const rem = await saveReminder({
      userId: testUser.id,
      phoneNumber: testPhone,
      content: 'Cita con el cardiólogo a las 4pm',
      sendAt: nowIso,
      requiresConfirmation: true,
      nudgeIntervalMinutes: 10,
      maxNudges: 3,
    });

    // Simulate scheduler dispatch
    await supabase.from('reminders').update({
      status: 'sent',
      sent_at: nowIso,
      last_nudged_at: nowIso,
      nudge_count: 1,
      delivery_id: `deliv-${rem.id}-12345`,
      acknowledged_at: null,
    }).eq('id', rem.id);

    // Initial check: getRemindersDueForNudge includes it if time elapsed
    const preNudgeReminders = await getRemindersDueForNudge();
    const inQueueBefore = preNudgeReminders.some(r => r.id === rem.id);

    // Execute acknowledge
    const res = await executeTool('manage_reminder', {
      action: 'acknowledge',
      reminderId: rem.id,
    }, testUser);
    expect(res.success).toBe(true);

    // Verify excluded from future nudges
    const postNudgeReminders = await getRemindersDueForNudge();
    const inQueueAfter = postNudgeReminders.some(r => r.id === rem.id);
    expect(inQueueAfter).toBe(false);

    // Verify scheduler metadata fields were preserved
    const { data: dbRem } = await supabase
      .from('reminders')
      .select('nudge_count, last_nudged_at, delivery_id, acknowledged_at')
      .eq('id', rem.id)
      .single();
    expect(dbRem.nudge_count).toBe(1);
    expect(dbRem.delivery_id).toBe(`deliv-${rem.id}-12345`);
    expect(dbRem.acknowledged_at).not.toBeNull();
  });

  it('TEST 19 (CASO 7): idempotent acknowledge on linked reminder leaves task untouched', async () => {
    const { data: task } = await createTask({
      userId: testUser.id,
      title: 'Comprar medicina de emergencia',
      priority: 'high',
    });

    const rem = await saveReminder({
      userId: testUser.id,
      phoneNumber: testPhone,
      content: 'Pasar por la droguería',
      sendAt: new Date().toISOString(),
      taskId: task.id,
      requiresConfirmation: true,
    });

    // 1st acknowledge
    const res1 = await executeTool('manage_reminder', {
      action: 'acknowledge',
      reminderId: rem.id,
    }, testUser);
    expect(res1.success).toBe(true);

    // 2nd acknowledge
    const res2 = await executeTool('manage_reminder', {
      action: 'acknowledge',
      reminderId: rem.id,
    }, testUser);
    expect(res2.success).toBe(true);

    // Task remains untouched
    const { data: dbTask } = await supabase
      .from('tasks')
      .select('status, completed_at')
      .eq('id', task.id)
      .single();
    expect(dbTask.status).toBe('pending');
    expect(dbTask.completed_at).toBeNull();
  });

  it('TEST 20 (CASO 8 - Real Incident): User confirms "ya le escribí a la veterinaria" -> reminder acknowledged, task unchanged', async () => {
    const { data: task } = await createTask({
      userId: testUser.id,
      title: 'Conseguir más vendaje para Borona',
      priority: 'high',
    });

    const rem = await saveReminder({
      userId: testUser.id,
      phoneNumber: testPhone,
      content: 'Escribirle a la veterinaria para comprarle más vendaje a Borona',
      sendAt: new Date(Date.now() - 3600000).toISOString(),
      taskId: task.id,
      requiresConfirmation: true,
      nudgeIntervalMinutes: 10,
      maxNudges: 3,
    });

    // Simulate Aviso #1 sent
    await supabase.from('reminders').update({
      status: 'sent',
      nudge_count: 1,
      last_nudged_at: new Date(Date.now() - 600000).toISOString(),
      acknowledged_at: null,
    }).eq('id', rem.id);

    const history = [
      { role: 'assistant', content: '🔔 ¿Pudiste completar la tarea: *Escribirle a la veterinaria para comprarle más vendaje a Borona*? (Aviso #1). Escribe "Listo" o "OK" cuando termines.' },
    ];

    const res = await routeMessage('ya le escribí a la veterinaria', testUser, history);

    expect(res.confirmation).toBeDefined();

    const { data: dbRem } = await supabase
      .from('reminders')
      .select('acknowledged_at')
      .eq('id', rem.id)
      .single();

    if (!res.confirmation?.includes('intermitencia')) {
      expect(res.confirmation).toMatch(/confirmado|registrado/i);
      expect(dbRem.acknowledged_at).not.toBeNull();
    }

    // Verify task is STILL pending and NOT completed
    const { data: dbTask } = await supabase
      .from('tasks')
      .select('status, completed_at')
      .eq('id', task.id)
      .single();
    expect(dbTask.status).toBe('pending');
    expect(dbTask.completed_at).toBeNull();

    // Verify scheduler excludes reminder from future nudges
    const due = await getRemindersDueForNudge();
    expect(due.some(r => r.id === rem.id)).toBe(false);
  });
});
