import { describe,expect,it,vi } from 'vitest';
import { createMemoryTool,type MemoryToolDependencies,type MemoryTurn } from '../../../src/agent/tools/memory-tool.js';
import type { MemoryRow } from '../../../src/infrastructure/database/memory-persistence-client.js';
function fixture() {
  const memories:MemoryRow[]=[{id:'owned',content:'Hardware budget',topic_key:null}];
  const deps:MemoryToolDependencies={searchMemories:vi.fn(async()=>({status:'available' as const,memories})),getActiveMemories:vi.fn(async()=>({status:'available' as const,memories})),forgetMemories:vi.fn(async options=>{expect(await options.selectCandidates?.(memories)).toEqual(['owned']);return {success:true,deletedCount:1,deletedMemories:memories};}),extractAndSaveMemories:vi.fn(async()=>memories),formatMemoryListCard:()=> 'Memory card',selectMemoriesToForget:vi.fn(async()=>['owned'])};
  return {deps,...createMemoryTool(deps)};
}
describe('typed memory tool orchestration',()=>{
  it('requires the original user message before semantic admission',async()=>{const f=fixture();expect(await f.executeMemoryTool({action:'save',user:{id:'owner'}})).toMatchObject({success:false,errorCode:'INVALID_PARAMETERS'});expect(f.deps.extractAndSaveMemories).not.toHaveBeenCalled();});
  it('shares one admission promise across repeated saves in a turn',async()=>{const f=fixture(),memoryTurn:MemoryTurn={userText:'Remember the hardware budget'};await Promise.all([f.executeMemoryTool({action:'save',user:{id:'owner'},memoryTurn}),f.executeMemoryTool({action:'save',user:{id:'owner'},memoryTurn})]);expect(f.deps.extractAndSaveMemories).toHaveBeenCalledTimes(1);});
  it('preserves strict read options for its scoped storage call',async()=>{const f=fixture();await f.executeMemoryTool({action:'search',user:{id:'owner'},params:{query:'budget',limit:3}});expect(f.deps.searchMemories).toHaveBeenCalledWith({userId:'owner',query:'budget',limit:3,withStatus:true,throwOnError:true});});
  it('maps nullable legacy topics into optional selection evidence',async()=>{const f=fixture();expect(await f.executeMemoryTool({action:'forget',user:{id:'owner'},params:{query:'forget budget'}})).toMatchObject({success:true});expect(f.deps.selectMemoriesToForget).toHaveBeenCalledWith({query:'forget budget',candidates:[{id:'owned',content:'Hardware budget'}],language:'es'});});
});
