import { describe, expect, it } from 'vitest';
import { measureSerializedRequest, phaseDuration, safeCounter, knownProvider, safeFailureCode, safeExceptionClass, rateLimitDiagnostics } from '../../../src/agent/providers/attempt-diagnostics.js';
import { buildResponseSynthesisMessages, normalizeResponseSynthesis } from '../../../src/agent/providers/client.js';

describe('typed provider diagnostics and synthesis presentation',()=>{
 it('measures Unicode wire bytes without estimating tokens or recording content',()=>{
  const body=JSON.stringify({messages:[{role:'user',content:'mañana 🗓️'}],response_format:{type:'json_schema',json_schema:{schema:{type:'object'}}}});
  const measurement=measureSerializedRequest(body);
  expect(measurement.requestBytes).toBe(Buffer.byteLength(body,'utf8'));expect(measurement.messageCount).toBe(1);expect(measurement.schemaBytes).toBe(Buffer.byteLength('{"type":"object"}'));
  expect(JSON.stringify(measurement)).not.toContain('mañana');expect(()=>measureSerializedRequest('invalid JSON')).toThrow(SyntaxError);
 });
 it('accepts only bounded numeric durations and closed diagnostic vocabulary',()=>{
  expect(phaseDuration(10,15)).toBe(5);expect(phaseDuration('10',15)).toBeNull();expect(phaseDuration(15,10)).toBeNull();
  expect(safeCounter(0)).toBe(0);expect(safeCounter('1')).toBeNull();expect(safeCounter(1.5)).toBeNull();
  expect(knownProvider('GROQ')).toBe('GROQ');expect(knownProvider('private provider')).toBeNull();expect(safeFailureCode('429')).toBe(429);expect(safeExceptionClass('TimeoutError')).toBe('TimeoutError');expect(safeExceptionClass('secret')).toBeNull();
 });
 it('does not infer rate-limit provenance from conflicting or requested providers',()=>{
  const diagnostics=rateLimitDiagnostics({status:429,requestedProvider:'groq',data:{error:{code:500,metadata:{provider_name:'groq',raw:JSON.stringify({error:{code:429}})}}}});
  expect(diagnostics).toMatchObject({failureClass:'rate_limit',rateLimitSource:'uncertain',observedProvider:'groq',errorCode:429});
  expect(rateLimitDiagnostics({status:429,requestedProvider:'groq'}).observedProvider).toBeNull();
 });
 it('validates canonical HTTP dates and caps retry delays at one week',()=>{
  const now=Date.parse('Wed, 21 Oct 2015 07:27:59 GMT');
  expect(rateLimitDiagnostics({nowMs:now,headers:new Headers({'Retry-After':'Wed, 21 Oct 2015 07:28:00 GMT'})}).retryAfterSeconds).toBe(1);
  expect(rateLimitDiagnostics({nowMs:now,headers:new Headers({'Retry-After':'604801','X-RateLimit-Reset':'Thu, 21 Oct 2015 07:28:00 GMT'})})).toMatchObject({retryAfterSeconds:null,rateLimitReset:null});
 });
 it('requires both verified facts and excluded clauses before building synthesis messages',()=>{
  expect(buildResponseSynthesisMessages()).toBeNull();expect(buildResponseSynthesisMessages({facts:[{tool:'manage_task'}]})).toBeNull();expect(buildResponseSynthesisMessages({excludedClauses:[{text:'Outside'}]})).toBeNull();
 });
 it('projects only unique supported areas and excluded text, without fact payloads or tool names',()=>{
  const facts=[{tool:'manage_task',secret:'private result'},{tool:'manage_task'},{tool:'manage_reminder'},{tool:'unsupported'}];
  const messages=buildResponseSynthesisMessages({facts,excludedClauses:[{quote:'Quote',text:'Other',reason:'outside'},{sourceQuote:'Source'}],language:'en'})!;
  expect(JSON.parse(messages[1]!.content)).toEqual({availableAreas:['tasks and projects','reminders'],excludedClauses:[{text:'Quote',reason:'outside'},{text:'Source',reason:'out_of_scope'}]});
  expect(JSON.stringify(messages)).not.toContain('private result');expect(messages[0]!.content).toContain('Never restate');
 });
 it('preserves ES/EN persona instructions and forbids an after-card synthesis fragment',()=>{
  for(const language of ['es','en']){const messages=buildResponseSynthesisMessages({facts:[{tool:'manage_task'}],excludedClauses:[{text:'Outside'}],language})!;expect(messages[0]!.content).toContain(language==='en'?'"after" must be empty':'"after" debe quedar vacío');}
  expect(normalizeResponseSynthesis({before:'',after:'Fallback\n fragment'})).toEqual({before:'Fallback fragment',after:''});
 });
 it('normalizes whitespace and bounds synthesis without converting arbitrary values to text',()=>{
  expect(normalizeResponseSynthesis({before:'  Hello\r\n world  ',after:'Ignored'})).toEqual({before:'Hello world',after:''});
  expect(normalizeResponseSynthesis({before:'x'.repeat(200)}).before).toHaveLength(160);
  expect(normalizeResponseSynthesis({before:{private:'value'},after:'Ignored'})).toEqual({before:'',after:''});
 });
});
