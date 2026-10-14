import { describe, expect, it, vi } from 'vitest';
import { createRouterProfileContext, type RouterProfileDecision, type RouterProfileFact } from '../../../src/agent/orchestration/router-profile-context.js';
function harness({text='Current',supplied=text,user={id:'user',phone_number:'phone',timezone:'America/Bogota',locale:'es-CO'} as unknown,detected=null as string|null,history=[] as {role:string;entities?:{_responseLanguage:string}}[],effects=[] as RouterProfileFact[]}: { text?: string; supplied?: string; user?: unknown; detected?: string | null; history?: { role: string; entities?: { _responseLanguage: string } }[]; effects?: RouterProfileFact[] } = {}){
 const events:string[]=[];const lease=vi.fn(async()=>{events.push('lease');});const write=vi.fn(async(_id:string,patch:unknown)=>{events.push('write');return patch;});
 const fact=vi.fn((input:{toolName:string;result:{success:boolean;data:unknown}})=>{events.push('fact');return {tool:input.toolName,success:input.result.success,presentationData:input.result.data};});
 const context=createRouterProfileContext({extractCurrentUserText:(raw,supplied)=>typeof supplied==='string'?supplied.trim():String(raw||''),detectLanguageFromText:()=>detected,explicitEnglishDirective:/^(?:speak in english|en inglés)/i,explicitSpanishDirective:/^(?:speak in spanish|en español)/i,assertTurnLease:lease,updateUserPreferences:write,createExecutionFact:fact},{messageText:text,suppliedCurrentUserText:supplied,userOrPhone:user,history,contextEffects:effects});
 return {...context,get language(){return context.language;},get timezone(){return context.timezone;},events,lease,write,fact,effects};
}
describe('typed router current-turn profile context',()=>{
 it('retains supplied identity and English profile defaults with explicit Spanish adaptation',()=>{
  const user={id:'u',locale:'en-US',timezone:'UTC'};const h=harness({user,detected:'es'});expect(h.user).toBe(user);expect(h.language).toBe('en');expect(h.timezone).toBe('UTC');
  expect(harness({user,text:'en español',detected:'es'}).language).toBe('es');expect(harness({user:'phone'}).user).toMatchObject({phone_number:'phone',timezone:'America/Bogota',locale:'es-CO'});
 });
 it('uses the latest assistant response language for continuity without locking a Spanish turn',()=>{
  const history=[{role:'assistant',entities:{_responseLanguage:'en'}}];expect(harness({history}).language).toBe('en');expect(harness({history,detected:'es'}).language).toBe('es');
 });
 it('preserves language overwrite guards while permitting explicit current-turn directives',async()=>{
  const en=harness({user:{id:'u',locale:'en-US'},detected:'en'});await en.applyDecisionContext({responseLanguage:'es'});expect(en.language).toBe('en');
  const es=harness({text:'hola',detected:'es'});await es.applyDecisionContext({responseLanguage:'en'});expect(es.language).toBe('es');
  const explicit=harness({text:'speak in english',detected:'en'});await explicit.applyDecisionContext({responseLanguage:'en'});expect(explicit.language).toBe('en');
 });
 it('checks lease before persisting and updates the shared user only after returned fields match',async()=>{
  const h=harness({text:'move to UTC and English'});expect(await h.applyDecisionContext({responseLanguage:'en',profileUpdate:{sourceQuote:'move to UTC',timezone:'UTC',language:'en'}})).toBe(true);
  expect(h.events).toEqual(['lease','write','fact']);expect(h.write).toHaveBeenCalledWith('user',{timezone:'UTC',locale:'en-US'});expect(h.user).toMatchObject({timezone:'UTC',locale:'en-US'});expect(h.timezone).toBe('UTC');expect(h.effects[0]).toMatchObject({success:true,presentationData:{timezone:'UTC',locale:'en-US'}});
 });
 it('does not repeat an already observed matching profile write in the current effect list',async()=>{
  const effects=[{tool:'profile',success:true,presentationData:{timezone:'UTC'}}];const h=harness({text:'move to UTC',effects});expect(await h.applyDecisionContext({profileUpdate:{sourceQuote:'move to UTC',timezone:'UTC'}})).toBe(true);expect(h.lease).not.toHaveBeenCalled();expect(h.write).not.toHaveBeenCalled();expect(effects).toHaveLength(1);
 });
 it('keeps unmatched or throwing writes unsuccessful and leaves persisted user fields unchanged',async()=>{
  const h=harness({text:'move to UTC'});h.write.mockResolvedValue({timezone:'different'});expect(await h.applyDecisionContext({profileUpdate:{sourceQuote:'move to UTC',timezone:'UTC'}})).toBe(false);expect(h.user.timezone).toBe('America/Bogota');expect(h.effects[0]).toMatchObject({success:false,presentationData:null});
  const failed=harness({text:'move to UTC'});failed.write.mockRejectedValue(new Error('offline'));expect(await failed.applyDecisionContext({profileUpdate:{sourceQuote:'move to UTC',timezone:'UTC'}})).toBe(false);expect(failed.user.timezone).toBe('America/Bogota');
 });
 it('requires current quoted evidence and identity, and propagates lease failures before writes',async()=>{
  const stale=harness();expect(await stale.applyDecisionContext({profileUpdate:{sourceQuote:'Old quote',timezone:'UTC'}})).toBe(false);expect(stale.lease).not.toHaveBeenCalled();expect(stale.write).not.toHaveBeenCalled();
  const h=harness({text:'move to UTC'});h.lease.mockRejectedValue(new Error('lost lease'));await expect(h.applyDecisionContext({profileUpdate:{sourceQuote:'move to UTC',timezone:'UTC'}})).rejects.toThrow('lost lease');expect(h.write).not.toHaveBeenCalled();expect(h.effects).toEqual([]);
 });
 it('promotes a language candidate only when its exact evidence appears in the current turn',async()=>{
  const h=harness({text:'speak in english'});const decision:RouterProfileDecision={learningCandidates:[{topicKey:'preference/language',category:'preference',content:'English',evidence:' speak in english '}]};expect(await h.applyDecisionContext(decision)).toBe(true);expect(decision.profileUpdate).toEqual({sourceQuote:'speak in english',language:'en'});expect(h.user.locale).toBe('en-US');
  const stale=harness();await stale.applyDecisionContext({learningCandidates:[{topicKey:'preference/language',category:'preference',content:'English',evidence:'Old quote'}]});expect(stale.write).not.toHaveBeenCalled();
 });
});
