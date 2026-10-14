import { describe,expect,it,vi } from 'vitest';
import type { DomainPersistenceClient,DomainPersistenceQuery,TaskContainerRow } from '../../../src/infrastructure/database/domain-persistence-client.js';
import { createProjectPersistence } from '../../../src/infrastructure/database/project-persistence.js';
import { createEntityPersistence } from '../../../src/infrastructure/database/entity-persistence.js';
import { mergeMetadata,selectEntityCandidate,inspectEntityReferenceSnapshot,partitionLinkedTasksForEntityDeletion } from '../../../src/infrastructure/database/entity-resolution.js';
import type { JsonObject } from '@templelabs/contracts';

function fixture() {
  const calls: { table: string; operation: string; filters: [string,unknown][]; payload: unknown }[] = [];
  let readError = false;
  const original: TaskContainerRow = { id: 'project',user_id: 'owner',name: 'Area',category: 'project',metadata: { client: { timezone: 'UTC',contact: 'Ana' },keep: 'Existing' } };
  const from = vi.fn((table: string): DomainPersistenceQuery<TaskContainerRow> => {
    const call = { table,operation: 'read',filters: [] as [string,unknown][],payload: null as unknown }; calls.push(call);
    let changed: TaskContainerRow = original;
    const rows = async () => ({ data: table === 'entities' || table === 'projects' ? [changed] : [],error: readError ? { message: 'Unavailable' } : null });
    const query: DomainPersistenceQuery<TaskContainerRow> = {
      select: () => query,eq: (key,value) => { call.filters.push([key,value]);return query; },in: (key,value) => { call.filters.push([key,value]);return query; },
      order: () => query,limit: () => query,ilike: () => query,is: () => query,or: () => query,lte: () => query,
      insert: payload => { call.operation = 'insert';call.payload = payload;return query; },
      update: payload => { call.operation = 'update';call.payload = payload;
        if (payload && typeof payload === 'object') changed = { ...original,...payload }; return query; },
      upsert: payload => { call.operation = 'upsert';call.payload = payload;return query; },delete: () => query,
      single: async () => ({ data: changed,error: null }),maybeSingle: async () => ({ data: changed,error: null }),then: (resolve,reject) => rows().then(resolve,reject),
    };return query;
  });
  // The test controls per-table projections; Vitest cannot retain the SDK table/row generic correlation.
  const getClient = vi.fn((): DomainPersistenceClient => ({ from: from as DomainPersistenceClient['from'] }));
  return { calls,original,getClient,projects: createProjectPersistence(getClient),entities: createEntityPersistence(getClient),failRead: () => { readError = true; } };
}
describe('typed entity/project boundaries', () => {
  it('defers the shared SDK client through both constructors', () => {
    const f = fixture();expect(f.getClient).not.toHaveBeenCalled();
  });
  it('fixes existing project metadata updates while retaining nested previous values', async () => {
    const f = fixture(); const value = await f.projects.findOrCreateProjectFuzzy({ userId: 'owner',name: 'Area',metadata: { client: { timezone: 'America/Bogota' },keep: '' } });
    expect(value?.id).toBe('project');expect(value?.metadata).toEqual({ client: { timezone: 'America/Bogota',contact: 'Ana' },keep: 'Existing' });
    const update = f.calls.find(call => call.operation === 'update');expect(update?.filters).toEqual([['id','project'],['user_id','owner']]);
    expect(f.calls.some(call => call.operation === 'insert')).toBe(false);
    expect(f.calls.find(call => call.operation === 'upsert')?.payload).toMatchObject({ id: 'project',user_id: 'owner',category: 'project' });
  });
  it('binds project rename and its mirror to the same owner', async () => {
    const f = fixture();expect(await f.projects.renameProject({ userId: 'owner',oldName: 'Area',newName: 'Renamed' })).toMatchObject({ success: true });
    const updates = f.calls.filter(call => call.operation === 'update');expect(updates).toHaveLength(2);
    expect(updates.every(call => call.filters.some(([key,value]) => key === 'user_id' && value === 'owner'))).toBe(true);
  });
  it('an unavailable owned entity preflight never becomes an empty successful snapshot', async () => {
    const f = fixture();f.failRead();expect(await f.entities.inspectOwnedEntityReferences({ userId: 'owner',references: [{ name: 'Area' }] })).toMatchObject({ success: false,errorCode: 'DATABASE_ERROR',resolutions: [] });
    expect(f.calls.every(call => call.operation === 'read')).toBe(true);
  });
  it('resolves structured references using only the owner-scoped read', async () => {
    const f = fixture();const value = await f.entities.inspectOwnedEntityReferences({ userId: 'owner',references: [{ name: 'Area',category: 'project' }] });
    expect(value.resolutions[0]).toMatchObject({ status: 'RESOLVED',entity: { id: 'project' } });
    expect(f.calls).toHaveLength(1);expect(f.calls[0]?.filters).toEqual([['user_id','owner']]);
  });
  it('keeps project/entity normalization and ranking independent of row order', () => {
    const rows = [{ id: 'one',name: 'Área',category: 'project' },{ id: 'two',name: 'Else',category: 'project' }];
    expect(selectEntityCandidate(rows,'el proyecto area')).toMatchObject({ status: 'RESOLVED',entity: { id: 'one' } });
    expect(selectEntityCandidate([...rows].reverse(),'el proyecto area')).toMatchObject({ status: 'RESOLVED',entity: { id: 'one' } });
  });
  it('never selects the first of duplicate canonical entity names', () => {
    expect(inspectEntityReferenceSnapshot([{ id: 'one',name: 'Area' },{ id: 'two',name: 'Área' }],[{ name: 'Area' }])[0]?.status).toBe('AMBIGUOUS');
  });
  it('keeps non-empty metadata, JSON arrays and nested values without mutating the old object', () => {
    const original: JsonObject = { notes: 'Keep',client: { name: 'Ana',active: true },tags: ['one'] };
    expect(mergeMetadata(original,{ notes: null,client: { name: '',active: false },tags: ['two'] })).toEqual({ notes: 'Keep',client: { name: 'Ana',active: false },tags: ['two'] });
    expect(original).toEqual({ notes: 'Keep',client: { name: 'Ana',active: true },tags: ['one'] });
  });
  it('keeps completed task history out of the destructive dependent set', () => {
    expect(partitionLinkedTasksForEntityDeletion([{ id: 'one',status: 'pending' },{ id: 'two',status: 'completed' },{ id: 'three',status: 'in_progress' }])).toEqual({ unfinishedTaskIds: ['one','three'],preservedCompletedTaskCount: 1 });
  });
});
