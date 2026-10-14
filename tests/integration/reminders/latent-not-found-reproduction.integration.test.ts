import 'dotenv/config';
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { getOrCreateUserByPhone } from '../../../src/infrastructure/database/users.js';
import {
  createTask,
  getTasks,
  saveReminder,
  supabase,
} from '../../../src/infrastructure/database/index.js';
import { routeMessage } from '../../../src/agent/orchestration/router.js';
import { executeTaskDelete } from '../../../src/agent/tools/task-delete.js';
import { executeTaskComplete } from '../../../src/agent/tools/task-complete.js';
import { executeSingleReminderCancellation } from '../../../src/agent/tools/reminder-cancel.js';
import { clearWorkingMemory, getWorkingMemory } from '../../../src/agent/core/working-memory.js';

// Fixture setup/cleanup consumes the SDK query surface without widening runtime ports.
type FixtureQuery = PromiseLike<{ data: Record<string, unknown> | null; error: unknown }> & {
  eq(column: string, value: unknown): FixtureQuery;
  single(): FixtureQuery;
  maybeSingle(): FixtureQuery;
};
type FixtureClient = {
  from(table: 'tasks' | 'reminders' | 'entities' | 'subscriptions'): {
    delete(): FixtureQuery;
    update(row: Record<string, unknown>): FixtureQuery;
    upsert(row: Record<string, unknown>, options: { onConflict: string }): FixtureQuery;
    select(columns: string): FixtureQuery;
  };
};

