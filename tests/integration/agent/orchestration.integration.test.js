import 'dotenv/config';
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import {
  supabase,
  getOrCreateUserByPhone,
  createTask,
  getTasks,
  updateTask,
  saveReminder,
  getRemindersByPhone,
  findOrCreateEntityFuzzy,
} from '../../../src/infrastructure/database/index.js';
import { normalizeTaskPriority } from '../../../src/infrastructure/database/tasks.js';
import { executeTool } from '../../../src/agent/tools/index.js';
import { executeTaskTool } from '../../../src/agent/tools/tasks.js';
import { executeReminderTool } from '../../../src/agent/tools/reminders.js';
import { routeMessage } from '../../../src/agent/orchestration/router.js';

describe('End-to-End Orchestration & Contract Verification Test Suite', () => {
  const testPhone = '+573999111222';
  const otherPhone = '+573999333444';
  let testUser;
  let otherUser;

  beforeAll(async () => {
    testUser = await getOrCreateUserByPhone(testPhone, 'America/Bogota');
    otherUser = await getOrCreateUserByPhone(otherPhone, 'America/Bogota');
    expect(testUser?.id).toBeDefined();
    expect(otherUser?.id).toBeDefined();

    // Clean initial state
    await supabase.from('reminders').delete().eq('user_id', testUser.id);
    await supabase.from('tasks').delete().eq('user_id', testUser.id);
    await supabase.from('entities').delete().eq('user_id', testUser.id);
    await supabase.from('memories').delete().eq('user_id', testUser.id);
    await supabase.from('subscriptions').delete().eq('user_id', testUser.id);

    // Grant Pro for reminder tests
    await supabase.from('subscriptions').insert({
      user_id: testUser.id,
      mp_preapproval_id: `test_preapproval_orch_${Date.now()}`,
      plan: 'pro',
      status: 'authorized',
    });

    await supabase.from('tasks').delete().eq('user_id', otherUser.id);
  });

  afterAll(async () => {
    if (testUser?.id) {
      await supabase.from('reminders').delete().eq('user_id', testUser.id);
      await supabase.from('tasks').delete().eq('user_id', testUser.id);
      await supabase.from('entities').delete().eq('user_id', testUser.id);
      await supabase.from('memories').delete().eq('user_id', testUser.id);
      await supabase.from('subscriptions').delete().eq('user_id', testUser.id);
    }
    if (otherUser?.id) {
      await supabase.from('tasks').delete().eq('user_id', otherUser.id);
    }
  });

  it('TEST 1: normalizes priority "normal" to "medium" deterministically and creates task', async () => {
    expect(normalizeTaskPriority('normal')).toBe('medium');
    expect(normalizeTaskPriority('alta')).toBe('high');
    expect(normalizeTaskPriority('baja')).toBe('low');
    expect(normalizeTaskPriority('urgente')).toBe('urgent');

    const res = await executeTool('manage_task', {
      action: 'create',
      items: [
        {
          title: 'Agregar toaster a los repositorios',
          priority: 'normal',
        },
      ],
    }, testUser);

    expect(res.success).toBe(true);
    expect(res.data.length).toBe(1);
    expect(res.data[0].priority).toBe('medium');

    // Verify task in DB
    const { data: dbTask } = await supabase
      .from('tasks')
      .select('*')
      .eq('id', res.data[0].id)
      .single();

    expect(dbTask).toBeDefined();
    expect(dbTask.priority).toBe('medium');
    expect(dbTask.title).toBe('Agregar toaster a los repositorios');
  });

  it('TEST 2: rejects invalid priority enum with INVALID_PARAMETERS without calling DB', async () => {
    const res = await executeTool('manage_task', {
      action: 'create',
      items: [
        {
          title: 'Tarea con prioridad invalida',
          priority: 'super-alta-invalida',
        },
      ],
    }, testUser);

    expect(res.success).toBe(false);
    expect(res.errorCode).toBe('INVALID_PARAMETERS');
    expect(res.error).toContain("Prioridad inválida 'super-alta-invalida'");

    // Verify NO task was inserted in DB
    const { data: dbTasks } = await supabase
      .from('tasks')
      .select('*')
      .eq('user_id', testUser.id)
      .ilike('title', '%prioridad invalida%');

    expect(dbTasks?.length || 0).toBe(0);
  });

  it('TEST 3: preserves PostgreSQL 23514 check constraint error as DATABASE_CONSTRAINT_ERROR, never MISSING_TITLE', async () => {
    const mockChain = {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      ilike: vi.fn().mockReturnThis(),
      is: vi.fn().mockReturnThis(),
      limit: vi.fn().mockResolvedValue({ data: [], error: null }),
      insert: vi.fn().mockReturnValue({
        select: vi.fn().mockReturnValue({
          single: vi.fn().mockResolvedValue({
            data: null,
            error: {
              code: '23514',
              message: 'new row for relation "tasks" violates check constraint "tasks_priority_check"',
              details: 'Failing row contains (..., invalid_priority).',
            },
          }),
        }),
      }),
    };

    const spy = vi.spyOn(supabase, 'from').mockImplementation((table) => {
      if (table === 'tasks') return mockChain;
      return supabase.from(table);
    });

    const res = await executeTaskTool({
      action: 'create',
      params: {
        items: [{ title: 'Simulacion constraint violation', priority: 'medium' }],
      },
      user: testUser,
    });

    spy.mockRestore();

    expect(res.success).toBe(false);
    expect(res.errorCode).toBe('DATABASE_CONSTRAINT_ERROR');
    expect(res.error).not.toContain('Falta el título');
    expect(res.error).toContain('violates check constraint');
  });

  it('TEST 4: preserves DB connection/internal failure as DATABASE_ERROR', async () => {
    const mockChain = {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      ilike: vi.fn().mockReturnThis(),
      is: vi.fn().mockReturnThis(),
      limit: vi.fn().mockResolvedValue({ data: [], error: null }),
      insert: vi.fn().mockReturnValue({
        select: vi.fn().mockReturnValue({
          single: vi.fn().mockResolvedValue({
            data: null,
            error: {
              code: 'PGRST000',
              message: 'Connection timeout connecting to PostgreSQL database',
            },
          }),
        }),
      }),
    };

    const spy = vi.spyOn(supabase, 'from').mockImplementation((table) => {
      if (table === 'tasks') return mockChain;
      return supabase.from(table);
    });

    const res = await executeTaskTool({
      action: 'create',
      params: {
        items: [{ title: 'Simulacion error de conexion', priority: 'medium' }],
      },
      user: testUser,
    });

    spy.mockRestore();

    expect(res.success).toBe(false);
    expect(res.errorCode).toBe('DATABASE_ERROR');
    expect(res.error).toContain('Connection timeout');
  });

  it('TEST 5: chat without tool execution produces no false database mutations', async () => {
    const tasksBefore = await getTasks({ userId: testUser.id });

    // Simulate chat turn where LLM only converses
    const res = await routeMessage('¡Hola! ¿Cómo estás hoy?', testUser);

    expect(res.confirmation).toBeDefined();

    const tasksAfter = await getTasks({ userId: testUser.id });
    expect(tasksAfter.length).toBe(tasksBefore.length);
  });

  it('TEST 6: "Elimina la tarea de la doctora Marcela" passes through LLM without pre-router memory hijack', async () => {
    // Create task
    const task = await createTask({
      userId: testUser.id,
      title: 'Enviar informe a la doctora Marcela',
    });
    expect(task?.id).toBeDefined();

    const res = await routeMessage('Elimina la tarea de la doctora Marcela', testUser);
    expect(res).toBeDefined();
    expect(res.intent).not.toBe('memory');
  });

  it('TEST 7: "Cancela la tarea de renovar la suscripción" does NOT auto-cancel subscription via regex', async () => {
    // Check subscription active
    const { data: subBefore } = await supabase
      .from('subscriptions')
      .select('*')
      .eq('user_id', testUser.id)
      .single();
    expect(subBefore.status).toBe('authorized');

    // Send phrase mentioning task and subscription
    await routeMessage('Cancela la tarea de renovar la suscripción del servidor', testUser);

    // Verify subscription was NOT cancelled by a regex interceptor
    const { data: subAfter } = await supabase
      .from('subscriptions')
      .select('*')
      .eq('user_id', testUser.id)
      .single();

    expect(subAfter.status).toBe('authorized');
  });

  it('TEST 8: "Listo" does not auto-acknowledge reminders via regex when used in ordinary conversation', async () => {
    // Create a pending reminder
    const rem = await saveReminder({
      userId: testUser.id,
      phoneNumber: testPhone,
      content: 'Recordatorio importante pendiente',
      sendAt: new Date(Date.now() + 3600000).toISOString(),
    });
    expect(rem).toBeDefined();

    // User says "Listo" in conversation
    await routeMessage('Listo, muchas gracias por la aclaración', testUser, [
      { role: 'assistant', content: '¿Te ha quedado claro cómo funciona el proyecto?' },
    ]);

    // Verify reminder is STILL pending (was NOT auto-cancelled/acknowledged by a regex filter)
    const { data: checkRem } = await supabase
      .from('reminders')
      .select('status, acknowledged_at')
      .eq('id', rem.id)
      .single();

    expect(checkRem.status).toBe('pending');
    expect(checkRem.acknowledged_at).toBeNull();
  });

  it('TEST 9: "Recuérdame llamar a Juan todos los días" gets recurrence purely from structured params', async () => {
    // If LLM sends recurrence explicitly, reminderTools applies it
    const resWithRecurrence = await executeReminderTool({
      action: 'create',
      params: {
        content: 'Llamar a Juan todos los días',
        targetTime: '08:00',
        recurrence: 'daily',
      },
      user: testUser,
      isPro: true,
    });

    expect(resWithRecurrence.success).toBe(true);
    expect(resWithRecurrence.data[0].recurrenceRule).toBe('daily');

    // If LLM does NOT send recurrence, reminderTools does NOT extract it from content with regex
    const resWithoutRecurrence = await executeReminderTool({
      action: 'create',
      params: {
        content: 'Llamar a Juan todos los días para revisar avance',
        targetTime: '+1h',
      },
      user: testUser,
      isPro: true,
    });

    expect(resWithoutRecurrence.success).toBe(true);
    expect(resWithoutRecurrence.data[0].recurrenceRule).toBeNull();
  });

  it('TEST 10: manage_task update with canonical { taskId, updates: { title } } updates successfully', async () => {
    const task = await createTask({
      userId: testUser.id,
      title: 'Título Original Tarea',
    });
    expect(task?.id).toBeDefined();

    const updateRes = await executeTool('manage_task', {
      action: 'update',
      taskId: task.id.slice(0, 8),
      updates: {
        title: 'Título Actualizado Canónicamente',
        priority: 'high',
      },
    }, testUser);

    expect(updateRes.success).toBe(true);
    expect(updateRes.confirmation).toContain('Título Actualizado Canónicamente');

    const { data: refreshed } = await supabase
      .from('tasks')
      .select('*')
      .eq('id', task.id)
      .single();

    expect(refreshed.title).toBe('Título Actualizado Canónicamente');
    expect(refreshed.priority).toBe('high');
  });

  it('TEST 11: mutation with taskId belonging to another user returns NOT_FOUND with 0 mutations', async () => {
    const foreignTask = await createTask({
      userId: otherUser.id,
      title: 'Tarea Privada Otro Usuario',
    });
    expect(foreignTask?.id).toBeDefined();

    const attackRes = await executeTool('manage_task', {
      action: 'update',
      taskId: foreignTask.id,
      updates: {
        title: 'Intento de hackeo',
      },
    }, testUser);

    expect(attackRes.success).toBe(false);
    expect(attackRes.errorCode).toBe('NOT_FOUND');

    const { data: checkTask } = await supabase
      .from('tasks')
      .select('*')
      .eq('id', foreignTask.id)
      .single();

    expect(checkTask.title).toBe('Tarea Privada Otro Usuario');
  });

  it('TEST 12: "¿Cómo así?" generates conversation with 0 database mutations', async () => {
    const tasksBefore = await getTasks({ userId: testUser.id });
    const remindersBefore = await getRemindersByPhone(testPhone, 'pending', 50);

    const res = await routeMessage('¿Cómo así?', testUser);

    expect(res.confirmation).toBeDefined();
    expect(res.confirmation).not.toContain('marcaron');
    expect(res.confirmation).not.toContain('cancelado');

    const tasksAfter = await getTasks({ userId: testUser.id });
    const remindersAfter = await getRemindersByPhone(testPhone, 'pending', 50);

    expect(tasksAfter.length).toBe(tasksBefore.length);
    expect(remindersAfter.length).toBe(remindersBefore.length);
  });
});
