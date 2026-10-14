import 'dotenv/config';
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { getOrCreateUserByPhone } from '../../../src/infrastructure/database/users.js';
import {
  createTask,
  getTasks,
  findOrCreateEntityFuzzy,
  supabase,
} from '../../../src/infrastructure/database/index.js';
import { routeMessage } from '../../../src/agent/orchestration/router.js';
import type { executeTool } from '../../../src/agent/tools/index.js';
import { executeTaskComplete } from '../../../src/agent/tools/task-complete.js';
import { clearWorkingMemory, getWorkingMemory } from '../../../src/agent/core/working-memory.js';

type FixtureQuery = PromiseLike<{ data: unknown; error: unknown }> & {
  eq(column: string, value: unknown): FixtureQuery;
};
type FixtureClient = {
  from(table: 'tasks' | 'reminders' | 'entities' | 'subscriptions'): {
    delete(): FixtureQuery;
    upsert(row: Record<string, unknown>, options: { onConflict: string }): FixtureQuery;
  };
};
type FixtureUser = NonNullable<Parameters<typeof executeTool>[2]> & { id: string };
type CompletionParams = NonNullable<NonNullable<Parameters<typeof executeTaskComplete>[0]>['params']>;
type RouteConfirmation = { confirmation?: string };

describe.sequential('Hermes Natural Language Intent & Container Resolution Test Suite', () => {
  const testPhone = '+573770009999';
  let user: FixtureUser;

  beforeAll(async () => {
    user = await getOrCreateUserByPhone(testPhone, 'America/Bogota') as unknown as FixtureUser;
    await (supabase as unknown as FixtureClient).from('subscriptions').upsert({
      user_id: user.id,
      mp_preapproval_id: `test_preapproval_nlp_${Date.now()}`,
      plan: 'pro',
      status: 'authorized',
      amount: 49900,
    }, { onConflict: 'user_id' });
  }, 20000);

  async function safeRouteMessage(text: string, u: FixtureUser, history: Parameters<typeof routeMessage>[2] = []) {
    let res = await routeMessage(text, u, history) as RouteConfirmation;
    if (res?.confirmation?.includes('intermitencia')) {
      console.log('[nlp-test-helper] Intermitencia detected, waiting 5s before single retry...');
      await new Promise(r => setTimeout(r, 5000));
      res = await routeMessage(text, u, history) as RouteConfirmation;
    }
    return res;
  }

  beforeEach(async () => {
    clearWorkingMemory(testPhone);
    clearWorkingMemory(user.id);
    await (supabase as unknown as FixtureClient).from('tasks').delete().eq('user_id', user.id);
    await (supabase as unknown as FixtureClient).from('reminders').delete().eq('user_id', user.id);
    await (supabase as unknown as FixtureClient).from('entities').delete().eq('user_id', user.id);
    await new Promise(r => setTimeout(r, 4000));
  });

  afterAll(async () => {
    if (user?.id) {
      await (supabase as unknown as FixtureClient).from('tasks').delete().eq('user_id', user.id);
      await (supabase as unknown as FixtureClient).from('reminders').delete().eq('user_id', user.id);
      await (supabase as unknown as FixtureClient).from('entities').delete().eq('user_id', user.id);
      await (supabase as unknown as FixtureClient).from('subscriptions').delete().eq('user_id', user.id);
    }
  }, 20000);

  it('CASE 1: Distinguishes container from items -> "Limpia la lista de compras" completes all items in the list', async () => {
    // Setup container "Lista de compras" with 3 items
    const entity = await findOrCreateEntityFuzzy({
      userId: user.id,
      name: 'Lista de compras',
      category: 'other',
    });

    const t1 = await createTask({ userId: user.id, title: 'Comprar leche', entityId: entity!.id });
    const t2 = await createTask({ userId: user.id, title: 'Comprar arroz', entityId: entity!.id });
    const t3 = await createTask({ userId: user.id, title: 'Comprar jabón', entityId: entity!.id });

    expect((t1 as { id?: unknown } | null)?.id).toBeDefined();
    expect((t2 as { id?: unknown } | null)?.id).toBeDefined();
    expect((t3 as { id?: unknown } | null)?.id).toBeDefined();

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

    await createTask({ userId: user.id, title: 'Comprar leche', entityId: entity!.id });
    await createTask({ userId: user.id, title: 'Comprar manzanas', entityId: entity!.id });

    // T1: Show list
    const resT1 = await safeRouteMessage('Muéstrame mi lista de compras', user);
    expect(resT1.confirmation).toContain('Comprar leche');
    expect(resT1.confirmation).toContain('Comprar manzanas');

    // Working memory should have active entity / items
    const wm = getWorkingMemory(user);
    expect(wm).not.toBeNull();
    expect(wm!.items.length).toBe(2);

    // T2: "Limpiala"
    const history: Parameters<typeof routeMessage>[2] = [
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

    await createTask({ userId: user.id, title: 'Comprar café', entityId: entity!.id });
    await createTask({ userId: user.id, title: 'Comprar pan', entityId: entity!.id });

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

    await createTask({ userId: user.id, title: 'Leche deslactosada', entityId: entity!.id });
    await createTask({ userId: user.id, title: 'Huevos', entityId: entity!.id });

    const toolRes = await executeTaskComplete({
      params: { target: 'Lista de compras', scope: 'all' } as CompletionParams,
      user,
    });

    expect(toolRes.success).toBe(true);
    expect((toolRes.data as { completedCount: unknown }).completedCount).toBe(2);

    const pending = await getTasks({ userId: user.id, entityName: 'Lista de compras', status: 'pending' });
    expect(pending.length).toBe(0);
  });
});
