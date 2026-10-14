import { afterEach, describe, expect, it, vi } from 'vitest';
import { createWorkingMemoryStore } from '../../../src/agent/core/working-memory-cache.js';
import { createWorkingMemoryExecution } from '../../../src/agent/core/working-memory-outcomes.js';
import { createWorkingMemoryPrompt } from '../../../src/agent/core/working-memory-acknowledgement.js';
const user='typed-wm-outcomes';
function harness() {
 const clear=vi.fn(); const store=createWorkingMemoryStore({ clearAgentRunsForUser: clear });
 return { ...store, ...createWorkingMemoryExecution(store), ...createWorkingMemoryPrompt({ getWorkingMemory:store.getWorkingMemory, formatWorkingMemoryPromptBase:store.formatWorkingMemoryPrompt }), clear };
}
afterEach(()=>vi.useRealTimers());
describe('typed working-memory outcomes and acknowledgement context',()=>{
 it('preserves mixed reference positions and cancellation tombstones',()=>{
  const h=harness(); h.saveWorkingMemory(user,{source:'unified',items:[{id:'t1',type:'task',position:3,title:'Task'},{id:'r1',type:'reminder',position:8,title:'Reminder'}]});
  h.updateWorkingMemoryFromExecution({user,toolName:'manage_reminder',params:{action:'cancel',reminderId:'r1'},result:{success:true,data:{content:'Returned'}}});
  expect(h.getWorkingMemory(user)?.items.map(i=>i.position)).toEqual([3,8]);
  expect(h.getWorkingMemory(user)?.items[1]).toMatchObject({title:'Reminder',raw:{status:'cancelled'}});
 });
 it('applies nested mutation data and synchronizes explicit null aliases without resurrecting deadlines',()=>{
  const h=harness(); h.saveWorkingMemory(user,{source:'task',items:[{id:'t1',title:'Old',time:'old clock',raw:{due_date:'old',dueDate:'old',recurrence_rule:'daily'}}]});
  h.updateWorkingMemoryFromExecution({user,toolName:'manage_task',params:{action:'update',target:'t1'},result:{success:true,data:{data:{title:'New',dueDate:null,recurrenceRule:null}}}});
  expect(h.getWorkingMemory(user)?.items[0]).toMatchObject({title:'New',time:null,raw:{due_date:null,dueDate:null,recurrenceRule:null,recurrence_rule:null}});
 });
 it('acknowledges one reminder while retaining siblings and clears runs only when context is exhausted',()=>{
  const h=harness(); h.saveWorkingMemory(user,{source:'reminder',lastAction:'nudge',items:[{id:'r1',title:'One'},{id:'r2',title:'Two'}]});
  const acknowledge=(id:string)=>h.updateWorkingMemoryFromExecution({user,toolName:'manage_reminder',params:{action:'acknowledge',reminderId:id},result:{success:true,data:{id}}});
  acknowledge('r1');expect(h.getWorkingMemory(user)?.items[0]).toMatchObject({internalId:'r2',position:2});expect(h.getWorkingMemory(user)?.notificationReminderId).toBeNull();expect(h.clear).not.toHaveBeenCalled();
  acknowledge('r2');expect(h.getWorkingMemory(user)).toBeNull();expect(h.clear).toHaveBeenCalledWith(user);
 });
 it('merges same-container creation IDs and keeps only the last ten items',()=>{
  const h=harness();h.saveWorkingMemory(user,{source:'task',activeEntity:'Project',activeEntityId:'e1',items:Array.from({length:10},(_,i)=>({id:`t${i}`,title:`Old ${i}`}))});
  h.updateWorkingMemoryFromExecution({user,toolName:'manage_task',params:{action:'create',entityName:'Project'},result:{success:true,data:{entityId:'e1',tasks:[{id:'t9',title:'Updated'},{id:'t10',title:'New'}]}}});
  expect(h.getWorkingMemory(user)?.items).toHaveLength(10);expect(h.getWorkingMemory(user)?.items[0]?.internalId).toBe('t1');expect(h.getWorkingMemory(user)?.items.find(i=>i.internalId==='t9')?.title).toBe('Updated');
 });
 it('batches confirmed creations and excludes unknown or unsuccessful facts',()=>{
  const h=harness();const fact=(id:string,outcome='complete',success=true)=>({tool:'manage_reminder',requestedAction:'create',action:'created',success,outcome,presentationParams:{action:'create',entityName:'Project'},presentationData:[{id,title:id}]});
  h.updateWorkingMemoryFromFacts(user,[fact('a'),fact('uncertain','unknown'),fact('failed','complete',false),fact('b')],{creationsOnly:true});
  expect(h.getWorkingMemory(user)?.items.map(i=>i.internalId)).toEqual(['a','b']);
  const before=h.getWorkingMemory(user);h.updateWorkingMemoryFromFacts(user,[{...fact('a'),requestedAction:'update'}],{creationsOnly:true});expect(h.getWorkingMemory(user)).toBe(before);
 });
 it('applies confirmed mixed facts in order and retains cleared deadlines on completion',()=>{
  const h=harness();h.saveWorkingMemory(user,{source:'task',items:[{id:'t1',title:'Task',time:'old',raw:{due_date:'old'}}]});
  h.updateWorkingMemoryFromFacts(user,[{tool:'manage_task',requestedAction:'update',action:'updated',success:true,presentationParams:{action:'update',target:'t1'},presentationData:{due_date:null}},{tool:'manage_task',requestedAction:'complete',action:'completed',success:true,presentationParams:{action:'complete',target:'t1'},presentationData:{id:'t1'}}]);
  expect(h.getWorkingMemory(user)?.items[0]).toMatchObject({position:1,time:null,raw:{status:'completed',dueDate:null,due_date:null}});
 });
 it('reconciles reminder nudge identity with authoritative followups and preserves dispatched fallback',()=>{
  const h=harness();h.saveWorkingMemory(user,{source:'reminder',lastAction:'nudge',items:[{id:'r1',title:'Take medicine'}]});
  expect(h.formatWorkingMemoryPrompt(user)).toContain('AWAITING_ACKNOWLEDGEMENT');
  expect(h.formatWorkingMemoryPrompt(user,{pendingConfirmationReminders:[{id:'r1'}]})).toContain('AWAITING_ACKNOWLEDGEMENT');
  expect(h.formatWorkingMemoryPrompt(user,{pendingConfirmationReminders:[{id:'other'}]})).not.toContain('AWAITING_ACKNOWLEDGEMENT');
  expect(h.formatWorkingMemoryPrompt(user,{pendingConfirmationReminders:[]})).not.toContain('AWAITING_ACKNOWLEDGEMENT');
  h.saveWorkingMemory(user,{source:'reminder',lastAction:'reminder_dispatched',items:[{id:'r1',title:'Take medicine'}]});
  expect(h.formatWorkingMemoryPrompt(user,{pendingConfirmationReminders:[]})).toContain('AWAITING_ACKNOWLEDGEMENT');
  expect(h.formatWorkingMemoryPrompt(user,{pendingConfirmationReminders:[{id:'r1'},{id:'r2'}]})).not.toContain('AWAITING_ACKNOWLEDGEMENT');
 });
 it('omits acknowledgement instruction for empty references and unrelated context',()=>{
  const h=harness();expect(h.formatWorkingMemoryPrompt(user)).toBe('');
  h.saveWorkingMemory(user,{source:'reminder',lastAction:'nudge',items:[{id:'r1'}]});expect(h.formatWorkingMemoryPrompt(user)).not.toContain('AWAITING_ACKNOWLEDGEMENT');
  h.saveWorkingMemory(user,{source:'task',lastAction:'nudge',notificationReminderId:'r1',notificationContent:'Ping',items:[{id:'t1',title:'Task'}]});expect(h.formatWorkingMemoryPrompt(user)).not.toContain('AWAITING_ACKNOWLEDGEMENT');
 });
});
