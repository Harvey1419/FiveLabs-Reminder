import 'dotenv/config';
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import {
  supabase,
  getOrCreateUserByPhone,
  saveReminder,
  createTask,
  getTasks,
  updateTask,
  completeTasks,
  acknowledgeReminder,
  updateReminder,
  markReminderAsCancelled,
} from '../src/db/index.js';
import { executeTool } from '../src/ai/tools.js';
import { executeTaskTool } from '../src/ai/tools/taskTools.js';
import { executeReminderTool } from '../src/ai/tools/reminderTools.js';
import { saveWorkingMemory, clearWorkingMemory } from '../src/ai/workingMemory.js';
import { isStrictUUID, normalizeTextForMatching, stripConversationalWrappers } from '../src/utils/entityResolution.js';

describe('Hermes Entity Resolution & Defect Elimination Audit Test Suite', () => {
  const userAPhone = '+573888000111';
  const userBPhone = '+573888000222';
  let userA, userB;

  beforeAll(async () => {
    userA = await getOrCreateUserByPhone(userAPhone, 'America/Bogota');
    userB = await getOrCreateUserByPhone(userBPhone, 'America/Bogota');

    await supabase.from('tasks').delete().eq('user_id', userA.id);
    await supabase.from('tasks').delete().eq('user_id', userB.id);
    await supabase.from('reminders').delete().eq('user_id', userA.id);
    await supabase.from('reminders').delete().eq('user_id', userB.id);
  }, 20000);

  beforeEach(() => {
    clearWorkingMemory(userA);
    clearWorkingMemory(userB);
  });

  afterAll(async () => {
    if (userA?.id) {
      await supabase.from('tasks').delete().eq('user_id', userA.id);
      await supabase.from('reminders').delete().eq('user_id', userA.id);
    }
    if (userB?.id) {
      await supabase.from('tasks').delete().eq('user_id', userB.id);
      await supabase.from('reminders').delete().eq('user_id', userB.id);
    }
  }, 20000);

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // TASKS RESOLUTION TESTS (CASES 1 - 14)
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  it('CASE 1: Task con título corto -> encontrar y resolver', async () => {
    const { data: t } = await createTask({
      userId: userA.id,
      title: 'Comprar pan',
      priority: 'medium',
    });

    const res = await executeTaskTool({
      action: 'complete',
      params: { target: 'Comprar pan' },
      user: userA,
    });

    expect(res.success).toBe(true);
    expect(res.taskId).toBe(t.id);

    const { data: dbTask } = await supabase.from('tasks').select('status').eq('id', t.id).single();
    expect(dbTask.status).toBe('completed');
  });

  it('CASE 2: Task con título largo -> encontrar y resolver', async () => {
    const longTitle = 'Diseñar el orden BAM para poder tener más dinero con la misma orden';
    const { data: t } = await createTask({
      userId: userA.id,
      title: longTitle,
      priority: 'high',
    });

    const res = await executeTaskTool({
      action: 'complete',
      params: { target: longTitle },
      user: userA,
    });

    expect(res.success).toBe(true);
    expect(res.taskId).toBe(t.id);
  });

  it('CASE 3: Task con título >36 caracteres -> NO interpretar como UUID ni fallar SQL', async () => {
    // 45 chars string
    const titleOver36 = 'Configurar pasarela de pagos en Mercado Pago 2026';
    expect(titleOver36.length).toBeGreaterThan(36);
    expect(isStrictUUID(titleOver36)).toBe(false);

    const { data: t } = await createTask({
      userId: userA.id,
      title: titleOver36,
      priority: 'urgent',
    });

    const res = await executeTaskTool({
      action: 'complete',
      params: { target: titleOver36 },
      user: userA,
    });

    expect(res.success).toBe(true);
    expect(res.taskId).toBe(t.id);
  });

  it('CASE 4: Título exacto -> encontrar', async () => {
    const { data: t } = await createTask({
      userId: userA.id,
      title: 'Revisar métricas de conversión',
    });

    const res = await executeTaskTool({
      action: 'complete',
      params: { title: 'Revisar métricas de conversión' },
      user: userA,
    });

    expect(res.success).toBe(true);
    expect(res.taskId).toBe(t.id);
  });

  it('CASE 5: Título con diferencias de mayúsculas/minúsculas -> encontrar', async () => {
    const { data: t } = await createTask({
      userId: userA.id,
      title: 'REVISAR CONTRATO LEGAL CON CLIENTE',
    });

    const res = await executeTaskTool({
      action: 'complete',
      params: { target: 'revisar contrato legal con cliente' },
      user: userA,
    });

    expect(res.success).toBe(true);
    expect(res.taskId).toBe(t.id);
  });

  it('CASE 6: Título con tildes / diacríticos -> encontrar', async () => {
    const { data: t } = await createTask({
      userId: userA.id,
      title: 'Planificación de la reunión estratégica de producción',
    });

    // Query without tildes
    const res = await executeTaskTool({
      action: 'complete',
      params: { target: 'Planificacion de la reunion estrategica de produccion' },
      user: userA,
    });

    expect(res.success).toBe(true);
    expect(res.taskId).toBe(t.id);
  });

  it('CASE 7: Título con puntuación, comillas y espacios extra -> encontrar', async () => {
    const { data: t } = await createTask({
      userId: userA.id,
      title: 'Comprar comida para Borona',
    });

    const res = await executeTaskTool({
      action: 'complete',
      params: { target: '  "Comprar comida para Borona."  ' },
      user: userA,
    });

    expect(res.success).toBe(true);
    expect(res.taskId).toBe(t.id);
  });

  it('CASE 8: "Título: ya lo hice" -> separar intención de completion y resolver task', async () => {
    const { data: t } = await createTask({
      userId: userA.id,
      title: 'Diseñar el orden BAM para poder tener más dinero con la misma orden',
    });

    const res = await executeTaskTool({
      action: 'complete',
      params: { target: 'Diseñar el orden BAM para poder tener más dinero con la misma orden: Ya lo hice' },
      user: userA,
    });

    expect(res.success).toBe(true);
    expect(res.taskId).toBe(t.id);
  });

  it('CASE 9: "Ya la hice" con contexto suficiente de Working Memory -> encontrar Task correcta', async () => {
    const { data: t } = await createTask({
      userId: userA.id,
      title: 'Enviar reporte financiero mensual',
    });

    // Simulate previous turn injected into Working Memory
    saveWorkingMemory(userA, {
      source: 'task',
      items: [
        { internalId: t.id, title: t.title, type: 'task' },
      ],
    });

    const res = await executeTaskTool({
      action: 'complete',
      params: { target: 'Ya la hice' },
      user: userA,
    });

    expect(res.success).toBe(true);
    expect(res.taskId).toBe(t.id);
  });

  it('CASE 10: "La segunda ya la hice" -> resolver la segunda Task de Working Memory', async () => {
    const { data: t1 } = await createTask({ userId: userA.id, title: 'Revisar correo' });
    const { data: t2 } = await createTask({ userId: userA.id, title: 'Comprar comida' });
    const { data: t3 } = await createTask({ userId: userA.id, title: 'Llamar al veterinario' });

    saveWorkingMemory(userA, {
      source: 'task',
      items: [
        { internalId: t1.id, title: t1.title, type: 'task' },
        { internalId: t2.id, title: t2.title, type: 'task' },
        { internalId: t3.id, title: t3.title, type: 'task' },
      ],
    });

    const res = await executeTaskTool({
      action: 'complete',
      params: { target: 'La segunda ya la hice' },
      user: userA,
    });

    expect(res.success).toBe(true);
    expect(res.taskId).toBe(t2.id);
  });

  it('CASE 11: Dos Tasks similares sin contexto -> AMBIGUOUS_TARGET sin mutación arbitraria', async () => {
    await createTask({ userId: userA.id, title: 'Comprar leche deslactosada' });
    await createTask({ userId: userA.id, title: 'Comprar leche de almendras' });

    const res = await executeTaskTool({
      action: 'complete',
      params: { target: 'Comprar leche' },
      user: userA,
    });

    expect(res.success).toBe(false);
    expect(res.errorCode).toBe('AMBIGUOUS_TARGET');
  });

  it('CASE 12: Task inexistente -> NOT_FOUND', async () => {
    const res = await executeTaskTool({
      action: 'complete',
      params: { target: 'Volar a la luna en cohete' },
      user: userA,
    });

    expect(res.success).toBe(false);
    expect(res.errorCode).toBe('NOT_FOUND');
  });

  it('CASE 13: Task de otro usuario -> ACCESS_DENIED y NO mutar', async () => {
    const { data: tUserB } = await createTask({
      userId: userB.id,
      title: 'Tarea secreta de Usuario B',
    });

    // User A attempts to complete User B's task by exact UUID
    const res = await executeTaskTool({
      action: 'complete',
      params: { target: tUserB.id },
      user: userA,
    });

    expect(res.success).toBe(false);
    expect(res.errorCode).toMatch(/ACCESS_DENIED|NOT_FOUND/);

    // Verify task is still pending for User B
    const { data: dbTask } = await supabase.from('tasks').select('status').eq('id', tUserB.id).single();
    expect(dbTask.status).toBe('pending');
  });

  it('CASE 14: Completion repetido -> idempotente según contrato', async () => {
    const { data: t } = await createTask({
      userId: userA.id,
      title: 'Configurar variables de entorno',
    });

    // 1st completion
    const res1 = await executeTaskTool({
      action: 'complete',
      params: { target: t.id },
      user: userA,
    });
    expect(res1.success).toBe(true);

    // 2nd completion by ID
    const res2 = await updateTask(t.id, { status: 'completed' }, userA.id);
    expect(res2.status).toBe('completed');
  });

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // REMINDERS RESOLUTION TESTS (CASES 15 - 23)
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  it('CASE 15: Reminder con título corto -> encontrar y confirmar', async () => {
    const rem = await saveReminder({
      userId: userA.id,
      phoneNumber: userAPhone,
      content: 'Comprar agua',
      sendAt: new Date().toISOString(),
      requiresConfirmation: true,
    });

    const res = await executeReminderTool({
      action: 'acknowledge',
      params: { target: 'Comprar agua' },
      user: userA,
    });

    expect(res.success).toBe(true);
    expect(res.reminderId).toBe(rem.id);

    const { data: dbRem } = await supabase.from('reminders').select('acknowledged_at').eq('id', rem.id).single();
    expect(dbRem.acknowledged_at).not.toBeNull();
  });

  it('CASE 16: Reminder con título largo (>36 chars) -> encontrar sin error UUID', async () => {
    const longContent = 'Llevar a Borona a su cita médica de control postoperatorio';
    expect(longContent.length).toBeGreaterThan(36);

    const rem = await saveReminder({
      userId: userA.id,
      phoneNumber: userAPhone,
      content: longContent,
      sendAt: new Date().toISOString(),
      requiresConfirmation: true,
    });

    const res = await executeReminderTool({
      action: 'acknowledge',
      params: { target: longContent },
      user: userA,
    });

    expect(res.success).toBe(true);
    expect(res.reminderId).toBe(rem.id);
  });

  it('CASE 17: Reminder con tildes y puntuación -> encontrar', async () => {
    const rem = await saveReminder({
      userId: userA.id,
      phoneNumber: userAPhone,
      content: 'Revisión técnica de la camioneta en el taller',
      sendAt: new Date().toISOString(),
      requiresConfirmation: true,
    });

    const res = await executeReminderTool({
      action: 'acknowledge',
      params: { target: 'Revision tecnica de la camioneta' },
      user: userA,
    });

    expect(res.success).toBe(true);
    expect(res.reminderId).toBe(rem.id);
  });

  it('CASE 18: Referencia explícita con prefijo conversacional -> encontrar', async () => {
    const rem = await saveReminder({
      userId: userA.id,
      phoneNumber: userAPhone,
      content: 'Pagar la matrícula del colegio',
      sendAt: new Date().toISOString(),
      requiresConfirmation: true,
    });

    const res = await executeReminderTool({
      action: 'acknowledge',
      params: { target: 'Completa el recordatorio de pagar la matrícula del colegio' },
      user: userA,
    });

    expect(res.success).toBe(true);
    expect(res.reminderId).toBe(rem.id);
  });

  it('CASE 19: Referencia contextual ("Ya fui" / "Listo") con notificación activa -> encontrar', async () => {
    const rem = await saveReminder({
      userId: userA.id,
      phoneNumber: userAPhone,
      content: 'Pasar al banco a retirar efectivo',
      sendAt: new Date().toISOString(),
      requiresConfirmation: true,
    });

    saveWorkingMemory(userA, {
      source: 'reminder',
      lastAction: 'nudge',
      items: [{ internalId: rem.id, title: rem.content, type: 'reminder' }],
    });

    const res = await executeReminderTool({
      action: 'acknowledge',
      params: { target: 'Ya fui' },
      user: userA,
    });

    expect(res.success).toBe(true);
    expect(res.reminderId).toBe(rem.id);
  });

  it('CASE 20: Referencia ordinal -> encontrar y cancelar segundo recordatorio', async () => {
    const rem1 = await saveReminder({ userId: userA.id, phoneNumber: userAPhone, content: 'Regar las plantas', sendAt: new Date().toISOString() });
    const rem2 = await saveReminder({ userId: userA.id, phoneNumber: userAPhone, content: 'Pagar tarjeta de crédito', sendAt: new Date().toISOString() });

    saveWorkingMemory(userA, {
      source: 'reminder',
      items: [
        { internalId: rem1.id, title: rem1.content, type: 'reminder' },
        { internalId: rem2.id, title: rem2.content, type: 'reminder' },
      ],
    });

    const res = await executeReminderTool({
      action: 'cancel',
      params: { target: 'el segundo' },
      user: userA,
    });

    expect(res.success).toBe(true);

    const { data: dbRem2 } = await supabase.from('reminders').select('status').eq('id', rem2.id).single();
    expect(dbRem2.status).toBe('cancelled');

    const { data: dbRem1 } = await supabase.from('reminders').select('status').eq('id', rem1.id).single();
    expect(dbRem1.status).not.toBe('cancelled');
  });

  it('CASE 21: Ambigüedad entre múltiples recordatorios -> pedir aclaración', async () => {
    await saveReminder({ userId: userA.id, phoneNumber: userAPhone, content: 'Llamar a Juan Pérez', sendAt: new Date().toISOString(), requiresConfirmation: true });
    await saveReminder({ userId: userA.id, phoneNumber: userAPhone, content: 'Llamar a Juan Gómez', sendAt: new Date().toISOString(), requiresConfirmation: true });

    const res = await executeReminderTool({
      action: 'acknowledge',
      params: { target: 'Llamar a Juan' },
      user: userA,
    });

    expect(res.success).toBe(false);
    expect(res.errorCode).toBe('AMBIGUOUS_TARGET');
  });

  it('CASE 22: Reminder inexistente -> NOT_FOUND', async () => {
    const res = await executeReminderTool({
      action: 'acknowledge',
      params: { target: 'Ir a Saturno' },
      user: userA,
    });

    expect(res.success).toBe(false);
    expect(res.errorCode).toBe('NOT_FOUND');
  });

  it('CASE 23: Reminder de otro usuario -> ACCESS_DENIED y NO mutar', async () => {
    const remB = await saveReminder({
      userId: userB.id,
      phoneNumber: userBPhone,
      content: 'Recordatorio privado de Usuario B',
      sendAt: new Date().toISOString(),
      requiresConfirmation: true,
    });

    const res = await executeReminderTool({
      action: 'acknowledge',
      params: { target: remB.id },
      user: userA,
    });

    expect(res.success).toBe(false);
    expect(res.errorCode).toMatch(/ACCESS_DENIED|NOT_FOUND/);

    const { data: dbRemB } = await supabase.from('reminders').select('acknowledged_at').eq('id', remB.id).single();
    expect(dbRemB.acknowledged_at).toBeNull();
  });
});
