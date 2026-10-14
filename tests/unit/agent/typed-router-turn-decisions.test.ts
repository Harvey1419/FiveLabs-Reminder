import { describe, expect, it } from 'vitest';
import { collectIntent, parseStructuredTurnDecision, validateStructuredTurnContent, enforceAttachmentOnlyIntent, enforceCurrentProfileSource, sanitizeHallucinatedEvidenceRefs, bindAuthoritativeFollowupTargets, conversationReplyFromActions } from '../../../src/agent/orchestration/router-turn-decisions.js';
import type { IntentValidation } from '../../../src/agent/contracts/intent-validator.js';
const reply={actions:[{domain:'conversation',action:'reply',content:'Hello'}],excluded:[],responseCapability:'general'};
describe('typed router turn decision boundaries',()=>{
 it('rejects unknown or mixed legacy capabilities and preserves an empty collected decision',()=>{
  expect(collectIntent([{name:'unknown',arguments:'{}'}])).toMatchObject({valid:false,errorCode:'UNKNOWN_TOOL'});
  expect(collectIntent([{name:'execute_turn',arguments:'{}'},{name:'reply_to_user',arguments:'{"content":"Hello"}'}])).toMatchObject({valid:false,errorCode:'UNKNOWN_TOOL'});
  expect(collectIntent([])).toEqual({valid:true,intent:null});expect(collectIntent([{name:'reply_to_user',arguments:'{"content":"  Hello  "}'}])).toMatchObject({valid:true,intent:{actions:[{content:'Hello'}]}});
 });
 it('validates each legacy execute call and enforces the aggregate twelve-action cap',()=>{
  const argumentsValue=JSON.stringify({actions:Array.from({length:7},()=>({domain:'conversation',action:'reply',content:'Hello'})),excluded:[]});
  expect(collectIntent([{name:'execute_turn',arguments:argumentsValue},{name:'execute_turn',arguments:argumentsValue}])).toMatchObject({valid:false,errorCode:'TURN_ACTION_LIMIT'});
  expect(collectIntent([{name:'execute_turn',arguments:'invalid'}])).toMatchObject({valid:false,errorCode:'INVALID_PARAMETERS'});
 });
 it('handles unavailable responses before other content and refuses tools at the strict foreground boundary',()=>{
  expect(parseStructuredTurnDecision({unavailable:true,toolCalls:[{}]})).toEqual({unavailable:true,validation:null});
  expect(parseStructuredTurnDecision({toolCalls:[{}],structuredIntent:reply})).toMatchObject({unavailable:false,validation:{valid:false,errorCode:'INVALID_PARAMETERS'}});
  expect(parseStructuredTurnDecision({content:'invalid'})).toMatchObject({validation:{valid:false,errorCode:'INVALID_PARAMETERS'}});
  expect(parseStructuredTurnDecision({structuredIntent:reply})).toMatchObject({validation:{valid:true,intent:{responseCapability:'general'}}});
 });
 it('drops unsupported historical reply refs only without owned history and validates strict content',()=>{
  const intent={...reply,actions:[{...reply.actions[0],evidenceRefs:['invented']}]};
  const sanitized=sanitizeHallucinatedEvidenceRefs(intent,false) as typeof intent;expect(sanitized.actions[0]).not.toHaveProperty('evidenceRefs');expect(sanitizeHallucinatedEvidenceRefs(intent,true)).toBe(intent);
  expect(validateStructuredTurnContent(JSON.stringify({responseCapability:'general',actions:[{operation:'conversation.reply',content:'Hello'}],excluded:[]}))).toMatchObject({valid:true});
 });
 it('blocks attachment-only operational actions while preserving general conversation and invalid decisions',()=>{
  const general:IntentValidation={valid:true,intent:reply};expect(enforceAttachmentOnlyIntent(general,true)).toBe(general);
  const read:IntentValidation={valid:true,intent:{actions:[{domain:'task',action:'list'}],excluded:[],responseCapability:'productivity'}};
  expect(enforceAttachmentOnlyIntent(read,true)).toMatchObject({valid:false,errorCode:'UNTRUSTED_ATTACHMENT_ACTION'});expect(enforceAttachmentOnlyIntent(read,false)).toBe(read);expect(enforceAttachmentOnlyIntent(null,true)).toBeNull();
 });
 it('strips stale profile changes from independent reads and rejects mutations under stale context',()=>{
  const profileUpdate={sourceQuote:'Old quote',timezone:'UTC'};
  const read:IntentValidation={valid:true,intent:{actions:[{domain:'task',action:'list'}],excluded:[],profileUpdate}};
  expect(enforceCurrentProfileSource(read,'Current question')).toMatchObject({valid:true});const filtered=enforceCurrentProfileSource(read,'Current question');if(filtered.valid)expect(filtered.intent).not.toHaveProperty('profileUpdate');
  const mutation:IntentValidation={valid:true,intent:{actions:[{domain:'task',action:'complete',target:'Task'}],excluded:[],profileUpdate}};
  expect(enforceCurrentProfileSource(mutation,'Current question')).toMatchObject({valid:false,errorCode:'INVALID_TURN_CONTEXT'});expect(enforceCurrentProfileSource(mutation,'Old quote is here')).toBe(mutation);
 });
 it('binds acknowledgement hints to memory or a sole notice without changing unrelated actions',()=>{
  const other={domain:'task',action:'list'};const intent={actions:[{domain:'reminder',action:'acknowledge',target:'1'},other],excluded:[]};
  const bound=bindAuthoritativeFollowupTargets(intent,{pendingConfirmationReminders:[{id:'active',content:'Active notice'}]},{notificationReminderId:'memory-id',notificationContent:'Memory notice'});
  expect(bound.actions[0]).toMatchObject({authoritativeReminderId:'memory-id',target:'1'});expect(bound.actions[1]).toBe(other);expect(intent.actions[0]).not.toHaveProperty('authoritativeReminderId');
  expect(bindAuthoritativeFollowupTargets({actions:[{domain:'reminder',action:'acknowledge'}]},{pendingConfirmationReminders:[{id:'active',content:'Active notice'}]}).actions[0]).toMatchObject({authoritativeReminderId:'active',target:'Active notice'});
 });
 it('does not bind an unrelated target or multiple notices and sanitizes conversational output',()=>{
  const intent={actions:[{domain:'reminder',action:'acknowledge',target:'Other'}]};expect(bindAuthoritativeFollowupTargets(intent,{pendingConfirmationReminders:[{id:'active',content:'Notice'}]}).actions[0]).toBe(intent.actions[0]);
  expect(bindAuthoritativeFollowupTargets(intent,{pendingConfirmationReminders:[{id:'a',content:'A'},{id:'b',content:'B'}]})).toBe(intent);
  expect(conversationReplyFromActions([{domain:'conversation',action:'reply',content:'Done [id: private]'},{domain:'task',action:'list'},{domain:'conversation',action:'reply',content:'Next'}])).toBe('Done\n\nNext');
 });
});
