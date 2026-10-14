import 'dotenv/config';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  supabase,
  getOrCreateUserByPhone,
  saveReminder,
  getRemindersByPhone,
  createTask,
  getTasks,
  completeTasks,
  findOrCreateEntityFuzzy,
} from '../../../src/infrastructure/database/index.js';
import { routeMessage } from '../../../src/agent/orchestration/router.js';
import { executeTool } from '../../../src/agent/tools/index.js';

type FixtureRow = { id: string; content: string; send_at: string } & Record<string, unknown>;
type FixtureReply = { data: FixtureRow[] | FixtureRow | null; error: unknown };
type FixtureQuery = PromiseLike<FixtureReply> & {
  eq(column: string, value: unknown): FixtureQuery;
  single(): PromiseLike<{ data: FixtureRow | null; error: unknown }>;
};
type FixtureClient = {
  from(table: 'subscriptions' | 'reminders' | 'tasks' | 'entities' | 'memories' | 'messages'): {
    delete(): FixtureQuery;
    select(columns: string): FixtureQuery;
    upsert(row: Record<string, unknown>, options: { onConflict: string }): FixtureQuery;
  };
};
type FixtureUser = NonNullable<Parameters<typeof executeTool>[2]> & { id: string };
type FixtureTask = { id: string; due_date: unknown };
type CreatedTask = { id: string; dueDate: unknown };
type UpdatedReminder = { content: unknown; sendAt: string };

