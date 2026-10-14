import { describe,expect,it,vi } from 'vitest';
import type { DomainPersistenceQuery,TaskContainerRow } from '../../../src/infrastructure/database/domain-persistence-client.js';
import { createEntityMutationPersistence,type EntityMutationClient } from '../../../src/infrastructure/database/entity-mutation-persistence.js';
import type { JsonObject } from '@templelabs/contracts';
function fixture() {
  const source: TaskContainerRow = { id: 'source',user_id: 'owner',name: 'Original',category: 'project',metadata: {} };
  const target: TaskContainerRow = { id: 'target',user_id: 'owner',name: 'Destination',category: 'project',metadata: {} };
  const calls: { table: string; operation: string; filters: [string,unknown][] }[] = [];
  let failed = '', missing = '';
  const from = vi.fn((table: string): DomainPersistenceQuery<TaskContainerRow> => {
    const call = { table,operation: 'read',filters: [] as [string,unknown][] };calls.push(call);
    const result = async () => ({ data: `${table}.${call.operation}` === missing ? null : table === 'entities' && call.operation === 'read' ? [source,target]
      : table === 'entities' && call.operation === 'delete' ? [source] : [],error: `${table}.${call.operation}` === failed ? { message: 'Failed' } : null });
    const query: DomainPersistenceQuery<TaskContainerRow> = {
      select: () => query,eq: (key,value) => { call.filters.push([key,value]);return query; },in: () => query,order: () => query,limit: () => query,ilike: () => query,is: () => query,or: () => query,lte: () => query,
      insert: () => query,upsert: () => { call.operation = 'upsert';return query; },update: () => { call.operation = 'update';return query; },delete: () => { call.operation = 'delete';return query; },
      single: async () => ({ data: `${table}.${call.operation}` === missing ? null : target,error: `${table}.${call.operation}` === failed ? { message: 'Failed' } : null }),
      maybeSingle: async () => ({ data: target,error: null }),then: (resolve,reject) => result().then(resolve,reject),
    };return query;
  });
  const rpc = vi.fn(async (_name: 'rename_entity_cascade' | 'merge_entities',_args: JsonObject): Promise<{ data: JsonObject | null; error: { code?: string; message?: string } | null }> => ({ data: null,error: { code: 'PGRST202' } }));
  const client: EntityMutationClient = { from: from as EntityMutationClient['from'],rpc };
  const create = vi.fn(async () => target);
  const store = createEntityMutationPersistence(() => client,create);
  return { calls,source,target,rpc,create,store,client,fail: (value: string) => { failed = value; },missing: (value: string) => { missing = value; },
    merge: () => store.mergeEntities({ userId: 'owner',sourceName: 'Original',targetName: 'Destination' }),
    rename: () => store.renameEntity('owner','Original','Renamed','project') };
}
describe('typed entity mutation ownership and interrupted outcomes', () => {
  it.each(['throw','error','empty','malformed'] as const)('does not use compatibility writes after an uncertain rename RPC: %s', async kind => {
    const f = fixture(); if (kind === 'throw') f.rpc.mockRejectedValueOnce(new Error('Lost reply'));
    if (kind === 'error') f.rpc.mockResolvedValueOnce({ data: null,error: { code: '08006' } });
    if (kind === 'empty') f.rpc.mockResolvedValueOnce({ data: null,error: null });
    if (kind === 'malformed') f.rpc.mockResolvedValueOnce({ data: { success: true },error: null });
    expect(await f.rename()).toMatchObject({ success: false,complete: false,outcome: 'unknown',errorCode: 'ENTITY_MUTATION_RECONCILIATION_REQUIRED' });
    expect(f.rpc).toHaveBeenCalledOnce();expect(f.calls).toHaveLength(0);expect(f.create).not.toHaveBeenCalled();
  });
  it('imports one well-shaped atomic rename without executing another cascade', async () => {
    const f = fixture();f.rpc.mockResolvedValueOnce({ data: { success: true,entity_id: 'source',tasks_updated: 1,reminders_updated: 0,memories_updated: 2 },error: null });
    expect(await f.rename()).toMatchObject({ success: true,action: 'renamed_atomic_rpc',tasksUpdated: 1,memoriesUpdated: 2 });expect(f.calls).toHaveLength(0);
  });
  it.each(['throw','error','empty','foreign'] as const)('never repeats an uncertain or mismatched merge RPC: %s', async kind => {
    const f = fixture(); if (kind === 'throw') f.rpc.mockRejectedValueOnce(new Error('Lost reply'));
    if (kind === 'error') f.rpc.mockResolvedValueOnce({ data: null,error: { code: '57014' } });
    if (kind === 'empty') f.rpc.mockResolvedValueOnce({ data: null,error: null });
    if (kind === 'foreign') f.rpc.mockResolvedValueOnce({ data: { success: true,source_id: 'foreign',target_id: 'target',tasks_reassigned: 0,merged_metadata: {} },error: null });
    expect(await f.merge()).toMatchObject({ success: false,outcome: 'unknown' });expect(f.calls.every(call => call.operation === 'read')).toBe(true);expect(f.rpc).toHaveBeenCalledOnce();
  });
  it.each(['tasks.update','entities.update','entities.delete'])('stops after an observed %s failure instead of deleting/syncing further', async failed => {
    const f = fixture();f.fail(failed);expect(await f.merge()).toMatchObject({ success: false,outcome: 'unknown' });
    if (failed !== 'entities.delete') expect(f.calls.some(call => call.operation === 'delete')).toBe(false);
    expect(f.calls.some(call => call.table === 'projects')).toBe(false);
  });
  it.each(['tasks.update','entities.update','entities.delete'])('requires an actual receipt from %s before proceeding', async missing => {
    const f = fixture();f.missing(missing);expect(await f.merge()).toMatchObject({ success: false,outcome: 'unknown' });
    expect(f.calls.some(call => call.table === 'projects')).toBe(false);
  });
  it('allows the legacy merge only after an explicit missing-function response', async () => {
    const f = fixture();expect(await f.merge()).toMatchObject({ success: true,action: 'merged',tasksMovedCount: 0 });
    expect(f.calls.filter(call => !['read','upsert'].includes(call.operation)).every(call => call.filters.some(([key,value]) => key === 'user_id' && value === 'owner'))).toBe(true);
  });
  it('keeps the object and positional rename signatures compatible when the host has no RPC port', async () => {
    const f = fixture();delete f.client.rpc;expect(await f.rename()).toMatchObject({ success: true,action: 'renamed' });expect(f.rpc).not.toHaveBeenCalled();
  });
  it.each(['error','missing','partial'])('does not cascade after an unconfirmed entity deletion: %s',async kind => {
    const f = fixture(); if (kind === 'error') f.fail('entities.delete'); if (kind === 'missing') f.missing('entities.delete');
    expect(await f.store.deleteEntities({ userId: 'owner',entityIds: ['source','target'] })).toMatchObject({ success: false,outcome: 'unknown',errorCode: 'ENTITY_MUTATION_RECONCILIATION_REQUIRED' });
    expect(f.calls.some(call => call.table === 'projects')).toBe(false);
  });
  it('keeps deduplication from starting a second mutation after an unknown merge', async () => {
    const f = fixture();f.source.name = 'Area';f.target.name = 'Areas';f.rpc.mockRejectedValueOnce(new Error('Lost reply'));
    expect(await f.store.deduplicateEntities('owner','project')).toMatchObject({ complete: false,errorCode: 'ENTITY_MUTATION_RECONCILIATION_REQUIRED' });expect(f.rpc).toHaveBeenCalledOnce();
  });
});
