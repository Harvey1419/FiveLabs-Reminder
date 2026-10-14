import { describe, expect, it } from 'vitest';
import { createGatewayRouting, type GatewayEnvironment } from '../../../src/agent/providers/gateway-routing.js';
function routing(environment: GatewayEnvironment = {}) { return createGatewayRouting({ getEnvironment: () => environment }); }
describe('typed gateway routing configuration',()=>{
 it('preserves distinct strict and ordinary foreground fallback profiles',()=>{
  const gateway=routing();
  expect(gateway.createForegroundProfiles().map(p=>[p.stage,p.model,p.providers])).toEqual([['primary','openai/gpt-oss-120b',['groq']],['secondary','z-ai/glm-5.3-flash',['baseten/fp8']],['last_resort','qwen/qwen3.7-flash',['alibaba']]]);
  expect(gateway.createForegroundProfiles({strictStructuredOutput:true}).map(p=>[p.model,p.providers])).toEqual([['openai/gpt-oss-120b',['groq']],['openai/gpt-oss-120b',['cerebras/fp16']],['z-ai/glm-5.3-flash',['baseten/fp8']]]);
 });
 it('allows future model/provider changes through host configuration without domain changes',()=>{
  const gateway=routing({OPENROUTER_PRIMARY_MODEL:'future/model',OPENROUTER_PRIMARY_PROVIDERS:' new-provider , backup ,, ',OPENROUTER_STRICT_SECONDARY_MODEL:'other/model',OPENROUTER_STRICT_SECONDARY_PROVIDERS:' custom '});
  expect(gateway.createForegroundProfiles()[0]).toMatchObject({model:'future/model',providers:['new-provider','backup']});
  expect(gateway.createForegroundProfiles({strictStructuredOutput:true})[1]).toMatchObject({model:'other/model',providers:['custom']});
 });
 it('keeps configured last-resort settings ahead of legacy aliases and blank provider fallbacks',()=>{
  const alias=routing({OPENROUTER_FALLBACK_MODEL:'legacy/model',OPENROUTER_FALLBACK_PROVIDERS:'legacy-provider'});
  expect(alias.MODEL_CONFIG.openrouter.lastResort).toBe('legacy/model');
  const gateway=routing({OPENROUTER_LAST_RESORT_MODEL:'explicit/model',OPENROUTER_FALLBACK_MODEL:'legacy/model',OPENROUTER_LAST_RESORT_PROVIDERS:' , ',OPENROUTER_FALLBACK_PROVIDERS:'legacy-provider'});
  expect(gateway.MODEL_CONFIG.openrouter.lastResort).toBe('explicit/model');expect(gateway.MODEL_CONFIG.openrouter.lastResortProviders).toEqual(['alibaba']);
 });
 it('freezes model/provider snapshots while reading timeouts and effort live',()=>{
  const environment: Record<string,string|undefined>={OPENROUTER_PRIMARY_MODEL:'initial/model'};
  const gateway=routing(environment);environment.OPENROUTER_PRIMARY_MODEL='later/model';environment.OPENROUTER_PRIMARY_TIMEOUT_MS='1234';environment.OPENROUTER_PRIMARY_REASONING_EFFORT='low';
  expect(gateway.createForegroundProfiles()[0]).toMatchObject({model:'initial/model',timeoutMs:1234,reasoning:{effort:'low',exclude:true}});
  expect(Object.isFrozen(gateway.MODEL_CONFIG)).toBe(true);expect(Object.isFrozen(gateway.MODEL_CONFIG.openrouter)).toBe(true);expect(Object.isFrozen(gateway.MODEL_CONFIG.openrouter.primaryProviders)).toBe(true);
 });
 it('keeps only finite positive timeouts and separates strict fallback timeout',()=>{
  const gateway=routing({OPENROUTER_PRIMARY_TIMEOUT_MS:'NaN',OPENROUTER_SECONDARY_TIMEOUT_MS:'-1',OPENROUTER_LAST_RESORT_TIMEOUT_MS:'900',OPENROUTER_STRICT_FALLBACK_TIMEOUT_MS:'1200'});
  expect(gateway.createForegroundProfiles().map(p=>p.timeoutMs)).toEqual([6000,3500,900]);expect(gateway.createForegroundProfiles({strictStructuredOutput:true})[2]?.timeoutMs).toBe(1200);
 });
 it('preserves required-tool and unsupported-parallel settings and strict capability flags',()=>{
  const gateway=routing();const profiles=gateway.createForegroundProfiles();
  expect(profiles[0]).toMatchObject({emptyContentRetries:1,supportsStrictStructuredOutputs:true});
  expect(Object.hasOwn(profiles[0]!,'parallelToolCalls')).toBe(true);expect(profiles[0]?.parallelToolCalls).toBeUndefined();
  expect(profiles[1]).toMatchObject({requiredToolChoiceSupported:false});expect(profiles[2]).toMatchObject({minCompletionTokens:2800,supportsTemperature:true,supportsStrictStructuredOutputs:false,reasoning:null});
  expect(gateway.createForegroundProfiles({strictStructuredOutput:true})[2]?.supportsStrictStructuredOutputs).toBe(true);
 });
 it('keeps independent background models, provider order, timeout and reasoning policy',()=>{
  const gateway=routing({OPENROUTER_MEMORY_PRIMARY_MODEL:'memory/model',OPENROUTER_MEMORY_PRIMARY_PROVIDERS:'memory-provider',OPENROUTER_SECONDARY_REASONING_EFFORT:'medium'});
  expect(gateway.createBackgroundProfiles().map(p=>[p.stage,p.timeoutMs])).toEqual([['memory_primary',9000],['memory_secondary',15000],['memory_last_resort',20000]]);
  expect(gateway.createBackgroundProfiles()[0]).toMatchObject({model:'memory/model',providers:['memory-provider']});expect(gateway.createBackgroundProfiles()[1]?.reasoning?.effort).toBe('medium');
 });
 it('reads credentials live with existing quote stripping and OpenRouter alias rules',()=>{
  const environment: Record<string,string|undefined>={};const gateway=routing(environment);expect(gateway.getOpenRouterApiKey()).toBeNull();
  environment.OPENROUTER_API_KEY=' "synthetic-key" ';expect(gateway.getOpenRouterApiKey()).toBe('synthetic-key');
  environment.OPENROUTER_API_KEY='  ';environment.AI_API_KEY='sk-or-synthetic ';expect(gateway.getOpenRouterApiKey()).toBe('sk-or-synthetic');
  environment.AI_API_KEY='another-provider-key';expect(gateway.getOpenRouterApiKey()).toBeNull();
 });
});
