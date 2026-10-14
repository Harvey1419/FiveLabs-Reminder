import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, chmodSync, existsSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGatewayDispatch, type GatewayDispatchDependencies } from '../../../src/agent/providers/gateway-dispatch.js';
import { createGatewayRouting } from '../../../src/agent/providers/gateway-routing.js';
import { createRunnerProviderTrace, type RunnerProviderTraceDependencies } from '../../../src/agent/providers/runner-provider-trace.js';
function dispatch(key:string|null='synthetic') {
 const routing=createGatewayRouting({getEnvironment:()=>({})});
 const chain=vi.fn<GatewayDispatchDependencies['runOpenRouterChain']>(async()=>null);
 const attempt=vi.fn<GatewayDispatchDependencies['callOpenRouterAttempt']>(async()=>({ok:false,reason:'empty_content',attemptDiagnostics:{}}));
 return {...createGatewayDispatch({...routing,getOpenRouterApiKey:()=>key,runOpenRouterChain:chain,callOpenRouterAttempt:attempt,logger:{warn:vi.fn(),error:vi.fn()}}),chain,attempt};
}
const cleanup: (()=>void)[]=[];afterEach(()=>{for(const fn of cleanup.splice(0))fn();});
function traceFixture(overrides: Partial<RunnerProviderTraceDependencies>={}) {
 const phone='hermes-chat.550e8400-e29b-41d4-a716-446655440000';
 const directory=mkdtempSync(join(realpathSync(tmpdir()),`hermes-provider-trace-${phone}-`));chmodSync(directory,0o700);
 const warn=vi.fn();const once=vi.fn();const remove=vi.fn();
 const perform=vi.fn<RunnerProviderTraceDependencies['performOpenRouterAttempt']>(async(_messages,_model,_key,options)=>{options.capture?.('request',{serializedBody:'{}'});options.capture?.('response',{decision:{content:'OK'}});options.capture?.('validation',{result:{valid:true}});return {ok:true,value:'OK',attemptDiagnostics:{}};});
 const trace=createRunnerProviderTrace({traceEntrypoint:'/synthetic/entry',getEnvironment:()=>({HERMES_CHAT_PROVIDER_TRACE_DIR:directory,HERMES_CHAT_TEST_PHONE:phone,HERMES_CHAT_DISABLE_REMINDER_SCHEDULER:'1'}),getArgv:()=>['node','/synthetic/entry'],getUid:()=>process.getuid?.(),onceExit:once,removeExit:remove,logger:{warn},performOpenRouterAttempt:perform,...overrides});
 cleanup.push(()=>{trace.finalizeRunnerProviderTrace();rmSync(directory,{recursive:true,force:true});});
 return {...trace,directory,warn,once,remove,perform};
}
describe('typed public gateway dispatch',()=>{
 it('returns ES/EN unavailable copy without attempting routes when credentials are absent',async()=>{
  const h=dispatch(null);expect(await h.callChatCompletion([],{returnMessage:true,language:'en'})).toMatchObject({unavailable:true,unavailableReason:'missing_credentials'});
  expect(JSON.parse(String(await h.callChatCompletion([]))).reply).toContain('No pude');expect(await h.callMemoryExtraction([])).toBeNull();expect(await h.callResponseSynthesis()).toBeNull();expect(h.chain).not.toHaveBeenCalled();
 });
 it('starts at requested secondary stage and separates strict format from native tools',async()=>{
  const h=dispatch();await h.callChatCompletion([],{startStage:'secondary',tools:[{function:{name:'execute_turn'}}],responseFormat:{type:'json_schema',json_schema:{strict:true}},returnMessage:true});
  expect(h.chain.mock.calls[0]?.[1].map(p=>p.stage)).toEqual(['secondary','last_resort']);expect(h.chain.mock.calls[0]?.[2]).toMatchObject({tools:null,toolChoice:'none',responseFormat:{type:'json_schema'}});
 });
 it('caps optional advice to one route and two seconds without retries',async()=>{
  const h=dispatch();await h.callChatCompletion([],{purpose:'next_best_action'});
  expect(h.chain.mock.calls[0]?.[1]).toHaveLength(1);expect(h.chain.mock.calls[0]?.[1][0]).toMatchObject({timeoutMs:2000,emptyContentRetries:0,reasoning:{effort:'low'}});
 });
 it('caps memory admission and policy compilation independently of ordinary foreground routes',async()=>{
  const h=dispatch();for(const purpose of ['memory_admission','policy_compilation']){await h.callChatCompletion([],{purpose});const profiles=h.chain.mock.calls.at(-1)?.[1];expect(profiles).toHaveLength(2);expect(profiles?.every(p=>p.timeoutMs<=3000&&p.emptyContentRetries===0)).toBe(true);}
 });
 it('preserves exhaustion diagnostics and filters correlation strings only for logs',async()=>{
  const h=dispatch();h.chain.mockResolvedValue({chainExhausted:true,unavailableReason:'rate_limit',attemptDiagnostics:{status:429}});
  expect(await h.callChatCompletion([],{returnMessage:true,correlationId:'private-text'})).toMatchObject({unavailable:true,unavailableReason:'rate_limit',attemptDiagnostics:{status:429}});
  expect(h.chain.mock.calls[0]?.[2]).toMatchObject({logPrefix:'[ai-client]',correlationId:'private-text'});
 });
 it('uses bounded synthesis settings, normalizes fragments and returns null for malformed JSON',async()=>{
  const h=dispatch();h.chain.mockResolvedValue('{"before":" Hello\\n world ","after":"Ignored"}');
  const input={facts:[{tool:'manage_task'}],excludedClauses:[{quote:'Outside'}]};expect(await h.callResponseSynthesis(input)).toEqual({before:'Hello world',after:''});
  expect(h.chain.mock.calls[0]?.[2]).toMatchObject({purpose:'response_synthesis',maxTokens:180,temperature:0.2,returnMessage:false,toolChoice:'none'});
  h.chain.mockResolvedValue('invalid');expect(await h.callResponseSynthesis(input)).toBeNull();
 });
 it('overrides only memory-primary timeout and preserves background protocol options',async()=>{
  const h=dispatch();await h.callMemoryExtraction([],{timeoutMs:1234,max_tokens:777});expect(h.chain.mock.calls[0]?.[1].map(p=>p.timeoutMs)).toEqual([1234,15000,20000]);expect(h.chain.mock.calls[0]?.[2]).toMatchObject({purpose:'memory',maxTokens:777,responseFormat:null,tools:null,returnMessage:false});
 });
 it('returns direct attempt values and converts direct failures to null',async()=>{
  const h=dispatch();expect(await h.callOpenRouterChat([],'model','synthetic')).toBeNull();h.attempt.mockResolvedValue({ok:true,value:'OK',attemptDiagnostics:{}});expect(await h.callOpenRouterChat([],'model','synthetic')).toBe('OK');expect(h.chain).not.toHaveBeenCalled();
 });
});
describe('typed synthetic runner trace boundary',()=>{
 it('never opens a trace outside the authorized synthetic entrypoint',async()=>{
  const h=traceFixture({getArgv:()=>['node','/server']});await h.callOpenRouterAttempt([],'model','synthetic');expect(existsSync(join(h.directory,'events.jsonl'))).toBe(false);expect(h.once).not.toHaveBeenCalled();expect(h.perform).toHaveBeenCalledTimes(1);
 });
 it('records request/decision/validation/outcome and finalizes once with completeness',async()=>{
  const h=traceFixture();await h.callOpenRouterAttempt([],'model','synthetic',{purpose:'initial'});h.finalizeRunnerProviderTrace();h.finalizeRunnerProviderTrace();
  const rows=readFileSync(join(h.directory,'events.jsonl'),'utf8').trim().split('\n').map(line=>JSON.parse(line));expect(rows.map(row=>row.type)).toEqual(['request','response','validation','outcome','completeness']);expect(rows.at(-1)).toMatchObject({complete:true,unfinishedCalls:0,headers:'never_captured'});expect(h.remove).toHaveBeenCalledTimes(1);
 });
 it('marks credential/oversized evidence missing instead of silently truncating or exposing it',async()=>{
  const perform:RunnerProviderTraceDependencies['performOpenRouterAttempt']=async(_messages,_model,key,options)=>{options.capture?.('response',{decision:{content:key}});options.capture?.('validation',{result:'x'.repeat(300000)});return {ok:true,value:'OK',attemptDiagnostics:{}};};
  const h=traceFixture({performOpenRouterAttempt:perform});await h.callOpenRouterAttempt([],'model','synthetic-secret');h.finalizeRunnerProviderTrace();const text=readFileSync(join(h.directory,'events.jsonl'),'utf8');expect(text).not.toContain('synthetic-secret');expect(text).toContain('credential_in_evidence');expect(text).toContain('event_byte_limit');expect(JSON.parse(text.trim().split('\n').at(-1)!)).toMatchObject({complete:false});
 });
 it('remembers unsafe-directory initialization failure without retrying trace IO',async()=>{
  const h=traceFixture();chmodSync(h.directory,0o755);await h.callOpenRouterAttempt([],'model','synthetic');chmodSync(h.directory,0o700);await h.callOpenRouterAttempt([],'model','synthetic');expect(existsSync(join(h.directory,'events.jsonl'))).toBe(false);expect(h.warn).toHaveBeenCalledTimes(1);expect(h.perform).toHaveBeenCalledTimes(2);
 });
});
