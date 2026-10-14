import { describe, expect, it, vi } from 'vitest';
import { createGatewayAttempt, type GatewayAttemptResult } from '../../../src/agent/providers/gateway-attempt.js';
import { createGatewayChain, type GatewayChainOptions, type GatewayChainProfile } from '../../../src/agent/providers/gateway-chain.js';
const logger={log:vi.fn(),warn:vi.fn()};
const strict={type:'json_schema',json_schema:{strict:true}};
const message={role:'assistant' as const,content:'OK',tool_calls:[{function:{name:'execute_turn'}}],finishReason:'stop',model:'model',provider:'groq',routeStage:'secondary',generationId:null,usage:{promptTokens:undefined,completionTokens:undefined,reasoningTokens:undefined,cachedTokens:undefined},attemptDiagnostics:{}};
const profiles: GatewayChainProfile[]=[{stage:'primary',model:'primary',providers:['groq'],timeoutMs:6000,reasoning:null,emptyContentRetries:1,supportsStrictStructuredOutputs:true},{stage:'secondary',model:'secondary',providers:['cerebras'],timeoutMs:3500,reasoning:null,requiredToolChoiceSupported:false,supportsStrictStructuredOutputs:true}];
const options: GatewayChainOptions={apiKey:'synthetic',purpose:'initial',temperature:0,maxTokens:800,responseFormat:null,tools:null,toolChoice:'auto',returnMessage:true,logPrefix:null,correlationId:null};
function attempt(body: unknown,status=200){const fetch=vi.fn<typeof globalThis.fetch>(async()=>new Response(JSON.stringify(body),{status}));return {...createGatewayAttempt({fetch,now:()=>1000,monotonicNow:()=>10,logger}),fetch};}
const envelope=(content:unknown,finish_reason='stop')=>({provider:'groq',choices:[{finish_reason,message:{content}}]});
describe('typed gateway attempts and bounded fallback chain',()=>{
 it('preserves strict JSON string values and captures request/response/validation evidence',async()=>{
  const raw='{"reply":"<think>literal</think>"}';const h=attempt(envelope(raw));const capture=vi.fn();
  const result=await h.performOpenRouterAttempt([],'model','synthetic',{responseFormat:strict,returnMessage:true,capture,validateStructuredContent:()=>({valid:true,intent:{reply:'literal'}}),logPrefix:null});
  expect(result).toMatchObject({ok:true,value:{content:raw,structuredIntent:{reply:'literal'}},attemptDiagnostics:{messageCount:0,preparationMs:0,fetchMs:0,parseValidationMs:0}});
  expect(capture.mock.calls.map(([type])=>type)).toEqual(['request','response','validation']);expect(JSON.parse(String(h.fetch.mock.calls[0]?.[1]?.body)).stream).toBe(false);
 });
 it('rejects truncated strict and memory outputs before accepting parseable prefixes',async()=>{
  expect(await attempt(envelope('{"reply":"prefix"}','length')).performOpenRouterAttempt([],'model','synthetic',{responseFormat:strict,logPrefix:null})).toMatchObject({ok:false,reason:'truncated_structured_output'});
  expect(await attempt(envelope('{"reply":"prefix"}','length')).performOpenRouterAttempt([],'model','synthetic',{purpose:'memory',logPrefix:null})).toMatchObject({ok:false,reason:'truncated_memory_output'});
 });
 it('marks refusals terminal and invalid envelopes or throwing validators unsuccessful',async()=>{
  expect(await attempt({error:{code:'content_filter'}}).performOpenRouterAttempt([],'model','synthetic',{responseFormat:strict,logPrefix:null})).toMatchObject({ok:false,reason:'provider_refusal',terminal:true});
  expect(await attempt({}).performOpenRouterAttempt([],'model','synthetic',{responseFormat:strict,logPrefix:null})).toMatchObject({ok:false,reason:'invalid_response_envelope'});
  expect(await attempt(envelope('{}')).performOpenRouterAttempt([],'model','synthetic',{responseFormat:strict,validateStructuredContent:()=>{throw new Error('private');},logPrefix:null})).toMatchObject({ok:false,reason:'invalid_structured_output'});
 });
 it('classifies transport aborts and required-tool omissions with safe diagnostics',async()=>{
  const fetch=vi.fn<typeof globalThis.fetch>(async()=>{throw new DOMException('synthetic','AbortError');});
  const h=createGatewayAttempt({fetch,now:()=>1000,monotonicNow:()=>10,logger});expect(await h.performOpenRouterAttempt([],'model','synthetic',{logPrefix:null})).toMatchObject({ok:false,reason:'timeout',attemptDiagnostics:{exceptionClass:'AbortError'}});
  expect(await attempt(envelope('prose')).performOpenRouterAttempt([],'model','synthetic',{tools:[{type:'function'}],toolChoice:'required',logPrefix:null})).toMatchObject({ok:false,reason:'required_tool_missing'});
 });
 it('retries only empty/required-tool misses on the same provider and then changes route',async()=>{
  const call=vi.fn(async():Promise<GatewayAttemptResult>=>({ok:false,reason:'empty_content',attemptDiagnostics:{}}));call.mockResolvedValueOnce({ok:false,reason:'empty_content',attemptDiagnostics:{}}).mockResolvedValueOnce({ok:false,reason:'rate_limit',attemptDiagnostics:{}}).mockResolvedValueOnce({ok:true,value:message,attemptDiagnostics:{}});
  expect(await createGatewayChain({callOpenRouterAttempt:call,logger}).runOpenRouterChain([],profiles,options)).toBe(message);expect(call.mock.calls).toHaveLength(3);expect(call.mock.calls.map(c=>(c as unknown[])[1])).toEqual(['primary','primary','secondary']);
 });
 it('moves past upstream failures without a same-provider retry and stops on refusal',async()=>{
  const call=vi.fn(async():Promise<GatewayAttemptResult>=>({ok:false,reason:'upstream_unavailable',attemptDiagnostics:{}}));
  call.mockResolvedValueOnce({ok:false,reason:'upstream_unavailable',attemptDiagnostics:{}}).mockResolvedValueOnce({ok:false,reason:'provider_refusal',terminal:true,attemptDiagnostics:{marker:'terminal'}});
  expect(await createGatewayChain({callOpenRouterAttempt:call,logger}).runOpenRouterChain([],profiles,options)).toMatchObject({unavailable:true,refused:true,attemptDiagnostics:{marker:'terminal'}});expect(call).toHaveBeenCalledTimes(2);
 });
 it('skips unsupported strict routes and rejects prose after required-tool auto fallback',async()=>{
  const call=vi.fn(async():Promise<GatewayAttemptResult>=>({ok:true,value:{...message,tool_calls:[]},attemptDiagnostics:{marker:'prose'}}));
  const result=await createGatewayChain({callOpenRouterAttempt:call,logger}).runOpenRouterChain([],[{...profiles[0]!,supportsStrictStructuredOutputs:false},profiles[1]!],{...options,responseFormat:strict,tools:[{function:{name:'execute_turn'}}],toolChoice:'required'});
  expect(result).toMatchObject({chainExhausted:true,unavailableReason:'required_tool_missing',attemptDiagnostics:{marker:'prose'}});expect(call).toHaveBeenCalledTimes(1);expect((call.mock.calls[0] as unknown[])?.[3]).toMatchObject({toolChoice:'auto'});
 });
 it('preserves named-tool choice, minimum completion tokens and unsupported temperature',async()=>{
  const call=vi.fn(async():Promise<GatewayAttemptResult>=>({ok:true,value:message,attemptDiagnostics:{}}));
  await createGatewayChain({callOpenRouterAttempt:call,logger}).runOpenRouterChain([],[{...profiles[1]!,requiredToolName:'execute_turn',minCompletionTokens:2800,supportsTemperature:false}],{...options,tools:[{function:{name:'execute_turn'}}],toolChoice:'required'});
  expect((call.mock.calls[0] as unknown[])?.[3]).toMatchObject({toolChoice:{type:'function',function:{name:'execute_turn'}},max_tokens:2800,temperature:undefined,allowProviderFallbacks:false});
 });
});
