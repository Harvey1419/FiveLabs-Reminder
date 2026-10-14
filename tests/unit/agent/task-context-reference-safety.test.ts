import type { WorkingMemoryInputItem } from '../../../src/agent/core/working-memory-cache.js';
import type { ExecutionIntent, ExecutionToolCall } from '../../../src/agent/orchestration/turn-intent-executor.js';
type RowFixture = { id: string; [field: string]: unknown };
import { afterEach, describe, expect, it, vi } from 'vitest';

// All persistence and provider boundaries are offline; identity resolution stays real.
vi.mock('../../../src/agent/core/agent-run.js', () => ({
  cancelSupersededInputRun: vi.fn().mockResolvedValue(null),
  createInputRun: vi.fn().mockResolvedValue({ id: 'offline-input' }),
  createApprovalRun: vi.fn().mockResolvedValue({ id: 'offline-approval' }),
}));
vi.mock('../../../src/agent/tools/index.js', () => ({ executeTool: vi.fn() }));
vi.mock('../../../src/agent/providers/client.js', () => ({ callChatCompletion: vi.fn() }));
const db = vi.hoisted(() => ({ rows: [] as RowFixture[], filters: [] as Array<[string, unknown]> }));
vi.mock('../../../src/infrastructure/database/index.js', () => ({
  supabase: { from: () => {
    const filters: Array<[string, unknown]> = [];
    const result = () => ({ data: db.rows.find(row => filters.every(([key, value]) => row[key] === value)) || null, error: null });
    const query = {
      select: () => query,
      eq: (key: string, value: unknown) => { filters.push([key, value]); db.filters.push([key, value]); return query; },
      maybeSingle: async () => result(),
    };
    return query;
  } },
}));
import { normalizeTurnIntentForRuntime } from '../../../src/agent/orchestration/intent-normalizer.js';
import { executeTurnIntent } from '../../../src/agent/orchestration/intent-executor.js';
import { resolveTaskTarget } from '../../../src/agent/tools/task-reference.js';
import { callChatCompletion } from '../../../src/agent/providers/client.js';
import { saveWorkingMemory, clearWorkingMemory } from '../../../src/agent/core/working-memory-store.js';

const user = { id: 'reference-safety-owner' };
const alfa = '11111111-1111-4111-8111-111111111111';
const beta = '22222222-2222-4222-8222-222222222222';
const ref = { source: 'working_memory', position: 1 };
function card(items: WorkingMemoryInputItem[] = [{ id: alfa, title: 'Alfa', status: 'pending' }], entityType = 'task') {
  saveWorkingMemory(user, { source: entityType, entityType, items });
}
function normalize(actions: Record<string, unknown>[]) { return normalizeTurnIntentForRuntime({ actions }, { user, language: 'en' }); }
async function execute(actions: Record<string, unknown>[], tool = vi.fn()) {
  const intent = normalize(actions);
  return { result: await executeTurnIntent(intent as ExecutionIntent, { user, language: 'en', executeTool: tool }), tool, intent };
}
afterEach(() => { clearWorkingMemory(user); db.rows = []; db.filters = []; });

