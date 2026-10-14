import 'dotenv/config';
import { untrustedResultMock } from '../../support/unit/contract-boundary.js';
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
import { executeTaskCreate } from '../../../src/agent/tools/task-create.js';
import { executeReminderCreate } from '../../../src/agent/tools/reminder-create.js';
import { routeMessage } from '../../../src/agent/orchestration/router.js';

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
type FixtureRoute = { confirmation: string; intent?: string; entities?: Record<string, unknown> };

describe('End-to-End Orchestration & Contract Verification Test Suite', () => {
  const testPhone = '+573999111222';
  const otherPhone = '+573999333444';
  let testUser: FixtureUser;
  let otherUser: FixtureUser;

  beforeAll(async () => {
    testUser = await getOrCreateUserByPhone(testPhone, 'America/Bogota') as unknown as FixtureUser;
    otherUser = await getOrCreateUserByPhone(otherPhone, 'America/Bogota') as unknown as FixtureUser;
    expect(testUser?.id).toBeDefined();
    expect(otherUser?.id).toBeDefined();

    // Clean initial state
    await (supabase as unknown as FixtureClient).from('reminders').delete().eq('user_id', testUser!.id);
    await (supabase as unknown as FixtureClient).from('tasks').delete().eq('user_id', testUser!.id);
    await (supabase as unknown as FixtureClient).from('entities').delete().eq('user_id', testUser!.id);
    await (supabase as unknown as FixtureClient).from('memories').delete().eq('user_id', testUser!.id);
    await (supabase as unknown as FixtureClient).from('subscriptions').delete().eq('user_id', testUser!.id);

    // Grant Pro for reminder tests
    await (supabase as unknown as FixtureClient).from('subscriptions').insert({
      user_id: testUser!.id,
      mp_preapproval_id: `test_preapproval_orch_${Date.now()}`,
      plan: 'pro',
      status: 'authorized',
    });

    await (supabase as unknown as FixtureClient).from('tasks').delete().eq('user_id', otherUser.id);
  });

  afterAll(async () => {
    if (testUser?.id) {
      await (supabase as unknown as FixtureClient).from('reminders').delete().eq('user_id', testUser!.id);
      await (supabase as unknown as FixtureClient).from('tasks').delete().eq('user_id', testUser!.id);
      await (supabase as unknown as FixtureClient).from('entities').delete().eq('user_id', testUser!.id);
      await (supabase as unknown as FixtureClient).from('memories').delete().eq('user_id', testUser!.id);
      await (supabase as unknown as FixtureClient).from('subscriptions').delete().eq('user_id', testUser!.id);
    }
    if (otherUser?.id) {
      await (supabase as unknown as FixtureClient).from('tasks').delete().eq('user_id', otherUser.id);
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
    expect((res.data as FixtureRow[]).length).toBe(1);
    expect((res.data as FixtureRow[])[0]!.priority).toBe('medium');

    // Verify task in DB
    const { data: dbTask } = await (supabase as unknown as FixtureClient)
      .from('tasks')
      .select('*')
      .eq('id', (res.data as FixtureRow[])[0]!.id)
      .single();

    expect(dbTask).toBeDefined();
    expect(dbTask!.priority).toBe('medium');
    expect(dbTask!.title).toBe('Agregar toaster a los repositorios');
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
    const { data: dbTasks } = await (supabase as unknown as FixtureClient)
      .from('tasks')
      .select('*')
      .eq('user_id', testUser!.id)
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
        select: vi.fn().mockResolvedValue({
            data: null,
            error: {
              code: '23514',
              message: 'new row for relation "tasks" violates check constraint "tasks_priority_check"',
              details: 'Failing row contains (..., invalid_priority).',
            },
          }),
      }),
    };

    const inventoryReply = Promise.resolve({ data: [], error: null });
    const inventoryChain = {
      select: vi.fn().mockReturnThis(), eq: vi.fn().mockReturnThis(),
      then: inventoryReply.then.bind(inventoryReply),
    };
    const originalFrom = supabase.from.bind(supabase);
    const spy = untrustedResultMock(vi.spyOn(supabase as unknown as FixtureClient, 'from')).mockImplementation((table) => {
      if (table === 'tasks') return mockChain;
      if (table === 'entities') return inventoryChain;
      return (originalFrom as unknown as FixtureClient['from'])(table);
    });

    const res = await executeTaskCreate({
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
        select: vi.fn().mockResolvedValue({
            data: null,
            error: {
              code: 'PGRST000',
              message: 'Connection timeout connecting to PostgreSQL database',
            },
          }),
      }),
    };

    const inventoryReply = Promise.resolve({ data: [], error: null });
    const inventoryChain = {
      select: vi.fn().mockReturnThis(), eq: vi.fn().mockReturnThis(),
      then: inventoryReply.then.bind(inventoryReply),
    };
    const originalFrom = supabase.from.bind(supabase);
    const spy = untrustedResultMock(vi.spyOn(supabase as unknown as FixtureClient, 'from')).mockImplementation((table) => {
      if (table === 'tasks') return mockChain;
      if (table === 'entities') return inventoryChain;
      return (originalFrom as unknown as FixtureClient['from'])(table);
    });

    const res = await executeTaskCreate({
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
    const tasksBefore = await getTasks({ userId: testUser!.id });

    // Simulate chat turn where LLM only converses
    const res = await routeMessage('¡Hola! ¿Cómo estás hoy?', testUser) as unknown as FixtureRoute;

    expect(res.confirmation).toBeDefined();

    const tasksAfter = await getTasks({ userId: testUser!.id });
    expect(tasksAfter.length).toBe(tasksBefore.length);
  });

  it('TEST 6: "Elimina la tarea de la doctora Marcela" passes through LLM without pre-router memory hijack', async () => {
    // Create task
    const task = await createTask({
      userId: testUser!.id,
      title: 'Enviar informe a la doctora Marcela',
    }) as unknown as FixtureRow;
    expect(task?.id).toBeDefined();

    const res = await routeMessage('Elimina la tarea de la doctora Marcela', testUser) as unknown as FixtureRoute;
    expect(res).toBeDefined();
    expect(res.intent).not.toBe('memory');
  });

  it('TEST 7: "Cancela la tarea de renovar la suscripción" does NOT auto-cancel subscription via regex', async () => {
    // Check subscription active
    const { data: subBefore } = await (supabase as unknown as FixtureClient)
      .from('subscriptions')
      .select('*')
      .eq('user_id', testUser!.id)
      .single();
    expect(subBefore!.status).toBe('authorized');

    // Send phrase mentioning task and subscription
    await routeMessage('Cancela la tarea de renovar la suscripción del servidor', testUser) as unknown as FixtureRoute;

    // Verify subscription was NOT cancelled by a regex interceptor
    const { data: subAfter } = await (supabase as unknown as FixtureClient)
      .from('subscriptions')
      .select('*')
      .eq('user_id', testUser!.id)
      .single();

    expect(subAfter!.status).toBe('authorized');
  });

  it('TEST 8: "Listo" does not auto-acknowledge reminders via regex when used in ordinary conversation', async () => {
    // Create a pending reminder
    const rem = await saveReminder({
      userId: testUser!.id,
      phoneNumber: testPhone,
      content: 'Recordatorio importante pendiente',
      sendAt: new Date(Date.now() + 3600000).toISOString(),
    }) as unknown as FixtureRow;
    expect(rem).toBeDefined();

    // User says "Listo" in conversation
    await routeMessage('Listo, muchas gracias por la aclaración', testUser, [
      { role: 'assistant', content: '¿Te ha quedado claro cómo funciona el proyecto?' },
    ]) as unknown as FixtureRoute;

    // Verify reminder is STILL pending (was NOT auto-cancelled/acknowledged by a regex filter)
    const { data: checkRem } = await (supabase as unknown as FixtureClient)
      .from('reminders')
      .select('status, acknowledged_at')
      .eq('id', rem.id)
      .single();

    expect(checkRem!.status).toBe('pending');
    expect(checkRem!.acknowledged_at).toBeNull();
  });

  it('TEST 9: "Recuérdame llamar a Juan todos los días" gets recurrence purely from structured params', async () => {
    // If LLM sends recurrence explicitly, reminderTools applies it
    const resWithRecurrence = await executeReminderCreate({
      params: {
        items: [{ content: 'Llamar a Juan todos los días', targetTime: '08:00', recurrence: 'daily' }],
      },
      user: testUser,
      isPro: true,
    });

    expect(resWithRecurrence.success).toBe(true);
    expect((resWithRecurrence.data as FixtureRow[])[0]!.recurrenceRule).toBe('daily');

    // If LLM does NOT send recurrence, reminderTools does NOT extract it from content with regex
    const resWithoutRecurrence = await executeReminderCreate({
      params: {
        items: [{ content: 'Llamar a Juan todos los días para revisar avance', targetTime: '+1h' }],
      },
      user: testUser,
      isPro: true,
    });

    expect(resWithoutRecurrence.success).toBe(true);
    expect((resWithoutRecurrence.data as FixtureRow[])[0]!.recurrenceRule).toBeNull();
  });

  it('TEST 10: manage_task update with canonical { taskId, updates: { title } } updates successfully', async () => {
    const task = await createTask({
      userId: testUser!.id,
      title: 'Título Original Tarea',
    }) as unknown as FixtureRow;
    expect(task?.id).toBeDefined();

    const updateRes = await executeTool('manage_task', {
      action: 'update',
      target: task.id.slice(0, 8),
      updates: {
        title: 'Título Actualizado Canónicamente',
        priority: 'high',
      },
    }, testUser);

    expect(updateRes.success).toBe(true);
    expect(updateRes.confirmation).toContain('Título Actualizado Canónicamente');

    const { data: refreshed } = await (supabase as unknown as FixtureClient)
      .from('tasks')
      .select('*')
      .eq('id', task.id)
      .single();

    expect(refreshed!.title).toBe('Título Actualizado Canónicamente');
    expect(refreshed!.priority).toBe('high');
  });

  it('TEST 11: mutation with taskId belonging to another user returns NOT_FOUND with 0 mutations', async () => {
    const foreignTask = await createTask({
      userId: otherUser.id,
      title: 'Tarea Privada Otro Usuario',
    }) as unknown as FixtureRow;
    expect(foreignTask?.id).toBeDefined();

    const attackRes = await executeTool('manage_task', {
      action: 'update',
      target: foreignTask.id,
      updates: {
        title: 'Intento de hackeo',
      },
    }, testUser);

    expect(attackRes.success).toBe(false);
    expect(attackRes.errorCode).toBe('NOT_FOUND');

    const { data: checkTask } = await (supabase as unknown as FixtureClient)
      .from('tasks')
      .select('*')
      .eq('id', foreignTask.id)
      .single();

    expect(checkTask!.title).toBe('Tarea Privada Otro Usuario');
  });

  it('TEST 12: "¿Cómo así?" generates conversation with 0 database mutations', async () => {
    const tasksBefore = await getTasks({ userId: testUser!.id });
    const remindersBefore = await getRemindersByPhone(testPhone, 'pending', 50);

    const res = await routeMessage('¿Cómo así?', testUser) as unknown as FixtureRoute;

    expect(res.confirmation).toBeDefined();
    expect(res.confirmation).not.toContain('marcaron');
    expect(res.confirmation).not.toContain('cancelado');

    const tasksAfter = await getTasks({ userId: testUser!.id });
    const remindersAfter = await getRemindersByPhone(testPhone, 'pending', 50);

    expect(tasksAfter.length).toBe(tasksBefore.length);
    expect(remindersAfter.length).toBe(remindersBefore.length);
  });
});
