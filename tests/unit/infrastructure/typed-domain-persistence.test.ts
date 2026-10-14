import { describe, expect, it, vi } from 'vitest';
import type { DomainPersistenceClient, DomainPersistenceQuery, DomainStorageError, TaskRow, MessageRow } from '../../../src/infrastructure/database/domain-persistence-client.js';
import { createTaskPersistence } from '../../../src/infrastructure/database/task-persistence.js';
import { createMessagePersistence } from '../../../src/infrastructure/database/message-persistence.js';

function queryFixture<T extends TaskRow | MessageRow>() {
  const state: { rows: T[]; error: DomainStorageError | null } = { rows: [],error: null };
  const result = async () => ({ data: state.rows,error: state.error });
  const query: DomainPersistenceQuery<T> = { select: vi.fn(() => query),upsert: vi.fn(() => query),insert: vi.fn(() => query),update: vi.fn(() => query),delete: vi.fn(() => query),
    eq: vi.fn(() => query),ilike: vi.fn(() => query),is: vi.fn(() => query),in: vi.fn(() => query),or: vi.fn(() => query),lte: vi.fn(() => query),limit: vi.fn(() => query),order: vi.fn(() => query),
    single: vi.fn(async () => ({ data: state.rows[0] ?? null,error: state.error })),maybeSingle: vi.fn(async () => ({ data: state.rows[0] ?? null,error: state.error })),
    then: (resolve,reject) => result().then(resolve,reject) };
  const from = vi.fn<DomainPersistenceClient['from']>(); from.mockReturnValue(query);
  // Vitest erases the table/row generic correlation; the fixture controls every returned row.
  const getClient = vi.fn((): DomainPersistenceClient => ({ from: from as DomainPersistenceClient['from'] }));
  return { state,query,from,getClient };
}
function tasks() {
  const f = queryFixture<TaskRow>();
  const assertTurnLease = vi.fn(async () => {});
  const store = createTaskPersistence(f.getClient,{ assertTurnLease,isStrictUUID: value => /^[a-f0-9-]{36}$/.test(value),
    normalizeTextForMatching: value => value.toLowerCase(),selectEntityCandidate: () => ({ status: 'NOT_FOUND' }) });
  return { ...f,store,assertTurnLease };
}
describe('typed domain persistence boundaries', () => {
  it('keeps both shared clients lazy for index initialization', () => {
    const t = tasks(), m = queryFixture<MessageRow>(); createMessagePersistence(m.getClient);
    expect(t.getClient).not.toHaveBeenCalled(); expect(m.getClient).not.toHaveBeenCalled();
  });
  it('a named unresolved container never broadens to all tasks', async () => {
    const f = tasks(); expect(await f.store.getTasks({ userId: 'owner',entityName: 'unknown' })).toEqual([]);
    expect(f.from.mock.calls.map(([table]) => table)).toEqual(['entities','projects']);
    expect(f.query.insert).not.toHaveBeenCalled(); expect(f.query.update).not.toHaveBeenCalled();
  });
  it('preserves the user predicate, selected container and bounded task read', async () => {
    const f = tasks(); await f.store.getTasks({ userId: 'owner',entityId: 'container',limit: 1000 });
    expect(f.query.eq).toHaveBeenCalledWith('user_id','owner'); expect(f.query.limit).toHaveBeenCalledWith(100);
    expect(f.query.or).toHaveBeenCalledWith('entity_id.in.(container),project_id.in.(container)');
  });
  it('checks the current lease before an update even before attempting target lookup', async () => {
    const f = tasks(); f.assertTurnLease.mockRejectedValueOnce(new Error('Lease lost'));
    await expect(f.store.updateTask('short',{ title: 'Changed' },'owner')).rejects.toThrow('Lease lost');
    expect(f.from).not.toHaveBeenCalled();
  });
  it('keeps an explicit numeric due-date anchor when rescheduling linked reminders', async () => {
    const f = tasks(), id = '11111111-1111-4111-8111-111111111111', due = Date.parse('2026-10-13T21:00:00Z');
    f.state.rows = [{ id,title: 'Review' }];
    await f.store.updateTask(id,{ due_date: due },'owner');
    expect(f.query.update).toHaveBeenCalledWith({ send_at: '2026-10-13T21:00:00.000Z' });
    expect(f.query.eq).toHaveBeenCalledWith('task_id',id);
  });
  it('never executes a completion without an identified target or explicit scope', async () => {
    const f = tasks(); expect(await f.store.completeTasks({ userId: 'owner' })).toMatchObject({ completedCount: 0,error: { code: 'MISSING_TARGET_ID' } });
    expect(f.from).not.toHaveBeenCalled();
  });
  it('keeps every create in a batch unconfirmed when deduplication storage fails', async () => {
    const f = tasks(); f.state.error = { code: '57014',message: 'Read failed' };
    expect(await f.store.createTasksBatch({ userId: 'owner',items: [{ title: 'A' },{ title: 'B' }] })).toMatchObject({ data: null,error: { code: '57014' } });
    expect(f.query.insert).not.toHaveBeenCalled();
  });
  it('preserves bilingual task priorities and rejects an unsupported priority', () => {
    const f = tasks(); expect(f.store.normalizeTaskPriority('ALTA')).toBe('high');
    expect(f.store.normalizeTaskPriority('urgente')).toBe('urgent'); expect(f.store.normalizeTaskPriority('unknown')).toBeNull();
  });
  it('clamps history reads and preserves chronological order and content', async () => {
    const f = queryFixture<MessageRow>(); f.state.rows = [
      { id: 'new',role: 'assistant',content: 'Respuesta',created_at: '2026-10-12T12:00:00Z' },
      { id: 'old',message_id: 'old-msg',role: 'user',content: 'Pregunta',created_at: '2026-10-12T11:00:00Z' },
    ];
    const store = createMessagePersistence(f.getClient); const history = await store.getRecentMessages('phone',200);
    expect(history.map(row => row.content)).toEqual(['Pregunta','Respuesta']); expect(f.query.limit).toHaveBeenCalledWith(100);
    expect(f.query.eq).toHaveBeenCalledWith('phone_number','phone'); expect(history[0]).not.toHaveProperty('id');
    expect(f.state.rows[0]?.id).toBe('new');
    expect(history[0]?.messageId).toBe('old-msg'); expect(history[1]).not.toHaveProperty('messageId');
    expect(f.query.select).toHaveBeenCalledWith(expect.stringContaining('message_id'));
  });
  it('best-effort duplicate history cannot be mistaken for a durable inbound receipt', async () => {
    const f = queryFixture<MessageRow>(); f.state.error = { code: '23505',message: 'Duplicate' };
    const store = createMessagePersistence(f.getClient);
    expect(await store.saveMessage({ phoneNumber: 'phone',role: 'user',content: 'Hola',messageId: 'duplicate' })).toBeNull();
    expect(f.query.insert).toHaveBeenCalledOnce();
  });
  it('delivery correlation still propagates storage failure and selects no private content', async () => {
    const f = queryFixture<MessageRow>(); f.state.error = { message: 'Unavailable' };
    await expect(createMessagePersistence(f.getClient).getAssistantMessageById('message')).rejects.toEqual(f.state.error);
    expect(f.query.select).toHaveBeenCalledWith('id'); expect(f.query.eq).toHaveBeenCalledWith('role','assistant');
  });
});
