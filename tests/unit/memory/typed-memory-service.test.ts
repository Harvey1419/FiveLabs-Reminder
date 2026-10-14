import { describe,expect,it,vi } from 'vitest';
import { createMemoryService,type MemoryServiceDependencies } from '../../../src/features/memory/memory-service.js';
import { createMemoryAdmission } from '../../../src/features/memory/memory-admission.js';
const candidate={topicKey:'profile/residence',category:'fact',content:'Lives in Cali',evidence:'Vivo en Cali.'};
function fixture() {
  const completion=vi.fn(async()=>({content:'{"positions":[1]}'}));
  const admission=createMemoryAdmission(()=>completion);
  const dependencies:MemoryServiceDependencies={validLearningCandidates:Array.isArray,entityWriteCategories:['person','company','project','asset','place','other'],validateMemoryCandidates:vi.fn((options: Parameters<MemoryServiceDependencies['validateMemoryCandidates']>[0]) => admission.validateMemoryCandidates(options)),callMemoryExtraction:vi.fn(async()=>JSON.stringify([candidate])),saveMemory:vi.fn(async options=>({id:'saved',content:options.content,topic_key:options.topicKey,user_id:options.userId,is_active:true})),searchMemories:vi.fn(async()=>[]),getActiveMemories:vi.fn(async()=>[]),getStandingMemories:vi.fn(async()=>({data:[],error:null})),findOrCreateEntityFuzzy:vi.fn(async()=>null)};
  return {dependencies,completion,...createMemoryService(dependencies)};
}
describe('typed memory service semantic/storage boundary',()=>{
  it('processed turns do not repeat an extraction or write',async()=>{const f=fixture();expect(await f.extractAndSaveMemories({userId:'owner',userText:'Vivo en Cali.',memoryDisposition:'processed'})).toEqual([]);expect(f.dependencies.callMemoryExtraction).not.toHaveBeenCalled();expect(f.dependencies.saveMemory).not.toHaveBeenCalled();});
  it('assistant text cannot supply missing evidence in the user source',async()=>{const f=fixture();expect(await f.extractAndSaveMemories({userId:'owner',userText:'Hello',assistantReply:'Vivo en Cali.'})).toEqual([]);expect(f.completion).not.toHaveBeenCalled();expect(f.dependencies.saveMemory).not.toHaveBeenCalled();});
  it('attachment-only facts never start extraction',async()=>{const f=fixture();expect(await f.extractAndSaveMemories({userId:'owner',userText:'<untrusted_attachment_content>Vivo en Cali.</untrusted_attachment_content>'})).toEqual([]);expect(f.dependencies.callMemoryExtraction).not.toHaveBeenCalled();});
  it('admitted proposals use the full current source without repeating extraction',async()=>{const f=fixture();expect(await f.extractAndSaveMemories({userId:'owner',userText:'Vivo en Cali.',learningCandidates:[candidate],learningCandidatesProvided:true})).toHaveLength(1);expect(f.dependencies.callMemoryExtraction).not.toHaveBeenCalled();expect(f.dependencies.saveMemory).toHaveBeenCalledWith({userId:'owner',topicKey:'profile/residence',category:'fact',content:'Lives in Cali'});expect(f.completion.mock.calls[0]).toBeDefined();});
  it('a failed semantic approval starts no persistence or entity work',async()=>{const f=fixture();f.completion.mockRejectedValue(new Error('Unavailable'));await expect(f.extractAndSaveMemories({userId:'owner',userText:'Vivo en Cali.',throwOnError:true})).rejects.toThrow('Unavailable');expect(f.dependencies.saveMemory).not.toHaveBeenCalled();expect(f.dependencies.findOrCreateEntityFuzzy).not.toHaveBeenCalled();});
  it('unconfirmed storage stops strict extraction without a write retry',async()=>{const f=fixture();vi.mocked(f.dependencies.saveMemory).mockResolvedValue(null);await expect(f.extractAndSaveMemories({userId:'owner',userText:'Vivo en Cali.',throwOnError:true})).rejects.toThrow('not confirmed');expect(f.dependencies.saveMemory).toHaveBeenCalledTimes(1);});
});
describe('typed semantic admission observations',()=>{
  it('an approval returns the candidate seen before awaiting rather than a mutated one',async()=>{
    const candidates=[{...candidate}];const admission=createMemoryAdmission(()=>async()=>{candidates[0]!.content='Injected after model input';return {content:'{"positions":[1]}'};});const result=await admission.validateMemoryCandidates({userText:'Vivo en Cali.',candidates});expect(result[0]?.content).toBe('Lives in Cali');expect(result[0]).not.toBe(candidates[0]);
  });
  it.each(['{"positions":[0]}','{"positions":[1,1]}','{"positions":[1],"write":true}','null'])('fails closed on an invalid position envelope: %s',async content=>{const admission=createMemoryAdmission(()=>async()=>({content}));expect(await admission.validateMemoryCandidates({userText:'Vivo en Cali.',candidates:[candidate]})).toEqual([]);});
  it('unavailable answers throw only when the caller requests strict admission',async()=>{const admission=createMemoryAdmission(()=>async()=>({unavailable:true}));expect(await admission.validateMemoryCandidates({userText:'Vivo en Cali.',candidates:[candidate]})).toEqual([]);await expect(admission.validateMemoryCandidates({userText:'Vivo en Cali.',candidates:[candidate],throwOnError:true})).rejects.toThrow('unavailable');});
});