describe('typed reference sole operative identity', () => {
  it.each(['complete', 'delete', 'update'])('binds current Alfa despite redundant Beta label for task.%s', async action => {
    card([{ id: beta, title: 'Beta' }]);
    card();
    const tool = vi.fn().mockResolvedValue({ success: true, data: { id: alfa } });
    await execute([{ domain: 'task', action, target: 'Beta', contextRef: ref, newName: 'Beta' }], tool);
    expect(tool).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ params: expect.objectContaining({ target: alfa }) }));
    expect(callChatCompletion).not.toHaveBeenCalled();
  });

  it.each([undefined, null, '', 'Alfa', '  ALFA  ', alfa, '1', 'la primera'])('binds compatible target %s to the current identity', target => {
    card();
    expect(normalize([{ domain: 'task', action: 'update', target, contextRef: ref, newName: 'Beta' }]).actions[0])
      .toMatchObject({ target: alfa, title: 'Beta' });
    expect(normalize([{ domain: 'task', action: 'complete', target, contextRef: ref }]).actions[0]!._referenceError).toBeUndefined();
  });

  it.each(['complete', 'delete', 'update'])('passes only selected UUID for partial and numeric labels in task.%s', async action => {
    for (const [target, title, position] of [['Borona', 'Llevar a Borona al veterinario', 1], ['1', '1', 2], ['3', '2', 2]] as const) {
      card([{ id: alfa, title: position === 1 ? title : 'First task' }, { id: beta, title }]);
      const selected = position === 1 ? alfa : beta;
      const tool = vi.fn().mockResolvedValue({ success: true, data: { id: selected } });
      await execute([{ domain: 'task', action, target, contextRef: { ...ref, position }, newName: 'Changed title' }], tool);
      expect(tool).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ params: expect.objectContaining({ target: selected }) }));
      expect(callChatCompletion).not.toHaveBeenCalled();
    }
  });

  it.each([['reminder', 'cancel', 'reminder'], ['calendar', 'delete', 'calendar_event']])('binds %s references without interpreting Borona labels', async (domain, action, entityType) => {
    card([{ id: alfa, title: 'Llevar a Borona al veterinario' }], entityType);
    const tool = vi.fn().mockResolvedValue({ success: true, data: { id: alfa } });
    await execute([{ domain, action, target: 'Borona', contextRef: ref }], tool);
    expect(tool).toHaveBeenCalledOnce();
    expect(JSON.stringify(tool.mock.calls[0]![0].params)).toContain(alfa);
    expect(JSON.stringify(tool.mock.calls[0]![0].params)).not.toContain('Borona');
  });

  it('uses displayed order and latest filtered replacement, not historical insertion order', () => {
    card([{ id: beta, title: 'Beta' }, { id: alfa, title: 'Alfa' }]);
    expect(normalize([{ domain: 'task', action: 'delete', contextRef: ref }]).actions[0]!.target).toBe(beta);
    card();
    expect(normalize([{ domain: 'task', action: 'delete', contextRef: ref }]).actions[0]!.target).toBe(alfa);
  });

  it.each(['missing', 'range', 'type', 'deleted', 'source', 'missing-id', 'malformed'])('rejects %s typed references without a mutation', async kind => {
    if (kind !== 'missing') card([{ ...(kind === 'missing-id' ? {} : { id: alfa }), title: 'Alfa', status: kind === 'deleted' ? 'deleted' : 'pending' }], kind === 'type' ? 'reminder' : 'task');
    const contextRef = kind === 'malformed' ? {} : { ...ref, ...(kind === 'range' ? { position: 2 } : {}), ...(kind === 'source' ? { source: 'history' } : {}) };
    const { result, tool } = await execute([{ domain: 'task', action: 'delete', target: 'Alfa', contextRef }]);
    expect(tool).not.toHaveBeenCalled();
    expect(result.records[0]!.result.requiresClarification).toBe(true);
  });

  it('fails closed without a user instead of crashing or falling back to a label', () => {
    const normalized = normalizeTurnIntentForRuntime({ actions: [{ domain: 'task', action: 'delete', target: 'Alfa', contextRef: ref }] }, {});
    expect(normalized.actions[0]!._referenceError).toBe(true);
  });

  it('does not block a named target outside the current card without contextRef', async () => {
    card();
    const tool = vi.fn().mockResolvedValue({ success: true, action: 'deleted_task', data: { id: beta } });
    await execute([{ domain: 'task', action: 'delete', target: 'Beta' }], tool);
    expect(tool).toHaveBeenCalledWith(expect.objectContaining({ params: expect.objectContaining({ target: 'Beta' }) }));
  });

  it('freezes sibling reference identities before a tool replaces working memory', async () => {
    card([{ id: beta, title: 'Beta' }, { id: alfa, title: 'Alfa' }]);
    const tool = vi.fn(async ({ params }: ExecutionToolCall) => {
      card([{ id: 'replacement', title: 'Replacement' }]);
      return { success: true, action: 'completed_task', data: { id: params.target } };
    });
    await execute([
      { domain: 'task', action: 'complete', contextRef: ref },
      { domain: 'task', action: 'delete', contextRef: { ...ref, position: 2 } },
    ], tool);
    expect(tool.mock.calls.map(([call]) => call.params.target)).toEqual([beta, alfa]);
  });

  it('accepts an exact duplicate public title but preserves explicit container scope checks', async () => {
    card([{ id: alfa, title: 'Same title', entity_id: 'container-a' }, { id: beta, title: 'Same title', entity_id: 'container-b' }]);
    const action = normalize([{ domain: 'task', action: 'delete', target: 'Same title', entityName: 'Wrong container', contextRef: ref }]).actions[0]!;
    expect(action).toMatchObject({ target: alfa, entityName: 'Wrong container' });
    db.rows = [{ id: alfa, title: 'Same title', user_id: user.id, status: 'pending', entity_id: 'container-a' }];
    expect((await resolveTaskTarget({ target: action.target, entityId: 'container-b', userId: user.id, operation: 'delete' })).status).toBe('NOT_FOUND');
    expect(db.filters).toContainEqual(['entity_id', 'container-b']);
  });

  it.each(['complete', 'update', 'delete'])('reuses owned DB identity/status revalidation after binding for %s', async operation => {
    card();
    const target = normalize([{ domain: 'task', action: operation, contextRef: ref }]).actions[0]!.target;
    db.rows = [{ id: alfa, title: 'Alfa', user_id: user.id, status: 'pending' }];
    expect((await resolveTaskTarget({ target, userId: user.id, operation })).status).toBe('RESOLVED');
    expect(db.filters).toContainEqual(['id', alfa]);
    db.rows[0]!.user_id = 'another-owner';
    expect((await resolveTaskTarget({ target, userId: user.id, operation })).status).toBe('NOT_FOUND');
    db.rows[0]!.user_id = user.id;
    db.rows[0]!.status = 'deleted';
    expect((await resolveTaskTarget({ target, userId: user.id, operation })).status).toBe('NOT_FOUND');
  });
});
