import { describe,expect,it,vi } from 'vitest';
import { buildPersonalKnowledge,renderPersonalKnowledge } from '../../../src/agent/orchestration/personal-knowledge-core.js';
import { createMemoryForgettingSelector,type ForgettingCandidate } from '../../../src/agent/orchestration/memory-forgetting-selection.js';
const record={user_id:'owner',is_active:true,category:'fact',topic_key:'profile/name',content:'Me llamo Ana.'};
describe('typed memory consumption by orchestration',() => {
  it('renders only exact owner-scoped current-turn references',() => {
    const k=buildPersonalKnowledge('owner',[record]);const ref=k.refs.get(record)!;expect(renderPersonalKnowledge([ref],k.lookup,'owner','es')).toContain('Me llamo Ana.');expect(renderPersonalKnowledge([ref],k.lookup,'foreign','en')).not.toContain('Me llamo Ana.');
  });
  it('rejects truncated or altered nonces even when their first six characters match',() => {
    const k=buildPersonalKnowledge('owner',[record]);const ref=k.refs.get(record)!,nonce=ref.split('_')[1]!;
    for(const bad of [`pk_${nonce.slice(0,6)}_1`,`pk_${nonce.slice(0,6)}abcdef_1`]) {
      if(bad===ref)continue;expect(renderPersonalKnowledge([bad],k.lookup,'owner','es')).not.toContain('Me llamo Ana.');
    }
  });
  it('does not reuse a reference from another constructed turn',() => { const a=buildPersonalKnowledge('owner',[record]),b=buildPersonalKnowledge('owner',[record]);expect(renderPersonalKnowledge([a.refs.get(record)!],b.lookup,'owner','es')).not.toContain('Me llamo Ana.'); });
  it('excludes expired, inactive, foreign and superseded memory rows',() => {
    const k=buildPersonalKnowledge('owner',[{...record,valid_until:'2000-01-01T00:00:00Z'},{...record,is_active:false},{...record,user_id:'foreign'},{...record,superseded_by:'next'}]);expect(k.lookup.size).toBe(0);
  });
  it('deduplicates memory evidence and caps the supplied fact count',() => { const rows=Array.from({length:20},(_,i)=>({...record,topic_key:`profile/item_${i}`,content:`Fact ${i}`}));const k=buildPersonalKnowledge('owner',rows,rows);expect(k.lookup.size).toBe(16); });
  it('snapshots candidate identities across an asynchronous forgetting decision',async () => {
    let accept:(value:{content:string})=>void=()=>{};const complete=vi.fn(()=>new Promise<{content:string}>(resolve=>{accept=resolve;}));
    const candidates:ForgettingCandidate[]=[{id:'one',topic_key:'profile/name',content:'Ana'},{id:'two',topic_key:'profile/city',content:'Bogota'}];
    const select=createMemoryForgettingSelector(()=>complete);const pending=select({query:'Forget my name',candidates});candidates[0]={id:'foreign',topic_key:'profile/name',content:'Forged'};accept({content:'{"positions":[1]}'});expect(await pending).toEqual(['one']);
  });
  it.each(['null','{"positions":[0]}','{"positions":[1,1]}','{"positions":[1],"id":"foreign"}'])('rejects an unsupported deletion selection: %s',async content => {
    const select=createMemoryForgettingSelector(()=>vi.fn(async()=>({content})));expect(await select({query:'Forget my name',candidates:[{id:'one',topic_key:'profile/name',content:'Ana'}]})).toBeNull();
  });
  it('duplicate candidate identities never reach the model',async () => {
    const complete=vi.fn(async()=>({content:'{"positions":[1]}'})),select=createMemoryForgettingSelector(()=>complete);const item={id:'one',topic_key:'profile/name',content:'Ana'};
    expect(await select({query:'Forget my name',candidates:[item,item]})).toBeNull();expect(complete).not.toHaveBeenCalled();
  });
});