describe.sequential('Latent NOT_FOUND Bugs Reproduction Suite', () => {
  const testPhone = '+573770006666';
  const otherPhone = '+573770005555';
  type FixtureUser = NonNullable<Parameters<typeof routeMessage>[1]> & { id: string };
  let user: FixtureUser;
  let otherUser: FixtureUser;

  beforeAll(async () => {
    user = await getOrCreateUserByPhone(testPhone, 'America/Bogota') as unknown as FixtureUser;
    otherUser = await getOrCreateUserByPhone(otherPhone, 'America/Bogota') as unknown as FixtureUser;

    await (supabase as unknown as FixtureClient).from('subscriptions').upsert({
      user_id: user.id,
      mp_preapproval_id: `test_preapproval_latent_${Date.now()}`,
      plan: 'pro',
      status: 'authorized',
      amount: 49900,
    }, { onConflict: 'user_id' });
  }, 20000);

  async function safeRouteMessage(text: Parameters<typeof routeMessage>[0], u: Parameters<typeof routeMessage>[1], history: NonNullable<Parameters<typeof routeMessage>[2]> = []) {
    let res = await routeMessage(text, u, history);
    if ((res?.confirmation as string | undefined)?.includes('intermitencia')) {
      console.log('[test-helper] Rate-limit intermitencia detected, waiting 5s before single retry...');
      await new Promise(r => setTimeout(r, 5000));
      res = await routeMessage(text, u, history);
    }
    return res as Awaited<ReturnType<typeof routeMessage>> & { confirmation: string };
  }

  beforeEach(async () => {
    clearWorkingMemory(testPhone);
    clearWorkingMemory(user.id);
    clearWorkingMemory(otherPhone);
    clearWorkingMemory(otherUser.id);
    await (supabase as unknown as FixtureClient).from('tasks').delete().eq('user_id', user.id);
    await (supabase as unknown as FixtureClient).from('reminders').delete().eq('user_id', user.id);
    await (supabase as unknown as FixtureClient).from('entities').delete().eq('user_id', user.id);
    await (supabase as unknown as FixtureClient).from('tasks').delete().eq('user_id', otherUser.id);
    await (supabase as unknown as FixtureClient).from('reminders').delete().eq('user_id', otherUser.id);
    await new Promise(r => setTimeout(r, 4000));
  });

  afterAll(async () => {
    if (user?.id) {
      await (supabase as unknown as FixtureClient).from('tasks').delete().eq('user_id', user.id);
      await (supabase as unknown as FixtureClient).from('reminders').delete().eq('user_id', user.id);
      await (supabase as unknown as FixtureClient).from('entities').delete().eq('user_id', user.id);
      await (supabase as unknown as FixtureClient).from('subscriptions').delete().eq('user_id', user.id);
    }
    if (otherUser?.id) {
      await (supabase as unknown as FixtureClient).from('tasks').delete().eq('user_id', otherUser.id);
      await (supabase as unknown as FixtureClient).from('reminders').delete().eq('user_id', otherUser.id);
    }
  }, 20000);

  // =========================================================================
  // BUG 1: Sent reminder -> status = sent -> cancel cannot find it
  // =========================================================================
  it('BUG 1: Dispatched/sent reminder is cancelable by content/reference (not rejected as NOT_FOUND)', async () => {
    const rem = await saveReminder({
      userId: user.id,
      phoneNumber: testPhone,
      content: 'Llamar al electricista de emergencia',
      sendAt: new Date(Date.now() - 300000).toISOString(), // 5 mins ago
    });

    // Simulate scheduler dispatching the reminder
    await (supabase as unknown as FixtureClient).from('reminders').update({ status: 'sent', sent_at: new Date().toISOString() }).eq('id', rem!.id);

    // Turn: User wants to cancel the reminder by content
    const cancelRes = await executeSingleReminderCancellation({
      params: { target: 'Llamar al electricista de emergencia' },
      user,
    });

    console.log('[REPRODUCTION BUG 1] cancelRes:', JSON.stringify(cancelRes));
    // In buggy code: cancelRes.errorCode === 'NOT_FOUND' because it only queries status='pending'
    expect(cancelRes.success).toBe(true);
    expect(cancelRes.errorCode).toBeUndefined();

    const check = await (supabase as unknown as FixtureClient).from('reminders').select('status').eq('id', rem!.id).single();
    expect(check.data!.status).toBe('cancelled');
  }, 20000);

  // =========================================================================
  // BUG 2: Task created -> router does not save to WM -> T2 anaphora fails
  // =========================================================================
  it('BUG 2: Newly created task is saved to Working Memory and resolves in next turn', async () => {
    // Turn 1: Create task via routeMessage
    const resT1 = await safeRouteMessage('Crea la tarea de comprar bombillos led', user);
    console.log('[REPRODUCTION BUG 2] T1 confirmation:', resT1.confirmation);

    const wm = getWorkingMemory(user);
    console.log('[REPRODUCTION BUG 2] Working Memory after create:', JSON.stringify(wm));

    // In buggy code: wm is null or wm.items is empty because router.js does not save single task object!
    expect(wm).not.toBeNull();
    expect(wm?.items?.length).toBeGreaterThan(0);
    expect((wm!.items[0]!.title as string).toLowerCase()).toBe('comprar bombillos led');

    // Turn 2: Anaphoric completion "Ya la hice."
    const history = [
      { role: 'user', content: 'Crea la tarea de comprar bombillos led' },
      { role: 'assistant', content: resT1.confirmation },
    ];
    await new Promise(r => setTimeout(r, 4000));
    const resT2 = await safeRouteMessage('Ya la hice.', user, history);
    console.log('[REPRODUCTION BUG 2] T2 confirmation:', resT2.confirmation);

    expect(resT2.confirmation).not.toContain('No se encontró');
    expect(resT2.confirmation).toContain('Tarea completada');

    const tasks = await getTasks({ userId: user.id, status: 'completed' });
    expect(tasks.length).toBe(1);
    expect(tasks[0]!.title.toLowerCase()).toContain('bombillos');
  }, 90000);

  // =========================================================================
  // BUG 3: Task with status='completed' -> delete cannot find it by title
  // =========================================================================
  it('BUG 3: Completed task can be deleted by title/reference (not rejected by status=pending filter)', async () => {
    const task = await createTask({
      userId: user.id,
      title: 'Comprar pintura blanca',
      status: 'completed',
    } as Parameters<typeof createTask>[0]);
    // Ensure it is marked completed in DB
    await (supabase as unknown as FixtureClient).from('tasks').update({ status: 'completed' }).eq('id', (task as { id?: string }).id);

    // User wants to delete the completed task by title
    const delRes = await executeTaskDelete({
      params: { target: 'Comprar pintura blanca' },
      user,
    });

    console.log('[REPRODUCTION BUG 3] delRes:', JSON.stringify(delRes));
    // In buggy code: delRes.errorCode === 'NOT_FOUND' because resolveTargetTask filters status='pending'
    expect(delRes.success).toBe(true);
    expect(delRes.errorCode).toBeUndefined();

    const check = await (supabase as unknown as FixtureClient).from('tasks').select('*').eq('id', (task as { id?: string }).id).maybeSingle();
    expect(check.data).toBeNull();
  }, 20000);

  // =========================================================================
  // PROPERTY 5: Completed task is NOT completable again (complete requires pending)
  // =========================================================================
  it('PROPERTY 5: Completed task cannot be re-completed via complete (must fail with NOT_FOUND)', async () => {
    const task = await createTask({
      userId: user.id,
      title: 'Hacer backup de fotos',
      status: 'completed',
    } as Parameters<typeof createTask>[0]);
    await (supabase as unknown as FixtureClient).from('tasks').update({ status: 'completed' }).eq('id', (task as { id?: string }).id);

    const compRes = await executeTaskComplete({
      params: { target: 'Hacer backup de fotos' },
      user,
    });

    // complete MUST strictly enforce pending
    expect(compRes.success).toBe(false);
    expect(compRes.errorCode).toBe('NOT_FOUND');
  }, 20000);

  it('BUG 2b: Newly created task can be deleted via "Cancélala" using Working Memory', async () => {
    const resT1 = await safeRouteMessage('Crea la tarea de comprar cinta adhesiva', user);
    const history = [
      { role: 'user', content: 'Crea la tarea de comprar cinta adhesiva' },
      { role: 'assistant', content: resT1.confirmation },
    ];
    await new Promise(r => setTimeout(r, 4000));
    const resT2 = await safeRouteMessage('Cancélala', user, history);
    console.log('[REPRODUCTION BUG 2b] Cancélala confirmation:', resT2.confirmation);

    expect(resT2.confirmation).not.toContain('No se encontró');
    expect(resT2.confirmation).toContain('eliminada');

    const tasks = await getTasks({ userId: user.id });
    expect(tasks.length).toBe(0);
  }, 90000);

  it('BUG 2c: Newly created task can be updated via "Edítala: ponle prioridad alta" using Working Memory', async () => {
    const resT1 = await safeRouteMessage('Crea la tarea de enviar reporte trimestral', user);
    const history = [
      { role: 'user', content: 'Crea la tarea de enviar reporte trimestral' },
      { role: 'assistant', content: resT1.confirmation },
    ];
    await new Promise(r => setTimeout(r, 4000));
    const resT2 = await safeRouteMessage('Edítala y ponle prioridad alta', user, history);
    console.log('[REPRODUCTION BUG 2c] Edítala confirmation:', resT2.confirmation);

    expect(resT2.confirmation).not.toContain('No se encontró');
    expect(resT2.confirmation).toContain('actualizada');

    const tasks = await getTasks({ userId: user.id });
    expect(tasks.length).toBe(1);
    expect(tasks[0]!.priority).toBe('high');
  }, 90000);

  // =========================================================================
  // PROPERTY 7: Reminder cancel permissions and status rules
  // =========================================================================
  it('PROPERTY 7: Reminder cancel respects status lifecycle and tenant isolation', async () => {
    // 7a. Pending -> cancelable
    const rPending = await saveReminder({
      userId: user.id,
      phoneNumber: testPhone,
      content: 'Cita con el dentista',
      sendAt: new Date(Date.now() + 3600000).toISOString(),
    });
    const resPend = await executeSingleReminderCancellation({ params: { target: 'Cita con el dentista' }, user });
    expect(resPend.success).toBe(true);

    // 7b. Cancelled -> already cancelled (idempotent / not found)
    const resAgain = await executeSingleReminderCancellation({ params: { target: 'Cita con el dentista' }, user });
    expect(resAgain.success).toBe(false);

    // 7c. Cross-tenant -> ACCESS_DENIED
    const otherRem = await saveReminder({
      userId: otherUser.id,
      phoneNumber: otherPhone,
      content: 'Recordatorio privado de otro usuario',
      sendAt: new Date(Date.now() + 3600000).toISOString(),
    });
    const resOther = await executeSingleReminderCancellation({ params: { target: otherRem!.id }, user });
    expect(resOther.success).toBe(false);
    expect(resOther.errorCode).toBe('ACCESS_DENIED');

    // 7d. Acknowledged -> not cancelable (already completed/acknowledged)
    const rAck = await saveReminder({
      userId: user.id,
      phoneNumber: testPhone,
      content: 'Tomar vitamina C',
      sendAt: new Date(Date.now() - 3600000).toISOString(),
    });
    await (supabase as unknown as FixtureClient).from('reminders').update({ status: 'sent', acknowledged_at: new Date().toISOString() }).eq('id', rAck!.id);
    const resAck = await executeSingleReminderCancellation({ params: { target: 'Tomar vitamina C' }, user });
    expect(resAck.success).toBe(false);
    expect(resAck.errorCode).toBe('NOT_FOUND');
  }, 25000);
});
