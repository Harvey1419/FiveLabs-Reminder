import 'dotenv/config';
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { getOrCreateUserByPhone } from '../src/db/users.js';
import {
  createTask,
  getTasks,
  findOrCreateEntityFuzzy,
  supabase,
} from '../src/db/index.js';
import { routeMessage } from '../src/ai/router.js';
import { executeTool } from '../src/ai/tools.js';
import { executeTaskTool } from '../src/ai/tools/taskTools.js';
import { clearWorkingMemory, getWorkingMemory } from '../src/ai/workingMemory.js';

describe.sequential('Hermes Natural Language Intent & Container Resolution Test Suite', () => {
  const testPhone = '+573770009999';
  let user;

  beforeAll(async () => {
    user = await getOrCreateUserByPhone(testPhone, 'America/Bogota');
    await supabase.from('subscriptions').upsert({
      user_id: user.id,
      mp_preapproval_id: `test_preapproval_nlp_${Date.now()}`,
      plan: 'pro',
      status: 'authorized',
      amount: 49900,
    }, { onConflict: 'user_id' });
  }, 20000);

  async function safeRouteMessage(text, u, history = []) {
    let res = await routeMessage(text, u, history);
    if (res?.confirmation?.includes('intermitencia')) {
      console.log('[nlp-test-helper] Intermitencia detected, waiting 5s before single retry...');
      await new Promise(r => setTimeout(r, 5000));
      res = await routeMessage(text, u, history);
    }
    return res;
  }

  beforeEach(async () => {
    clearWorkingMemory(testPhone);
    clearWorkingMemory(user.id);
    await supabase.from('tasks').delete().eq('user_id', user.id);
    await supabase.from('reminders').delete().eq('user_id', user.id);
    await supabase.from('entities').delete().eq('user_id', user.id);
    await new Promise(r => setTimeout(r, 4000));
  });

  afterAll(async () => {
    if (user?.id) {
      await supabase.from('tasks').delete().eq('user_id', user.id);
      await supabase.from('reminders').delete().eq('user_id', user.id);
      await supabase.from('entities').delete().eq('user_id', user.id);
      await supabase.from('subscriptions').delete().eq('user_id', user.id);
    }
  }, 20000);

  it('CASE 1: Distinguishes container from items -> "Limpia la lista de compras" completes all items in the list', async () => {
    // Setup container "Lista de compras" with 3 items
    const entity = await findOrCreateEntityFuzzy({
      userId: user.id,
      name: 'Lista de compras',
      category: 'other',
    });

    const t1 = await createTask({ userId: user.id, title: 'Comprar leche', entityId: entity.id });
    const t2 = await createTask({ userId: user.id, title: 'Comprar arroz', entityId: entity.id });
    const t3 = await createTask({ userId: user.id, title: 'Comprar jabón', entityId: entity.id });

    expect(t1?.id).toBeDefined();
    expect(t2?.id).toBeDefined();
    expect(t3?.id).toBeDefined();

    // Verify 3 pending tasks in DB
    const pendingBefore = await getTasks({ userId: user.id, entityName: 'Lista de compras', status: 'pending' });
    expect(pendingBefore.length).toBe(3);

    // User says: "Limpia la lista de compras"
    const res = await safeRouteMessage('Limpia la lista de compras', user);

    expect(res.confirmation).toBeDefined();
    expect(res.confirmation).not.toContain('No se encontró');
    expect(res.confirmation).not.toContain('MISSING_TARGET_ID');

    // Verify DB: all 3 tasks in "Lista de compras" are now completed
    const pendingAfter = await getTasks({ userId: user.id, entityName: 'Lista de compras', status: 'pending' });
    expect(pendingAfter.length).toBe(0);

    const completed = await getTasks({ userId: user.id, entityName: 'Lista de compras', status: 'completed' });
    expect(completed.length).toBe(3);
  }, 60000);

  it('CASE 2: Multi-turn Contextual Anaphora -> T1: "Muéstrame mi lista de compras" -> T2: "Limpiala"', async () => {
    const entity = await findOrCreateEntityFuzzy({
      userId: user.id,
      name: 'Lista de compras',
      category: 'other',
    });

    await createTask({ userId: user.id, title: 'Comprar leche', entityId: entity.id });
    await createTask({ userId: user.id, title: 'Comprar manzanas', entityId: entity.id });

    // T1: Show list
    const resT1 = await safeRouteMessage('Muéstrame mi lista de compras', user);
    expect(resT1.confirmation).toContain('Comprar leche');
    expect(resT1.confirmation).toContain('Comprar manzanas');

    // Working memory should have active entity / items
    const wm = getWorkingMemory(user);
    expect(wm).not.toBeNull();
    expect(wm.items.length).toBe(2);

    // T2: "Limpiala"
    const history = [
      { role: 'user', content: 'Muéstrame mi lista de compras' },
      { role: 'assistant', content: resT1.confirmation },
    ];
    await new Promise(r => setTimeout(r, 4000));
    const resT2 = await safeRouteMessage('Limpiala', user, history);
    expect(resT2.confirmation).not.toContain('No se encontró');
    expect(resT2.confirmation).not.toContain('¿Cuál tarea deseas que complete?');

    // Verify DB
    const pending = await getTasks({ userId: user.id, entityName: 'Lista de compras', status: 'pending' });
    expect(pending.length).toBe(0);
  }, 60000);

  it('CASE 3: Generalization without memorized phrases -> "Ya compré todo de la lista de compras"', async () => {
    const entity = await findOrCreateEntityFuzzy({
      userId: user.id,
      name: 'Lista de compras',
      category: 'other',
    });

    await createTask({ userId: user.id, title: 'Comprar café', entityId: entity.id });
    await createTask({ userId: user.id, title: 'Comprar pan', entityId: entity.id });

    const res = await safeRouteMessage('Ya compré todo de la lista de compras', user);
    expect(res.confirmation).toBeDefined();
    expect(res.confirmation).not.toContain('No se encontró');

    const pending = await getTasks({ userId: user.id, entityName: 'Lista de compras', status: 'pending' });
    expect(pending.length).toBe(0);
  }, 60000);

  it('CASE 4: Backend Domain Tool direct execution: complete with target as entity name clears all tasks', async () => {
    const entity = await findOrCreateEntityFuzzy({
      userId: user.id,
      name: 'Lista de compras',
      category: 'other',
    });

    await createTask({ userId: user.id, title: 'Leche deslactosada', entityId: entity.id });
    await createTask({ userId: user.id, title: 'Huevos', entityId: entity.id });

    const toolRes = await executeTaskTool({
      action: 'complete',
      params: { target: 'Lista de compras', scope: 'all' },
      user,
    });

    expect(toolRes.success).toBe(true);
    expect(toolRes.data.completedCount).toBe(2);

    const pending = await getTasks({ userId: user.id, entityName: 'Lista de compras', status: 'pending' });
    expect(pending.length).toBe(0);
  });
});