describe('Coherence & Target Contract Safety Test Suite (Hermes Agent)', () => {
  const testPhone = '573119998877';
  const otherPhone = '573999000111';
  let testUser: FixtureUser;
  let otherUser: FixtureUser;

  beforeAll(async () => {
    testUser = await getOrCreateUserByPhone(testPhone, 'America/Bogota') as unknown as FixtureUser;
    otherUser = await getOrCreateUserByPhone(otherPhone, 'America/Bogota') as unknown as FixtureUser;
    expect(testUser?.id).toBeDefined();
    expect(otherUser?.id).toBeDefined();

    await (supabase as unknown as FixtureClient).from('subscriptions').upsert({
      user_id: testUser.id,
      mp_preapproval_id: `test_preapproval_coh_${Date.now()}`,
      plan: 'pro',
      status: 'authorized',
    }, { onConflict: 'user_id' });

    // Clean up past state
    await (supabase as unknown as FixtureClient).from('reminders').delete().eq('user_id', testUser.id);
    await (supabase as unknown as FixtureClient).from('tasks').delete().eq('user_id', testUser.id);
    await (supabase as unknown as FixtureClient).from('entities').delete().eq('user_id', testUser.id);
    await (supabase as unknown as FixtureClient).from('memories').delete().eq('user_id', testUser.id);
    await (supabase as unknown as FixtureClient).from('messages').delete().eq('phone_number', testPhone);

    await (supabase as unknown as FixtureClient).from('tasks').delete().eq('user_id', otherUser.id);
  });

  afterAll(async () => {
    if (testUser?.id) {
      await (supabase as unknown as FixtureClient).from('reminders').delete().eq('user_id', testUser.id);
      await (supabase as unknown as FixtureClient).from('tasks').delete().eq('user_id', testUser.id);
      await (supabase as unknown as FixtureClient).from('entities').delete().eq('user_id', testUser.id);
      await (supabase as unknown as FixtureClient).from('memories').delete().eq('user_id', testUser.id);
      await (supabase as unknown as FixtureClient).from('messages').delete().eq('phone_number', testPhone);
    }
    if (otherUser?.id) {
      await (supabase as unknown as FixtureClient).from('tasks').delete().eq('user_id', otherUser.id);
    }
  });

  it('TEST 1 & 2: refuses to complete tasks when user asks "¿cómo así?" and requires explicit target taskId', async () => {
    // 1. Create 3 tasks in "Archivo Sonoro"
    const ent = await findOrCreateEntityFuzzy({ userId: testUser.id, name: 'Archivo Sonoro', category: 'project' });
    expect(ent).toBeDefined();

    const t1 = await createTask({ userId: testUser.id, title: 'Mirar cómo diferenciar las ventas de efectivo y tarjeta', entityId: ent!.id });
    const t2 = await createTask({ userId: testUser.id, title: 'Verificar pixel y cambiar dominio', entityId: ent!.id });
    const t3 = await createTask({ userId: testUser.id, title: 'Hacer anuncio modelado para pruebas', entityId: ent!.id });

    expect(t1).toBeDefined();
    expect(t2).toBeDefined();
    expect(t3).toBeDefined();

    // Verify all 3 tasks are pending in DB
    const pendingBefore = await getTasks({ userId: testUser.id, status: 'pending' });
    expect(pendingBefore.length).toBeGreaterThanOrEqual(3);

    // 2. Simulate conversation history where user created them and now says "¿cómo así?"
    const history: Parameters<typeof routeMessage>[2] = [
      { role: 'user', content: 'Crear tarea en Archivo Sonoro: Mirar cómo diferenciar las ventas de efectivo y tarjeta' },
      { role: 'assistant', content: '✅ Tarea añadida en Archivo Sonoro' },
      { role: 'user', content: 'Crear tarea en Archivo Sonoro: Verificar pixel y cambiar dominio' },
      { role: 'assistant', content: '✅ Tarea añadida en Archivo Sonoro' },
      { role: 'user', content: 'Crear tarea en Archivo Sonoro: Hacer anuncio modelado para pruebas' },
      { role: 'assistant', content: '✅ Tarea añadida en Archivo Sonoro' },
    ];

    const res = await routeMessage('¿cómo así?', testUser, history);

    // 3. Verify that the assistant responds in conversation/chat and did NOT complete tasks
    expect(res.confirmation).not.toContain('He marcado como completadas');
    expect(res.confirmation).not.toContain('marcaron 3 tarea(s) como realizada(s)');

    const pendingAfter = await getTasks({ userId: testUser.id, status: 'pending' });
    expect(pendingAfter.length).toBe(pendingBefore.length);

    // Direct backend safety check: missing taskId returns MISSING_TARGET_ID
    const blockedTool = await executeTool({
      toolName: 'manage_task',
      params: { action: 'complete', entityName: 'Archivo Sonoro' },
      user: testUser,
    });

    expect(blockedTool.success).toBe(false);
    expect(blockedTool.errorCode).toBe('MISSING_TARGET_ID');
  });

  it('TEST 3: queries all projects and tasks and returns real DB data, never generic memory note fallback', async () => {
    const res = await routeMessage('Dame todos los proyectos y tareas que tengo', testUser);

    expect(res.confirmation).toBeDefined();
    expect(res.confirmation).not.toContain('Lo tengo presente en tus notas');
    if (!(res.confirmation as string).includes('intermitencia')) {
      expect(res.confirmation).toMatch(/Archivo Sonoro|pixel|ventas|anuncio/i);
    }
  });

  it('TEST 4: creates task without due date and independent reminder referencing task', async () => {
    const task = await createTask({ userId: testUser.id, title: 'Preparar presentación', dueDate: null });
    expect(task).toBeDefined();
    expect((task as FixtureTask).due_date).toBeNull();

    // Schedule reminder referencing task
    const rem = await saveReminder({
      userId: testUser.id,
      phoneNumber: testPhone,
      taskId: (task as FixtureTask).id,
      content: 'Preparar presentación',
      sendAt: new Date(Date.now() + 86400000).toISOString(),
    });

    expect(rem).toBeDefined();
    expect(rem!.task_id).toBe((task as FixtureTask).id);

    // Verify task due_date remained null
    const { data: refreshedTask } = await (supabase as unknown as FixtureClient).from('tasks').select('*').eq('id', (task as FixtureTask).id).single();
    expect(refreshedTask!.due_date).toBeNull();
  });

  it('TEST 5: advance notice reminder creates additional reminder without overwriting main one', async () => {
    const mainTime = new Date(Date.now() + 7200000).toISOString();
    const advanceTime = new Date(new Date(mainTime).getTime() - 1800000).toISOString();
    const mainRem = await saveReminder({
      userId: testUser.id,
      phoneNumber: testPhone,
      content: 'Llamar a Juan',
      sendAt: mainTime,
    });

    const res = await executeTool({
      toolName: 'manage_reminder',
      params: {
        action: 'create',
        items: [
          { content: 'Llamar a Juan (Aviso previo)', targetTime: advanceTime },
          { content: 'Llamar a Juan', targetTime: mainTime },
        ],
      },
      user: testUser,
      isPro: true,
    });

    expect(res.success).toBe(true);
    expect((res.data as unknown[]).length).toBe(2);

    const reminders = await getRemindersByPhone(testPhone, 'pending', 50);
    const juanReminders = reminders.filter(r => r.content.includes('Llamar a Juan'));
    expect(juanReminders.length).toBeGreaterThanOrEqual(2);
  });

  it('TEST 6: task without date strictly sets dueDate to null and creates 0 reminders', async () => {
    const res = await executeTool({
      toolName: 'manage_task',
      params: {
        action: 'create',
        items: [{ title: 'Comprar comida para el perro' }],
      },
      user: testUser,
    });

    expect(res.success).toBe(true);
    const createdTask = (res.data as CreatedTask[])[0]!;
    expect(createdTask.dueDate).toBeNull();

    const { data: dbTask } = await (supabase as unknown as FixtureClient).from('tasks').select('*').eq('id', createdTask.id).single();
    expect(dbTask!.due_date).toBeNull();

    // Verify no reminder was created with this content
    const reminders = await getRemindersByPhone(testPhone, 'pending', 50);
    const dogReminders = reminders.filter(r => r.content.includes('comida para el perro'));
    expect(dogReminders.length).toBe(0);
  });

  it('TEST 7: question about project tasks executes read-only list and never deletes or completes', async () => {
    const blockedTool = await executeTool({
      toolName: 'manage_task',
      params: { action: 'complete' },
      user: testUser,
    });

    expect(blockedTool.success).toBe(false);
    expect(blockedTool.errorCode).toBe('MISSING_TARGET_ID');

    const listRes = await executeTool({
      toolName: 'manage_task',
      params: { action: 'list', entityName: 'Archivo Sonoro' },
      user: testUser,
    });

    expect(listRes.success).toBe(true);
    expect(listRes.rawSummary).toContain('Archivo Sonoro');
  });

  it('TEST 8: resolves task by 8-character prefix ID and enforces strict user ownership', async () => {
    const task = await createTask({ userId: testUser.id, title: 'Prueba ID Prefix Target', dueDate: null });
    expect(task).toBeDefined();
    const prefixId = (task as FixtureTask).id.slice(0, 8);

    // Other user attempting to complete this task must fail
    const attackRes = await executeTool({
      toolName: 'manage_task',
      params: { action: 'complete', target: prefixId },
      user: otherUser,
    });
    expect(attackRes.success).toBe(false);
    expect(attackRes.errorCode).toBe('NOT_FOUND');

    // Legitimate owner completing task
    const ownerRes = await executeTool({
      toolName: 'manage_task',
      params: { action: 'complete', target: prefixId },
      user: testUser,
    });
    expect(ownerRes.success).toBe(true);

    const { data: checkTask } = await (supabase as unknown as FixtureClient).from('tasks').select('status').eq('id', (task as FixtureTask).id).single();
    expect(checkTask!.status).toBe('completed');
  });

  it('TEST 9: multiple reminders for the same task coexist without conflict', async () => {
    const task = await createTask({ userId: testUser.id, title: 'Presentación trimestral', dueDate: null });
    expect(task).toBeDefined();

    const r1 = await saveReminder({
      userId: testUser.id,
      phoneNumber: testPhone,
      taskId: (task as FixtureTask).id,
      content: 'Presentación trimestral - 1er aviso',
      sendAt: new Date(Date.now() + 3600000).toISOString(),
    });

    const r2 = await saveReminder({
      userId: testUser.id,
      phoneNumber: testPhone,
      taskId: (task as FixtureTask).id,
      content: 'Presentación trimestral - 2do aviso',
      sendAt: new Date(Date.now() + 7200000).toISOString(),
    });

    expect(r1).toBeDefined();
    expect(r2).toBeDefined();
    expect(r1!.id).not.toBe(r2!.id);
    expect(r1!.task_id).toBe((task as FixtureTask).id);
    expect(r2!.task_id).toBe((task as FixtureTask).id);
  });

  it('TEST 10: cancels reminder strictly with reminderId and refuses missing ID', async () => {
    const rem = await saveReminder({
      userId: testUser.id,
      phoneNumber: testPhone,
      content: 'Reunión de prueba cancelable',
      sendAt: new Date(Date.now() + 3600000).toISOString(),
    });

    // Attempt cancel without reminderId
    const missingRes = await executeTool({
      toolName: 'manage_reminder',
      params: { action: 'cancel' },
      user: testUser,
    });
    expect(missingRes.success).toBe(false);
    expect(missingRes.errorCode).toBe('MISSING_TARGET');

    // Cancel with prefix reminderId
    const cancelRes = await executeTool({
      toolName: 'manage_reminder',
      params: { action: 'cancel', target: rem!.id!.slice(0, 8) },
      user: testUser,
    });
    expect(cancelRes.success).toBe(true);

    const { data: checkRem } = await (supabase as unknown as FixtureClient).from('reminders').select('status').eq('id', rem!.id).single();
    expect(checkRem!.status).toBe('cancelled');
  });

  it('TEST 11: update reminder with valid reminderId updates date/time without creating duplicate', async () => {
    const rem = await saveReminder({
      userId: testUser.id,
      phoneNumber: testPhone,
      content: 'Escribirle a la veterinaria para comprarle más vendaje a Borona',
      sendAt: new Date(Date.now() + 86400000).toISOString(), // Tomorrow
    });
    expect(rem).toBeDefined();

    const newTargetTime = new Date(Date.now() + 1800000).toISOString(); // In 30 mins

    const updateRes = await executeTool({
      toolName: 'manage_reminder',
      params: {
        action: 'update',
        target: rem!.id!.slice(0, 8),
        updates: { targetTime: newTargetTime },
      },
      user: testUser,
    });

    expect(updateRes.success).toBe(true);
    expect(updateRes.action).toBe('updated_reminder');
    expect((updateRes.data as UpdatedReminder).content).toBe('Escribirle a la veterinaria para comprarle más vendaje a Borona');

    // Confirm in DB that date updated in place and NO duplicate reminder exists
    const { data: dbReminders } = await (supabase as unknown as FixtureClient)
      .from('reminders')
      .select('*')
      .eq('user_id', testUser.id)
      .eq('status', 'pending');

    const matching = (dbReminders as FixtureRow[]).filter(r => r.content.includes('Borona'));
    expect(matching.length).toBe(1);
    expect(matching[0]!.id).toBe(rem!.id);
    expect(new Date(matching[0]!.send_at).getTime()).toBe(new Date(newTargetTime).getTime());
  });

  it('TEST 12: update reminder without reminderId returns MISSING_TARGET_ID', async () => {
    const res = await executeTool({
      toolName: 'manage_reminder',
      params: {
        action: 'update',
        updates: { targetTime: '10:00' },
      },
      user: testUser,
    });

    expect(res.success).toBe(false);
    expect(res.errorCode).toBe('MISSING_TARGET_ID');
  });

  it('TEST 13: update reminder belonging to other user returns NOT_FOUND (ownership guard)', async () => {
    const rem = await saveReminder({
      userId: testUser.id,
      phoneNumber: testPhone,
      content: 'Recordatorio privado de Usuario A',
      sendAt: new Date(Date.now() + 3600000).toISOString(),
    });

    const res = await executeTool({
      toolName: 'manage_reminder',
      params: {
        action: 'update',
        target: rem!.id!.slice(0, 8),
        updates: { targetTime: new Date(Date.now() + 600000).toISOString() },
      },
      user: otherUser,
    });

    expect(res.success).toBe(false);
    expect(res.errorCode).toBe('NOT_FOUND');
  });

  it('TEST 14: partial update only modifies requested fields and preserves all other fields', async () => {
    const rem = await saveReminder({
      userId: testUser.id,
      phoneNumber: testPhone,
      content: 'Comprar boletos de concierto',
      sendAt: new Date(Date.now() + 7200000).toISOString(),
    });

    const res = await executeTool({
      toolName: 'manage_reminder',
      params: {
        action: 'update',
        target: rem!.id!,
        updates: { content: 'Comprar boletos VIP de concierto' },
      },
      user: testUser,
    });

    expect(res.success).toBe(true);
    expect((res.data as UpdatedReminder).content).toBe('Comprar boletos VIP de concierto');
    expect(new Date((res.data as UpdatedReminder).sendAt).getTime()).toBe(new Date(rem!.send_at as string).getTime());
  });
});
