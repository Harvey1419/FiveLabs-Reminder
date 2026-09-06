import 'dotenv/config';
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { getOrCreateUserByPhone } from '../../../src/infrastructure/database/users.js';
import {
  createTask,
  getTasks,
  findOrCreateEntityFuzzy,
  saveReminder,
  getRemindersByPhone,
  supabase,
} from '../../../src/infrastructure/database/index.js';
import { routeMessage } from '../../../src/agent/orchestration/router.js';
import { executeTool } from '../../../src/agent/tools/index.js';
import { clearWorkingMemory, getWorkingMemory, saveWorkingMemory } from '../../../src/agent/core/working-memory.js';

describe('Hermes Regression & Generalization Diagnostic Test Suite', () => {
  const testPhone = '+573770008888';
  const otherPhone = '+573770007777';
  let user;
  let otherUser;

  beforeAll(async () => {
    user = await getOrCreateUserByPhone(testPhone, 'America/Bogota');
    otherUser = await getOrCreateUserByPhone(otherPhone, 'America/Bogota');

    await supabase.from('subscriptions').upsert({
      user_id: user.id,
      mp_preapproval_id: `test_preapproval_diag_${Date.now()}`,
      plan: 'pro',
      status: 'authorized',
      amount: 49900,
    }, { onConflict: 'user_id' });
  }, 20000);

  beforeEach(async () => {
    clearWorkingMemory(testPhone);
    clearWorkingMemory(user.id);
    clearWorkingMemory(otherPhone);
    clearWorkingMemory(otherUser.id);
    await supabase.from('tasks').delete().eq('user_id', user.id);
    await supabase.from('reminders').delete().eq('user_id', user.id);
    await supabase.from('entities').delete().eq('user_id', user.id);
    await supabase.from('tasks').delete().eq('user_id', otherUser.id);
    await supabase.from('reminders').delete().eq('user_id', otherUser.id);
  });

  afterAll(async () => {
    if (user?.id) {
      await supabase.from('tasks').delete().eq('user_id', user.id);
      await supabase.from('reminders').delete().eq('user_id', user.id);
      await supabase.from('entities').delete().eq('user_id', user.id);
      await supabase.from('subscriptions').delete().eq('user_id', user.id);
    }
    if (otherUser?.id) {
      await supabase.from('tasks').delete().eq('user_id', otherUser.id);
      await supabase.from('reminders').delete().eq('user_id', otherUser.id);
    }
  }, 20000);

  // ==========================================
  // SECTION 1: TASKS NATURAL LANGUAGE PHRASES
  // ==========================================

  it('TASK CASE 1: Contextual single task in memory -> "Ya hice esa."', async () => {
    const task = await createTask({ userId: user.id, title: 'Comprar comida para el perro' });
    
    // Simulate T1: User listed tasks or asked what tasks exist
    const resT1 = await routeMessage('¿Cuáles son mis tareas?', user);
    expect(resT1.confirmation).toContain('Comprar comida para el perro');

    const history = [
      { role: 'user', content: '¿Cuáles son mis tareas?' },
      { role: 'assistant', content: resT1.confirmation },
    ];

    // T2: "Ya hice esa."
    const resT2 = await routeMessage('Ya hice esa.', user, history);
    console.log('[DIAGNOSTIC] Task Case 1 ("Ya hice esa.") -> Confirmation:', resT2.confirmation, 'Plan:', JSON.stringify(resT2.plan));

    const check = await supabase.from('tasks').select('*').eq('id', task.id).single();
    expect(check.data.status).toBe('completed');
  }, 35000);

  it('TASK CASE 2: Contextual single task in memory -> "Esa ya quedó."', async () => {
    const task = await createTask({ userId: user.id, title: 'Enviar reporte financiero' });
    
    const resT1 = await routeMessage('¿Cuáles son mis tareas?', user);
    const history = [
      { role: 'user', content: '¿Cuáles son mis tareas?' },
      { role: 'assistant', content: resT1.confirmation },
    ];

    const resT2 = await routeMessage('Esa ya quedó.', user, history);
    console.log('[DIAGNOSTIC] Task Case 2 ("Esa ya quedó.") -> Confirmation:', resT2.confirmation, 'Plan:', JSON.stringify(resT2.plan));

    const check = await supabase.from('tasks').select('*').eq('id', task.id).single();
    expect(check.data.status).toBe('completed');
  }, 35000);

  it('TASK CASE 3: Multiple tasks in memory -> "Completa la segunda."', async () => {
    const t1 = await createTask({ userId: user.id, title: 'Revisar landing page' });
    const t2 = await createTask({ userId: user.id, title: 'Pagar nómina' });
    const t3 = await createTask({ userId: user.id, title: 'Llamar al banco' });

    const resT1 = await routeMessage('¿Cuáles son mis tareas?', user);
    const history = [
      { role: 'user', content: '¿Cuáles son mis tareas?' },
      { role: 'assistant', content: resT1.confirmation },
    ];

    const resT2 = await routeMessage('Completa la segunda.', user, history);
    console.log('[DIAGNOSTIC] Task Case 3 ("Completa la segunda.") -> Confirmation:', resT2.confirmation, 'Plan:', JSON.stringify(resT2.plan));

    const checkT2 = await supabase.from('tasks').select('*').eq('id', t2.id).single();
    expect(checkT2.data.status).toBe('completed');

    const checkT1 = await supabase.from('tasks').select('*').eq('id', t1.id).single();
    expect(checkT1.data.status).toBe('pending');
  }, 35000);

  it('TASK CASE 4: Multiple tasks in memory -> "La segunda ya está."', async () => {
    const t1 = await createTask({ userId: user.id, title: 'Redactar propuesta' });
    const t2 = await createTask({ userId: user.id, title: 'Comprar cartuchos de tinta' });

    const resT1 = await routeMessage('¿Cuáles son mis tareas?', user);
    const wm = getWorkingMemory(user);
    expect(wm?.items?.length).toBe(2);
    const secondItemId = wm.items[1].internalId;

    const history = [
      { role: 'user', content: '¿Cuáles son mis tareas?' },
      { role: 'assistant', content: resT1.confirmation },
    ];

    const resT2 = await routeMessage('La segunda ya está.', user, history);
    console.log('[DIAGNOSTIC] Task Case 4 ("La segunda ya está.") -> Confirmation:', resT2.confirmation, 'Plan:', JSON.stringify(resT2.plan));

    const checkSecond = await supabase.from('tasks').select('*').eq('id', secondItemId).single();
    expect(checkSecond.data.status).toBe('completed');
  }, 35000);

  it('TASK CASE 5: Multiple tasks in memory -> "Me encargo de la última."', async () => {
    const t1 = await createTask({ userId: user.id, title: 'Cotizar vuelos' });
    const t2 = await createTask({ userId: user.id, title: 'Anotar gastos de viaje' });

    const resT1 = await routeMessage('¿Cuáles son mis tareas?', user);
    const history = [
      { role: 'user', content: '¿Cuáles son mis tareas?' },
      { role: 'assistant', content: resT1.confirmation },
    ];

    const resT2 = await routeMessage('Me encargo de la última.', user, history);
    console.log('[DIAGNOSTIC] Task Case 5 ("Me encargo de la última.") -> Confirmation:', resT2.confirmation, 'Plan:', JSON.stringify(resT2.plan));

    // Note: "Me encargo" can be intent to mark done or acknowledge
  }, 35000);

  it('TASK CASE 6: Contextual task -> "Ya terminé esa tarea."', async () => {
    const t1 = await createTask({ userId: user.id, title: 'Actualizar hoja de cálculo' });

    const resT1 = await routeMessage('¿Cuáles son mis tareas?', user);
    const history = [
      { role: 'user', content: '¿Cuáles son mis tareas?' },
      { role: 'assistant', content: resT1.confirmation },
    ];

    const resT2 = await routeMessage('Ya terminé esa tarea.', user, history);
    console.log('[DIAGNOSTIC] Task Case 6 ("Ya terminé esa tarea.") -> Confirmation:', resT2.confirmation, 'Plan:', JSON.stringify(resT2.plan));

    const check = await supabase.from('tasks').select('*').eq('id', t1.id).single();
    expect(check.data.status).toBe('completed');
  }, 35000);

  it('TASK CASE 7: Contextual task -> "Puedes dar esa por terminada."', async () => {
    const t1 = await createTask({ userId: user.id, title: 'Alinear equipo de ventas' });

    const resT1 = await routeMessage('¿Cuáles son mis tareas?', user);
    const history = [
      { role: 'user', content: '¿Cuáles son mis tareas?' },
      { role: 'assistant', content: resT1.confirmation },
    ];

    const resT2 = await routeMessage('Puedes dar esa por terminada.', user, history);
    console.log('[DIAGNOSTIC] Task Case 7 ("Puedes dar esa por terminada.") -> Confirmation:', resT2.confirmation, 'Plan:', JSON.stringify(resT2.plan));

    const check = await supabase.from('tasks').select('*').eq('id', t1.id).single();
    expect(check.data.status).toBe('completed');
  }, 35000);

  it('TASK CASE 8: Semantic content reference -> "Ya hice la de comprar comida."', async () => {
    const t1 = await createTask({ userId: user.id, title: 'Comprar comida' });
    const t2 = await createTask({ userId: user.id, title: 'Enviar correo a soporte' });

    const res = await routeMessage('Ya hice la de comprar comida.', user);
    console.log('[DIAGNOSTIC] Task Case 8 ("Ya hice la de comprar comida.") -> Confirmation:', res.confirmation, 'Plan:', JSON.stringify(res.plan));

    const check = await supabase.from('tasks').select('*').eq('id', t1.id).single();
    expect(check.data.status).toBe('completed');
  }, 35000);

  it('TASK CASE 9: Explicit reference -> "Completa la que dice comprar comida."', async () => {
    const t1 = await createTask({ userId: user.id, title: 'Comprar comida' });

    const res = await routeMessage('Completa la que dice comprar comida.', user);
    console.log('[DIAGNOSTIC] Task Case 9 ("Completa la que dice comprar comida.") -> Confirmation:', res.confirmation, 'Plan:', JSON.stringify(res.plan));

    const check = await supabase.from('tasks').select('*').eq('id', t1.id).single();
    expect(check.data.status).toBe('completed');
  }, 35000);

  // ==========================================
  // SECTION 2: REMINDERS NATURAL LANGUAGE PHRASES
  // ==========================================

  it('REMINDER CASE 1: Active reminder contextual -> "Ese ya no hace falta."', async () => {
    const rem = await saveReminder({
      userId: user.id,
      phoneNumber: testPhone,
      content: 'Llamar al cerrajero',
      sendAt: new Date(Date.now() + 3600000).toISOString(),
    });

    const resT1 = await routeMessage('¿Qué recordatorios tengo?', user);
    const history = [
      { role: 'user', content: '¿Qué recordatorios tengo?' },
      { role: 'assistant', content: resT1.confirmation },
    ];

    const resT2 = await routeMessage('Ese ya no hace falta.', user, history);
    console.log('[DIAGNOSTIC] Reminder Case 1 ("Ese ya no hace falta.") -> Confirmation:', resT2.confirmation, 'Plan:', JSON.stringify(resT2.plan));

    const check = await supabase.from('reminders').select('*').eq('id', rem.id).single();
    expect(['cancelled', 'acknowledged', 'completed']).toContain(check.data.status);
  }, 35000);

  it('REMINDER CASE 2: Active reminder contextual -> "Puedes quitar ese."', async () => {
    const rem = await saveReminder({
      userId: user.id,
      phoneNumber: testPhone,
      content: 'Regar las plantas',
      sendAt: new Date(Date.now() + 3600000).toISOString(),
    });

    const resT1 = await routeMessage('¿Qué recordatorios tengo?', user);
    const history = [
      { role: 'user', content: '¿Qué recordatorios tengo?' },
      { role: 'assistant', content: resT1.confirmation },
    ];

    const resT2 = await routeMessage('Puedes quitar ese.', user, history);
    console.log('[DIAGNOSTIC] Reminder Case 2 ("Puedes quitar ese.") -> Confirmation:', resT2.confirmation, 'Plan:', JSON.stringify(resT2.plan));

    const check = await supabase.from('reminders').select('*').eq('id', rem.id).single();
    expect(['cancelled', 'deleted']).toContain(check.data.status);
  }, 35000);

  it('REMINDER CASE 3: Contextual acknowledgment -> "Ya hice eso."', async () => {
    const rem = await saveReminder({
      userId: user.id,
      phoneNumber: testPhone,
      content: 'Tomarme la pastilla de la tensión',
      sendAt: new Date(Date.now() + 3600000).toISOString(),
    });

    const resT1 = await routeMessage('¿Qué recordatorios tengo?', user);
    const history = [
      { role: 'user', content: '¿Qué recordatorios tengo?' },
      { role: 'assistant', content: resT1.confirmation },
    ];

    const resT2 = await routeMessage('Ya hice eso.', user, history);
    console.log('[DIAGNOSTIC] Reminder Case 3 ("Ya hice eso.") -> Confirmation:', resT2.confirmation, 'Plan:', JSON.stringify(resT2.plan));

    const check = await supabase.from('reminders').select('*').eq('id', rem.id).single();
    expect(check.data.acknowledged_at).not.toBeNull();
    expect(['sent', 'acknowledged', 'completed']).toContain(check.data.status);
  }, 35000);

  it('REMINDER CASE 4: Ordinal cancellation -> "El primero ya no lo necesito."', async () => {
    const r1 = await saveReminder({
      userId: user.id,
      phoneNumber: testPhone,
      content: 'Revisar correo spam',
      sendAt: new Date(Date.now() + 3600000).toISOString(),
    });
    const r2 = await saveReminder({
      userId: user.id,
      phoneNumber: testPhone,
      content: 'Ir al supermercado',
      sendAt: new Date(Date.now() + 7200000).toISOString(),
    });

    const resT1 = await routeMessage('¿Qué recordatorios tengo?', user);
    const history = [
      { role: 'user', content: '¿Qué recordatorios tengo?' },
      { role: 'assistant', content: resT1.confirmation },
    ];

    const resT2 = await routeMessage('El primero ya no lo necesito.', user, history);
    console.log('[DIAGNOSTIC] Reminder Case 4 ("El primero ya no lo necesito.") -> Confirmation:', resT2.confirmation, 'Plan:', JSON.stringify(resT2.plan));

    const checkR1 = await supabase.from('reminders').select('*').eq('id', r1.id).single();
    expect(['cancelled', 'deleted']).toContain(checkR1.data.status);

    const checkR2 = await supabase.from('reminders').select('*').eq('id', r2.id).single();
    expect(checkR2.data.status).toBe('pending');
  }, 35000);

  it('REMINDER CASE 5: Affirmative -> "Ya quedó."', async () => {
    const rem = await saveReminder({
      userId: user.id,
      phoneNumber: testPhone,
      content: 'Llamar al médico',
      sendAt: new Date(Date.now() + 3600000).toISOString(),
    });

    const resT1 = await routeMessage('¿Qué recordatorios tengo?', user);
    const history = [
      { role: 'user', content: '¿Qué recordatorios tengo?' },
      { role: 'assistant', content: resT1.confirmation },
    ];

    const resT2 = await routeMessage('Ya quedó.', user, history);
    console.log('[DIAGNOSTIC] Reminder Case 5 ("Ya quedó.") -> Confirmation:', resT2.confirmation, 'Plan:', JSON.stringify(resT2.plan));

    const check = await supabase.from('reminders').select('*').eq('id', rem.id).single();
    expect(check.data.acknowledged_at).not.toBeNull();
    expect(['sent', 'acknowledged', 'completed']).toContain(check.data.status);
  }, 35000);

  // ==========================================
  // SECTION 3: CONTAINER VS INDIVIDUAL TASK RESOLUTION
  // ==========================================

  it('CONTAINER VS INDIVIDUAL: "Completa comprar leche" inside "Lista de compras" only completes that task', async () => {
    const entity = await findOrCreateEntityFuzzy({
      userId: user.id,
      name: 'Lista de compras',
      category: 'other',
    });

    const t1 = await createTask({ userId: user.id, title: 'Comprar leche', entityId: entity.id });
    const t2 = await createTask({ userId: user.id, title: 'Comprar pan', entityId: entity.id });
    const t3 = await createTask({ userId: user.id, title: 'Comprar huevos', entityId: entity.id });

    const res = await routeMessage('Completa comprar leche.', user);
    console.log('[DIAGNOSTIC] Individual task inside container -> Confirmation:', res.confirmation);

    const checkT1 = await supabase.from('tasks').select('*').eq('id', t1.id).single();
    expect(checkT1.data.status).toBe('completed');

    const checkT2 = await supabase.from('tasks').select('*').eq('id', t2.id).single();
    expect(checkT2.data.status).toBe('pending');

    const checkT3 = await supabase.from('tasks').select('*').eq('id', t3.id).single();
    expect(checkT3.data.status).toBe('pending');
  }, 35000);

  // ==========================================
  // SECTION 4: LONG TITLE REGRESSION (>36 CHARS)
  // ==========================================

  it('LONG TITLE: Title > 36 chars is resolved without UUID syntax error', async () => {
    const longTitle = 'Actualización trimestral de la infraestructura de base de datos en AWS';
    expect(longTitle.length).toBeGreaterThan(36);

    const task = await createTask({ userId: user.id, title: longTitle });

    const res = await routeMessage(`Ya completé ${longTitle}`, user);
    console.log('[DIAGNOSTIC] Long title task -> Confirmation:', res.confirmation);

    const check = await supabase.from('tasks').select('*').eq('id', task.id).single();
    expect(check.data.status).toBe('completed');
  }, 35000);

  // ==========================================
  // SECTION 5: NEGATIVE CASES
  // ==========================================

  it('NEGATIVE CASE 1: Inexistent task returns NOT_FOUND or chat without arbitrary mutation', async () => {
    const res = await routeMessage('Completa la tarea de viajar a la luna', user);
    console.log('[DIAGNOSTIC] Inexistent task -> Confirmation:', res.confirmation);

    const pending = await getTasks({ userId: user.id, status: 'completed' });
    expect(pending.length).toBe(0);
  }, 35000);

  it('NEGATIVE CASE 2: Ambiguous tasks without context asks clarification and DOES NOT mutate', async () => {
    const t1 = await createTask({ userId: user.id, title: 'Revisar informe de ventas' });
    const t2 = await createTask({ userId: user.id, title: 'Revisar informe de marketing' });

    const res = await routeMessage('Completa revisar informe', user);
    console.log('[DIAGNOSTIC] Ambiguous task -> Confirmation:', res.confirmation);

    const checkT1 = await supabase.from('tasks').select('*').eq('id', t1.id).single();
    const checkT2 = await supabase.from('tasks').select('*').eq('id', t2.id).single();

    expect(checkT1.data.status).toBe('pending');
    expect(checkT2.data.status).toBe('pending');
  }, 35000);

  it('NEGATIVE CASE 3: Cross-tenant isolation -> Cannot mutate task belonging to another user', async () => {
    const otherTask = await createTask({ userId: otherUser.id, title: 'Tarea secreta de otro usuario' });

    const res = await routeMessage(`Completa la tarea ${otherTask.id}`, user);
    console.log('[DIAGNOSTIC] Cross-tenant attempt -> Confirmation:', res.confirmation);

    const check = await supabase.from('tasks').select('*').eq('id', otherTask.id).single();
    expect(check.data.status).toBe('pending');
  }, 35000);

  it('NEGATIVE CASE 4: Standalone affirmative without context asks clarification and DOES NOT mutate', async () => {
    // Zero tasks and zero reminders exist
    const res = await routeMessage('Ya la hice.', user);
    console.log('[DIAGNOSTIC] Standalone without context -> Confirmation:', res.confirmation);

    expect(res.confirmation).not.toContain('✅ *Tarea completada*');
    expect(res.confirmation).not.toContain('✅ *Recordatorio confirmado*');
  }, 35000);
});
