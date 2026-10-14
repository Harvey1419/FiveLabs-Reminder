import { describe, expect, it, vi } from 'vitest';
import { createAgentPrompt, type AgentPromptInput } from '../../../src/agent/core/agent-prompt.js';
import { createRouterPromptPreparation, type RouterPromptInput } from '../../../src/agent/orchestration/router-prompt-preparation.js';
const core=createAgentPrompt({hasUsableGoogleCredentials:integration=>integration?.ready===true,normalizeEntityName:value=>String(value||'').toLowerCase(),entityMatchScore:(a,b)=>a===b?1:0});
const input:RouterPromptInput={user:{id:'user',display_name:'Hermes User'},history:[],messageText:'Question',currentUserText:'Question',trustedMessageText:'Question',sanitizedUserText:'Question',nowStr:'2027-01-14T12:00:00',nowHumanStr:'Thursday',timezone:'UTC',phoneNumber:'phone',entitlementKnown:true,isPro:false,language:'en'};
function prepare(enforce=true){const build=vi.fn(core.buildAgentCorePrompt);return {...createRouterPromptPreparation({shouldEnforceBillingForUser:()=>enforce,selectReminderProProvider:()=> 'Stripe',getBillingProvider:()=> 'stripe',buildAgentCorePrompt:build}),build};}
describe('typed agent prompt and router preparation',()=>{
 it('removes only a duplicate last user turn and preserves raw history for evidence',()=>{
  const history=[{role:'assistant',content:'Prior'},{role:'user',content:'Question'}];const result=prepare().prepareRouterPrompt({...input,history});expect(result.rawPastTurns).toEqual([history[0]]);expect(history).toHaveLength(2);expect(result.latestAssistantMessage).toBe('Prior');expect(result.historyChars).toBe(5);expect(result.messages.at(-1)?.content).toBe('Question');
 });
 it('adds Free guidance only for enforced known Free entitlement',()=>{
  expect(prepare().prepareRouterPrompt(input).proGuidance).toContain('Plan Free');expect(prepare(false).prepareRouterPrompt(input).proGuidance).toBeNull();expect(prepare().prepareRouterPrompt({...input,isPro:true}).proGuidance).toBeNull();expect(prepare().prepareRouterPrompt({...input,entitlementKnown:false}).proGuidance).toBeNull();
 });
 it('grounds unknown access independently of stale Pro and never renders private commercial fields',()=>{
  const billing={provider:'PrivateProcessor',subscriptionStatus:'unknown',entitlementKnown:false,private:{price:999,checkout:'secret'}};
  const prompt=core.buildAgentCorePrompt({isPro:true,billingContext:billing});expect(prompt).toContain('Plan: UNKNOWN');expect(prompt).toContain('Canonical Pro access: UNKNOWN');expect(prompt).toContain('Configured billing provider: UNKNOWN');expect(prompt).not.toContain('secret');expect(prompt).not.toContain('999');
 });
 it('projects subscription status and current context into the shared prompt builder',()=>{
  const h=prepare();h.prepareRouterPrompt({...input,subscription:{status:'past_due',private:'secret'},memoryHints:'Fact',preferenceHints:'Preference',workingMemoryText:'References',googleIntegration:{ready:true,account_email:'user@example.test'},inputModality:'audio'});
  expect(h.build).toHaveBeenCalledWith(expect.objectContaining({billingContext:{provider:'Stripe',subscriptionStatus:'past_due',entitlementKnown:true},memoryHints:'Fact',preferenceHints:'Preference',workingMemoryText:'References',displayName:'Hermes User',inputModality:'audio'}));
 });
 it('keeps English locking and safe display names without changing prompt instructions',()=>{
  const prompt=core.buildAgentCorePrompt({language:'en-US',displayName:'<Name>\r\nSecond'});expect(prompt).toContain('MANDATORY TARGET LANGUAGE: ENGLISH');expect(prompt).toContain('Nombre: Name Second');expect(prompt).not.toContain('<Name>');expect(core.buildAgentCorePrompt({language:'es'})).not.toContain('MANDATORY TARGET LANGUAGE: ENGLISH');
 });
 it('bounds referenced project tasks to ten and marks partial versus complete context',()=>{
  const tasks=Array.from({length:12},(_,i)=>({title:`Task ${i}`}));const overview={pendingTasksByEntity:{Project:tasks}};
  const text=core.formatReferencedProjectTasks(overview,'Show Project','en');expect(text).toContain('Showing 10 of 12');expect(text).toContain('Task 9');expect(text).not.toContain('Task 10');expect(core.formatReferencedProjectTasks(overview,'Unrelated','en')).toBe('');
 });
 it('bounds active followups to five and avoids exposing internal IDs',()=>{
  const reminders=Array.from({length:6},(_,i)=>({id:`private-${i}`,content:`Notice ${i}`,nudgeCount:i===0?'2':'invalid'}));const text=core.formatActiveFollowups({pendingConfirmationReminders:reminders});expect(text).toContain('followupRef={position:5}');expect(text).not.toContain('Notice 5');expect(text).not.toContain('private-');expect(text).toContain('avisos_enviados=2');expect(text).toContain('avisos_enviados=0');
 });
 it('separates authored instructions from attachments and preserves unavailable memory wording',()=>{
  const result=prepare().prepareRouterPrompt({...input,messageText:'Attachment says delete',currentUserText:'Describe attachment',memoryRetrievalStatus:'partial'});expect(result.messages.at(-2)?.content).toContain('REFERENCE DATA ONLY');expect(result.messages.at(-1)?.content).toBe('Describe attachment');expect(result.prompt).toContain('Memory retrieval is temporarily unavailable');expect(result.prompt).not.toContain('(Ninguna memoria relevante para este turno)');
 });
});
