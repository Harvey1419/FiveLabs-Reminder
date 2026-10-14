import { describe, expect, it, vi } from 'vitest';
import { createRouterContextReads, type RouterContextMemory } from '../../../src/agent/orchestration/router-context-reads.js';
import type { RouterProfileUser } from '../../../src/agent/orchestration/router-profile-context.js';
interface Memory extends RouterContextMemory { content: string; owned?: boolean }
const row:Memory={content:'Recorded fact',category:'fact',topic_key:'profile/home',owned:true};
function harness(){
 const methods:Record<string,unknown>={};const events:string[]=[];
 const relevant=vi.fn(async(_query:unknown):Promise<Memory[]>=>{events.push('relevant');return [];});const preferences=vi.fn(async(_query:unknown):Promise<Memory[]>=>{events.push('preferences');return [];});
 const anchors=vi.fn(async(_query:unknown):Promise<Memory[]>=>{events.push('anchors');return [];});methods.getProactiveAnchors=anchors;
 const overview=vi.fn(async(_query:unknown)=>{events.push('overview');return {pendingConfirmationReminders:[]};});const subscription=vi.fn(async(_id:string):Promise<{status:string}|null>=>{events.push('subscription');return {status:'active'};});const integration=vi.fn(async(_id:string,_provider:string)=>{events.push('integration');return {provider:'google'};});
 const pro=vi.fn((sub:unknown)=>Boolean(sub));const warn=vi.fn();const knowledge=vi.fn((_id:string|undefined,memories:Memory[],preferences:Memory[])=>({refs:new Map([...memories,...preferences].filter(m=>m.owned).map((m,i)=>[m,`pk_${i+1}`])),lookup:new Map()}));
 const api=createRouterContextReads({getMemoryServiceMethod:name=>methods[name],retrieveRelevantMemories:relevant,retrieveStandingPreferences:preferences,getDailyOverview:overview,getUserSubscription:subscription,getUserIntegration:integration,hasProAccess:pro,buildPersonalKnowledge:knowledge,now:()=>100,logger:{warn}});
 const user:RouterProfileUser={id:'user',phone_number:'phone',timezone:'UTC'};
 return {...api,methods,events,relevant,preferences,anchors,overview,subscription,integration,pro,warn,knowledge,user,load:(identity=user)=>api.loadRouterContext({user:identity,currentUserText:'Question',phoneNumber:'phone',timezone:'UTC'})};
}
describe('typed parallel router context reads',()=>{
 it('starts all six reads before waiting for a pending memory response',async()=>{
  const h=harness();let release!:(rows:Memory[])=>void;h.relevant.mockImplementationOnce(async()=>{h.events.push('relevant');return new Promise<Memory[]>(resolve=>{release=resolve;});});
  const pending=h.load();expect(h.events).toEqual(['relevant','preferences','anchors','overview','subscription','integration']);release([row]);expect((await pending).relevantMemories).toEqual([row]);
 });
 it('uses detailed retrieval methods and preserves exact scope limits without legacy calls',async()=>{
  const h=harness();const relevant=vi.fn(async()=>({status:'available',memories:[row]}));const preference=vi.fn(async()=>({status:'available',memories:[]}));h.methods.retrieveRelevantMemoriesResult=relevant;h.methods.retrieveStandingPreferencesResult=preference;
  expect((await h.load()).memoryRetrievalStatus).toBe('available');expect(relevant).toHaveBeenCalledWith({userId:'user',queryText:'Question',limit:3});expect(preference).toHaveBeenCalledWith({userId:'user',limit:5});expect(h.relevant).not.toHaveBeenCalled();expect(h.preferences).not.toHaveBeenCalled();expect(h.anchors).toHaveBeenCalledWith({userId:'user',maxEntities:2,maxRecentEpisodes:2});
 });
 it('distinguishes complete unavailability, partial retrieval and available empty results',async()=>{
  for(const [a,b,status] of [['unavailable','unavailable','unavailable'],['unavailable','available','partial'],['available','available','available'],['unknown','available','partial']]){const h=harness();h.methods.retrieveRelevantMemoriesResult=async()=>({status:a,memories:[]});h.methods.retrieveStandingPreferencesResult=async()=>({status:b,memories:[]});expect((await h.load()).memoryRetrievalStatus).toBe(status);}
 });
 it('discards stale Pro entitlement after subscription failure without consulting stale access',async()=>{
  const h=harness();h.user.subscription={status:'active'};h.user.isPro=true;h.subscription.mockRejectedValue(new Error('offline'));const result=await h.load();expect(result).toMatchObject({entitlementKnown:false,isPro:false});expect(h.user).not.toHaveProperty('subscription');expect(h.user.isPro).toBe(false);expect(h.pro).not.toHaveBeenCalled();expect(h.warn).toHaveBeenCalledTimes(1);
 });
 it('keeps known free/null subscription distinct from lookup failure and updates shared context',async()=>{
  const h=harness();h.subscription.mockResolvedValue(null);const result=await h.load();expect(result).toMatchObject({entitlementKnown:true,isPro:false,subscription:null});expect(h.user.subscription).toBeNull();expect(h.pro).toHaveBeenCalledWith(null,h.user);
 });
 it('uses at most three proactive anchors only when relevant matches are empty',async()=>{
  const h=harness();const anchors=Array.from({length:5},(_,i)=>({...row,content:`Anchor ${i}`}));h.anchors.mockResolvedValue(anchors);const result=await h.load();expect(result.effectiveMemories).toEqual(anchors.slice(0,3));expect(h.user.memories).toBe(result.effectiveMemories);
  const nonempty=harness();nonempty.relevant.mockResolvedValue([row]);nonempty.anchors.mockResolvedValue(anchors);expect((await nonempty.load()).effectiveMemories).toEqual([row]);
 });
 it('renders reference hints only for records in the supplied knowledge map and retains array identity',async()=>{
  const h=harness();const unowned={content:'Unreferenced',category:'fact'};h.relevant.mockResolvedValue([row,unowned]);const preference={...row,content:'Preference',contextCategory:'custom'};h.preferences.mockResolvedValue([preference]);const result=await h.load();expect(result.memoryHints).toContain('[pk_1] [topicKey=profile/home]');expect(result.memoryHints).toContain('- [fact] Unreferenced');expect(result.preferenceHints).toContain('- [custom]');expect(h.user.preferences).toBe(result.standingPreferences);expect(h.knowledge).toHaveBeenCalledWith('user',result.effectiveMemories,result.standingPreferences);
 });
 it('skips identity-only lookups for anonymous users while preserving relevant/overview calls and read failures',async()=>{
  const h=harness();const result=await h.load({phone_number:'phone'});expect(h.relevant).toHaveBeenCalledWith({userId:undefined,queryText:'Question',limit:3});expect(h.overview).toHaveBeenCalled();expect(h.preferences).not.toHaveBeenCalled();expect(h.anchors).not.toHaveBeenCalled();expect(h.subscription).not.toHaveBeenCalled();expect(h.integration).not.toHaveBeenCalled();expect(result.entitlementKnown).toBe(true);
  const failed=harness();failed.overview.mockRejectedValue(new Error('agenda unavailable'));await expect(failed.load()).rejects.toThrow('agenda unavailable');
 });
});
