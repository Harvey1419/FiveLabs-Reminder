import { describe,expect,it,vi } from 'vitest';
import { createMemoryPersistence } from '../../../src/infrastructure/database/memory-persistence.js';
import type { MemoryQuery,MemoryRow,MemoryPersistenceClient,DispatchPolicy } from '../../../src/infrastructure/database/memory-persistence-client.js';
import type { DomainStorageError } from '../../../src/infrastructure/database/domain-persistence-client.js';
const row: MemoryRow = { id:'owned',user_id:'owner',content:'Lives in Bogota',topic_key:'profile/residence',category:'fact',is_active:true };
const policy: DispatchPolicy = { global:{ requiresConfirmation:false,disableButtons:false,disableNudges:false,nudgeIntervalMinutes:15 },recurring:{ requiresConfirmation:false,disableButtons:false,disableNudges:false,nudgeIntervalMinutes:15 },disableButtonsForRecurring:false,disableNudgesForRecurring:false,requiresConfirmation:false,nudgeIntervalMinutes:15 };
function fixture() {
  let rows: MemoryRow[] | null = [row],error: DomainStorageError | null = null;
  const q: MemoryQuery<MemoryRow> = {
    select:vi.fn(()=>q),insert:vi.fn(()=>q),upsert:vi.fn(()=>q),update:vi.fn(()=>q),delete:vi.fn(()=>q),eq:vi.fn(()=>q),neq:vi.fn(()=>q),not:vi.fn(()=>q),in:vi.fn(()=>q),or:vi.fn(()=>q),is:vi.fn(()=>q),ilike:vi.fn(()=>q),textSearch:vi.fn(()=>q),lte:vi.fn(()=>q),limit:vi.fn(()=>q),order:vi.fn(()=>q),
    single:async()=>({data:rows?.[0]??null,error}),maybeSingle:async()=>({data:rows?.[0]??null,error}),then:(resolve,reject)=>Promise.resolve({data:rows,error}).then(resolve,reject),
  };
  const client: MemoryPersistenceClient = { from:vi.fn(()=>q),rpc:vi.fn(async()=>({data:[{...row,content:'Forged RPC content',similarity:0.9}],error:null})) };
  const getClient=vi.fn(()=>client),generateEmbedding=vi.fn(async()=>[0.1]),compileDispatchPolicy=vi.fn(async()=>policy);
  const store=createMemoryPersistence(getClient,{ isConfigured:()=>true,generateEmbedding,compileDispatchPolicy,reduceDispatchRules:()=>policy });
  return {store,q,getClient,generateEmbedding,compileDispatchPolicy,set:(value:MemoryRow[]|null)=>{rows=value;},fail:()=>{error={message:'Unavailable'};} };
}
describe('typed memory persistence host boundary',()=>{
  it('constructs without touching the client or semantic services',()=>{const f=fixture();expect(f.getClient).not.toHaveBeenCalled();expect(f.generateEmbedding).not.toHaveBeenCalled();});
  it('hydrates authoritative content rather than displaying RPC content',async()=>{const f=fixture();const result=await f.store.searchMemories({userId:'owner',query:'residence',withStatus:true});expect(result.memories[0]?.content).toBe('Lives in Bogota');expect(f.q.eq).toHaveBeenCalledWith('user_id','owner');expect(f.q.in).toHaveBeenCalledWith('id',['owned']);});
  it('never returns foreign rows even if the backend violates its requested scope',async()=>{const f=fixture();f.set([{...row,user_id:'foreign'}]);expect(await f.store.getActiveMemories({userId:'owner'})).toEqual([]);});
  it('does not embed or write an exact persisted version twice',async()=>{const f=fixture();expect(await f.store.saveMemory({userId:'owner',topicKey:'profile/residence',content:'Lives in Bogota'})).toBe(row);expect(f.generateEmbedding).not.toHaveBeenCalled();expect(f.q.insert).not.toHaveBeenCalled();});
  it('keeps unavailable reads distinct from a successful empty result',async()=>{const f=fixture();f.fail();expect(await f.store.getActiveMemories({userId:'owner',withStatus:true})).toEqual({status:'unavailable',memories:[]});await expect(f.store.getActiveMemories({userId:'owner',throwOnError:true})).rejects.toThrow('unavailable');});
  it('unknown selected identities never start a delete',async()=>{const f=fixture();const result=await f.store.forgetMemories({userId:'owner',query:'forget residence',selectCandidates:async()=>['foreign']});expect(result.errorCode).toBe('MEMORY_SELECTION_UNAVAILABLE');expect(f.q.delete).not.toHaveBeenCalled();});
  it('a missing deletion receipt is unknown and never replayed',async()=>{const f=fixture();
    const result=await f.store.forgetMemories({userId:'owner',query:'forget residence',selectCandidates:async()=>{f.set(null);return ['owned'];}});expect(result.outcome).toBe('unknown');expect(f.q.delete).toHaveBeenCalledTimes(1);});
  it('policy read failures prevent reminder updates and policy compilation',async()=>{const f=fixture();f.fail();expect(await f.store.reconcileRemindersWithPolicy('owner')).toEqual({updatedCount:0,policy:null});expect(f.compileDispatchPolicy).not.toHaveBeenCalled();expect(f.q.update).not.toHaveBeenCalled();});
});
