import 'dotenv/config';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { getOrCreateUserByPhone } from '../src/db/users.js';
import {
  createTask,
  getTasks,
  completeTasks,
  findOrCreateEntityFuzzy,
  getDailyOverview,
  supabase,
} from '../src/db/index.js';
import { routeMessage } from '../src/ai/router.js';
import { executeTool } from '../src/ai/tools.js';

describe('Hermes Task Management & Transaction Guard Test Suite', () => {
  const testPhone = '+573775550001';
  let user;

  beforeAll(async () => {
    user = await getOrCreateUserByPhone(testPhone, 'America/Bogota');
    await supabase.from('tasks').delete().eq('user_id', user.id);
    await supabase.from('reminders').delete().eq('user_id', user.id);
    await supabase.from('entities').delete().eq('user_id', user.id);
    await supabase.from('subscriptions').delete().eq('user_id', user.id);

    await supabase.from('subscriptions').insert({
      user_id: user.id,
      mp_preapproval_id: `test_preapproval_tasks_${Date.now()}`,
      plan: 'pro',
      status: 'authorized',
      amount: 49900,
    });
  }, 20000);

  afterAll(async () => {
    await supabase.from('tasks').delete().eq('user_id', user.id);
    await supabase.from('reminders').delete().eq('user_id', user.id);
    await supabase.from('entities').delete().eq('user_id', user.id);
    await supabase.from('subscriptions').delete().eq('user_id', user.id);
  }, 20000);

  it('creates project and task atomically via executeTool manage_task', async () => {
    const res = await executeTool('manage_task', {
      action: 'create',
      items: [
        {
          title: 'Configurar pasarela de pagos',
          entityName: 'Proyecto Hermes Test',
          entityCategory: 'project',
        },
      ],
    }, user);

    expect(res.success).toBe(true);
    expect(res.data.length).toBe(1);

    // Verify task in DB
    const tasks = await getTasks({ userId: user.id, entityName: 'Proyecto Hermes Test' });
    expect(tasks.length).toBe(1);
    expect(tasks[0].title).toBe('Configurar pasarela de pagos');
    expect(tasks[0].entities?.name).toBe('Proyecto Hermes Test');
  });

  it('filters tasks by entityName fuzzy match in getTasks', async () => {
    await executeTool('manage_task', {
      action: 'create',
      items: [
        {
          title: 'Comprar frutas',
          entityName: 'Lista de compras',
          entityCategory: 'other',
        },
      ],
    }, user);

    const projectTasks = await getTasks({ userId: user.id, entityName: 'Hermes Test' });
    expect(projectTasks.length).toBe(1);
    expect(projectTasks[0].title).toBe('Configurar pasarela de pagos');

    const shoppingTasks = await getTasks({ userId: user.id, entityName: 'Lista de compras' });
    expect(shoppingTasks.length).toBe(1);
    expect(shoppingTasks[0].title).toBe('Comprar frutas');
  });

  it('routes message to add a task in a project and persists to DB', async () => {
    const res = await routeMessage(
      'En el proyecto Hermes Test ponme otra tarea: Realizar pruebas unitarias de regresión',
      user
    );

    expect(res.confirmation).toBeDefined();

    // Verify task exists in DB
    const { data: dbTasks } = await supabase
      .from('tasks')
      .select('*, entities:entity_id(name)')
      .eq('user_id', user.id)
      .ilike('title', '%pruebas unitarias%');

    expect(dbTasks?.length).toBeGreaterThanOrEqual(1);
  }, 35000);

  it('routes message to list all projects and tasks completely', async () => {
    const res = await routeMessage('Dame todos los proyectos y tareas que tengo', user);
    expect(res.confirmation).toBeDefined();
    expect(res.confirmation).toMatch(/Hermes Test|Lista de compras/i);
    expect(res.confirmation).toMatch(/[•▫️\-]/);
  }, 35000);
});
