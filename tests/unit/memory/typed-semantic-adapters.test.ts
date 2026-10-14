import { describe,expect,it,vi } from 'vitest';
import { createEmbeddingService } from '../../../src/integrations/ai/embedding-service.js';
import { createOpenRouterEmbeddingProvider } from '../../../src/integrations/ai/openrouter-embedding-provider.js';
import { createDispatchPolicyCompiler } from '../../../src/features/reminders/dispatch-policy-compiler.js';
const vector=()=>Array.from({length:768},()=>0.1);
const preference={id:'preference',content:'Do not show buttons',created_at:'2026-01-01T00:00:00Z'};
const rule={position:1,scope:'global',requiresConfirmation:null,disableButtons:true,disableNudges:null,nudgeIntervalMinutes:null};
describe('typed semantic services with replaceable providers',()=>{
  it('coalesces only query calls for the same owner and returns defensive vectors',async()=>{
    const embed=vi.fn(async()=>[vector()]),service=createEmbeddingService({model:'alternative-model',embed});
    await service.withQueryEmbeddingScope('owner',async()=>{const [a,b]=await Promise.all([service.generateEmbedding('same',{queryOwner:'owner'}),service.generateEmbedding('same',{queryOwner:'owner'})]);a![0]=42;expect(b![0]).toBe(0.1);await service.generateEmbedding('same');await service.generateEmbedding('same',{queryOwner:'foreign'});});expect(embed).toHaveBeenCalledTimes(3);
  });
  it('isolates two configured providers even for the same text and owner',async()=>{
    const first=vi.fn(async()=>[vector()]),second=vi.fn(async()=>[vector()]);const a=createEmbeddingService({model:'first',embed:first}),b=createEmbeddingService({model:'second',embed:second});await a.withQueryEmbeddingScope('owner',async()=>{await a.generateEmbedding('text',{queryOwner:'owner'});await b.generateEmbedding('text',{queryOwner:'owner'});});expect(first).toHaveBeenCalledTimes(1);expect(second).toHaveBeenCalledTimes(1);
  });
  it('evicts a failed query promise so a subsequent read can recover',async()=>{
    const embed=vi.fn<() => Promise<number[][] | null>>().mockRejectedValueOnce(new Error('temporary')).mockResolvedValue([vector()]);const s=createEmbeddingService({model:'fake',embed});await s.withQueryEmbeddingScope('owner',async()=>{await expect(s.generateEmbedding('text',{queryOwner:'owner'})).rejects.toThrow('temporary');expect(await s.generateEmbedding('text',{queryOwner:'owner'})).toHaveLength(768);});expect(embed).toHaveBeenCalledTimes(2);
  });
  it('does not request an embedding for invalid batch input',async()=>{const embed=vi.fn(async()=>[vector()]),s=createEmbeddingService({model:'fake',embed});expect(await s.generateEmbeddings(['valid',null])).toBeNull();expect(embed).not.toHaveBeenCalled();});
  it.each([
    {data:[{index:0,embedding:Array.from({length:768},()=> 'bad')}]},
    {data:[{index:1,embedding:vector()}]},
    {data:[{embedding:vector()}]},
    {data:[{index:0,embedding:[0.1]}]},
  ])('rejects malformed provider vector data %#',async body=>{const provider=createOpenRouterEmbeddingProvider({getApiKey:()=> 'fixture',fetch:async()=>({ok:true,status:200,json:async()=>body,text:async()=>''})});expect(await provider.embed('text')).toBeNull();});
  it('rejects duplicate batch positions instead of assigning the wrong vector',async()=>{const provider=createOpenRouterEmbeddingProvider({getApiKey:()=> 'fixture',fetch:async()=>({ok:true,status:200,json:async()=>({data:[{index:0,embedding:vector()},{index:0,embedding:vector()}]}),text:async()=>''})});expect(await provider.embed(['first','second'])).toBeNull();});
  it('binds compiled rules and their cached explanation to a snapshot before await',async()=>{
    let finish:(reply:{content:string})=>void=()=>{};const complete=vi.fn(()=>new Promise<{content:string}>(resolve=>{finish=resolve;}));const compiler=createDispatchPolicyCompiler(()=>complete),preferences=[{...preference}];const pending=compiler.compileDispatchPolicy({userId:'owner',preferences});preferences[0]!.content='Unrelated changed preference';finish({content:JSON.stringify({rules:[rule]})});const policy=await pending;expect(policy.preferenceText).toBe('Do not show buttons');expect(policy.global.disableButtons).toBe(true);const cached=await compiler.compileDispatchPolicy({userId:'owner',preferences:[preference]});expect(cached.preferenceText).toBe('Do not show buttons');expect(complete).toHaveBeenCalledTimes(1);
  });
  it('keeps compiler instances isolated and protects cached policy from callers',async()=>{
    const complete=vi.fn(async()=>({content:JSON.stringify({rules:[rule]})}));const a=createDispatchPolicyCompiler(()=>complete),b=createDispatchPolicyCompiler(()=>complete);const p=await a.compileDispatchPolicy({userId:'owner',preferences:[preference]});p.global.disableButtons=false;expect((await a.compileDispatchPolicy({userId:'owner',preferences:[preference]})).global.disableButtons).toBe(true);await b.compileDispatchPolicy({userId:'owner',preferences:[preference]});expect(complete).toHaveBeenCalledTimes(2);
  });
  it.each(['{"rules":[null]}','{"rules":[],"extra":true}','{"rules":[{"position":99}]}','bad'])('rejects malformed semantic policies: %s',async content=>{const compiler=createDispatchPolicyCompiler(()=>async()=>({content}));await expect(compiler.compileDispatchPolicy({userId:'owner',preferences:[preference]})).rejects.toThrow('unavailable');});
});
