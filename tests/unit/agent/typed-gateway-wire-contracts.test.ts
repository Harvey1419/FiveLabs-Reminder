import { describe, expect, it } from 'vitest';
import { buildRequestPayload } from '../../../src/agent/providers/request-payload.js';
import { extractTextContent, cleanModelText, parseErrorEnvelope, classifyProtocolFailure, classifyHttpFailure, classifyThrownFailure, isProviderRefusal, responseUsage, successTelemetry } from '../../../src/agent/providers/gateway-response-contracts.js';
describe('typed gateway request and response contracts',()=>{
 it('distinguishes absent temperature from explicit unsupported undefined on the wire',()=>{
  expect(buildRequestPayload([],'model').temperature).toBe(0);
  const payload=buildRequestPayload([],'model',{temperature:undefined});expect(Object.hasOwn(payload,'temperature')).toBe(true);expect(JSON.parse(JSON.stringify(payload))).not.toHaveProperty('temperature');
 });
 it('keeps strict output non-streaming and conditional tools/provider fields with shared order',()=>{
  const providers=['future/provider'];const tools=[{type:'function'}];
  const payload=buildRequestPayload([],'future/model',{responseFormat:{type:'json_schema'},tools,parallelToolCalls:false,providers});
  expect(payload).toMatchObject({stream:false,tool_choice:'auto',parallel_tool_calls:false,provider:{allow_fallbacks:false,require_parameters:true}});expect(payload.tools).toBe(tools);expect(payload.provider?.order).toBe(providers);expect(payload.provider?.only).toBe(providers);
  expect(buildRequestPayload([],'model',{tools:[],providers:[]})).not.toHaveProperty('provider');expect(buildRequestPayload([],'model')).not.toHaveProperty('stream');
 });
 it('extracts only textual response parts and preserves distinct prose cleanup',()=>{
  expect(extractTextContent([{type:'text',text:'One'},{type:'refusal',text:'Skip'},{type:'text',text:'Two'},null])).toBe('One\nTwo');
  expect(cleanModelText(' <think>Private</think> Hello ')).toBe('Hello');expect(extractTextContent('<think>Literal</think>')).toBe('<think>Literal</think>');
 });
 it('classifies nested protocol failures and HTTP priorities without throwing on missing bodies',()=>{
  const nested={error:{metadata:{raw:JSON.stringify({error:{param:'response_format',message:'Invalid schema'}})}}};
  expect(classifyProtocolFailure(nested)).toBe('schema_rejection');expect(classifyHttpFailure(429,nested)).toBe('rate_limit');expect(classifyHttpFailure(400,nested)).toBe('schema_rejection');
  expect(classifyProtocolFailure({error:{code:'json_validate_failed'}})).toBe('structured_generation_rejection');expect(classifyHttpFailure(500)).toBe('upstream_unavailable');expect(classifyHttpFailure(418)).toBe('http_418');
  expect(parseErrorEnvelope('invalid')).toBeNull();expect(classifyThrownFailure({name:'AbortError'})).toBe('timeout');expect(classifyThrownFailure(null)).toBe('network_error');
 });
 it('detects explicit and nested refusals without treating every provider error as terminal',()=>{
  expect(isProviderRefusal({}, {message:{refusal:'Rejected'}})).toBe(true);expect(isProviderRefusal({}, {message:{content:[{type:'refusal'}]}})).toBe(true);
  expect(isProviderRefusal({error:{metadata:{raw:'{"error":{"code":"content_filter"}}'}}})).toBe(true);expect(isProviderRefusal({error:{code:'json_validate_failed'}})).toBe(false);
 });
 it('preserves missing versus zero usage and reasoning as a subset rather than an added count',()=>{
  expect(responseUsage({prompt_tokens:0,completion_tokens:10,completion_tokens_details:{reasoning_tokens:4}})).toEqual({promptTokens:0,completionTokens:10,reasoningTokens:4,cachedTokens:undefined});
  expect(Object.hasOwn(responseUsage(null),'promptTokens')).toBe(true);expect(responseUsage(null).promptTokens).toBeUndefined();
 });
 it('emits only bounded telemetry and excludes credentials/freeform response content',()=>{
  const telemetry=successTelemetry({id:'synthetic-key',model:'model',usage:{prompt_tokens:0,completion_tokens:10},choices:[{message:{content:'private message'}}]},{apiKey:'synthetic-key',correlationId:'not-uuid',purpose:'initial',stage:'primary',model:'fallback',provider:'groq',finishReason:'stop',toolCalls:0,latencyMs:10});
  expect(telemetry).toMatchObject({generationId:null,requestId:null,promptTokens:0,completionTokens:10,provider:'groq'});expect(JSON.stringify(telemetry)).not.toContain('private message');expect(JSON.stringify(telemetry)).not.toContain('synthetic-key');
 });
 it('rejects invalid telemetry counters and unrecognized provider names instead of coercing them',()=>{
  const telemetry=successTelemetry({usage:{prompt_tokens:'10',completion_tokens:-1}},{apiKey:null,correlationId:null,purpose:'initial',stage:'primary',model:'model',provider:'private provider',finishReason:'stop',toolCalls:1.5,latencyMs:NaN});
  expect(telemetry).toMatchObject({promptTokens:null,completionTokens:null,provider:null,toolCalls:null,latencyMs:null});
 });
});
