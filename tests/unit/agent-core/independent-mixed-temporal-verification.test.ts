import { describe, it, expect, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { ProductivityTurnRunner, type ProductivityExecutionJournal } from '@templelabs/agent-core';
import { OpenRouterProvider, estimateBoundedInput, type CompletionRequest } from '@templelabs/ai';
import { productivityCheckpointSchema, type TurnContext, type JsonObject, type ReminderRecord, type ToolCall } from '@templelabs/contracts';
import { createReminderTools, createTaskTools, ToolRegistry, type ReminderDomainPort } from '@templelabs/tools';
import { DurableProductivityAssistant, type ProductivityDeliveryPort } from '../../../src/adapters/agent-core/durable-productivity-assistant.js';
import { withTurnLease, type InboundTurnLease } from '../../../src/agent/core/turn-lease.js';

const opening = 'Recuérdame preparar reunión hoy a las 4 PM y enviar informe a las 9 AM, pero no sé si hoy o mañana';
const question = '¿El recordatorio pendiente es para hoy o para mañana?';
const digest = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
const ctx = (): TurnContext => ({ userId:'independent-owner', runId:'r1', requestId:'q1', language:'es', timezone:'America/Bogota',
  referenceTimeIso:'2026-10-11T17:49:00Z', signal:new AbortController().signal, capabilities:new Set(['reminders.create','reminders.read','tasks.create']) });
const explicit = (day='tomorrow',hour=9,minute=0) => ({content:'Explicit schedule',relativeDayTime:{day,hour,minute}});
function domain(mode='normal') {
  const records: ReminderRecord[] = [], receipts: unknown[] = [], events: string[] = [];
  const execute = vi.fn<ReminderDomainPort['execute']>(async (request, context, operationId) => {
    events.push(`execute:${request.operation}`);
    if(mode==='unknown') throw Error('Lost acknowledgement');
    if(request.operation!=='create' && request.operation!=='read') throw Error('Unexpected domain operation');
    const resultRecords = request.operation==='read' ? structuredClone(records) : [{id:`dddddddd-dddd-4ddd-8ddd-${String(records.length+1).padStart(12,'0')}`,
      content:request.input.content,sendAt:request.input.targetTimeIso,status:'pending' as const,recurrence:null,isAdvanceNotice:false,parentReminderId:null,requiresConfirmation:false,acknowledgedAt:null}];
    if(request.operation==='create') records.push(...resultRecords);
    const receipt={userId:mode==='foreign-receipt'?'foreign-owner':context.userId,operationId,toolName:`reminder_${request.operation}`,resourceIds:resultRecords.map(r=>r.id)};
    const data={operation:request.operation,records:resultRecords,complete:true,coverage:request.operation==='read'?'bounded_list' as const:'operation' as const,
      rejections:[],presentation:{canonicalCard:null,questions:[],cta:null}};
    receipts.push(receipt);
    return {status:'success',data,observation:JSON.stringify(data),receipt};
  });
  return {execute,events,receipts,tools:createReminderTools({execute}), audit:()=>digest({records,receipts,calls:execute.mock.calls})};
}
const envelope = (calls: ToolCall[] = []) => ({id:'offline',usage:{prompt_tokens:40,completion_tokens:20,cost:0.00001},choices:[{finish_reason:calls.length?'tool_calls':'stop',message:{role:'assistant',content:'',tool_calls:calls.map(c=>({id:c.id,type:'function',function:{name:c.name,arguments:JSON.stringify(c.arguments)}}))}}]});
const call = (id:string,args:JsonObject,name='reminder_create'): ToolCall => ({id,name,arguments:args});
type Options = NonNullable<ConstructorParameters<typeof ProductivityTurnRunner>[2]>;
function harness(script:unknown[], options:Options={}, mode='normal', taskOnly=false) {
  const d=domain(mode), wires: {messages:{role:string;content:string|null}[];tools:{function:{name:string}}[]}[]=[];
  const provider=new OpenRouterProvider({apiKey:'offline-only',routes:[{id:'offline',model:'fixture/offline',providers:['offline'],timeoutMs:1000}],estimateInputTokens:estimateBoundedInput,
    fetch:async(_url,init)=>{wires.push(JSON.parse(String(init?.body)));if(!script.length)throw Error('Unexpected inference');return new Response(JSON.stringify(script.shift()));}});
  const registry=new ToolRegistry(taskOnly?createTaskTools({execute:async()=>{throw Error('No task dispatch expected');}}):d.tools);
  const runner=new ProductivityTurnRunner(provider,registry,{continuation:'observation_driven',compactObservations:true,initialTools:taskOnly?['task_create']:['reminder_create'],
    maxInputTokens:2500,finishWithVerifiedResults:true,estimateInputTokens:input=>provider.estimateNativeInput(input as CompletionRequest),authorizeWrite:async()=>true,...options});
  const journal:ProductivityExecutionJournal={beforeDispatch:async()=>{d.events.push('before');},afterOutcome:async()=>{d.events.push('after');}};
  return {...d,provider,runner,wires,journal};
}
const prior = () => ({userId:ctx().userId,reminders:[],tasks:[],events:[],handledRequestIds:[],history:[{role:'user' as const,content:opening},{role:'assistant' as const,content:question,toolCalls:[]}]});

describe('independent S4 public calendar probes',()=>{
  it.each([
    ['America/Bogota','2026-10-11T17:49:00Z','today',16,0,'2026-10-11T21:00:00.000Z'],
    ['America/Bogota','2026-10-11T17:49:00Z','tomorrow',9,0,'2026-10-12T14:00:00.000Z'],
    ['America/Bogota','2026-10-11T17:49:00Z','tomorrow',21,0,'2026-10-13T02:00:00.000Z'],
    ['America/Bogota','2026-12-31T23:59:59Z','tomorrow',0,0,'2027-01-01T05:00:00.000Z'],
    ['America/Bogota','2028-02-28T18:00:00Z','tomorrow',9,0,'2028-02-29T14:00:00.000Z'],
    ['America/Bogota','2026-01-31T18:00:00Z','tomorrow',9,0,'2026-02-01T14:00:00.000Z'],
    ['Pacific/Kiritimati','2026-12-31T10:15:00Z','today',1,0,'2026-12-31T11:00:00.000Z'],
    ['Pacific/Kiritimati','2026-12-31T10:15:00Z','tomorrow',0,0,'2027-01-01T10:00:00.000Z'],
    ['Pacific/Pago_Pago','2027-01-01T10:30:00Z','tomorrow',0,0,'2027-01-01T11:00:00.000Z'],
    ['Asia/Kathmandu','2026-10-11T17:49:00Z','tomorrow',0,0,'2026-10-11T18:15:00.000Z'],
    ['America/New_York','2026-11-01T04:59:00Z','today',1,30,'2026-11-01T05:30:00.000Z'],
    ['America/New_York','2026-11-01T05:30:00Z','today',1,30,'2026-11-01T06:30:00.000Z'],
    ['America/New_York','2026-11-01T05:45:00Z','today',1,30,'2026-11-01T06:30:00.000Z'],
    ['Australia/Lord_Howe','2026-04-04T15:00:00Z','today',1,45,'2026-04-04T15:15:00.000Z'],
    ['America/Bogota','2026-10-11T20:59:59.999Z','today',16,0,'2026-10-11T21:00:00.000Z'],
  ])('%s %s %s %s:%s => %s',async(timezone,referenceTimeIso,day,hour,minute,expected)=>{
    const h=domain();const result=await h.tools[0].execute(explicit(day,Number(hour),Number(minute)),{...ctx(),timezone,referenceTimeIso},'probe');
    expect(result.status).toBe('success');expect(h.execute).toHaveBeenCalledTimes(1);
    expect(h.execute.mock.calls[0]?.[0]).toEqual({operation:'create',input:{content:'Explicit schedule',targetTimeIso:expected}});
    const read=await h.tools[1].execute({},ctx(),'read');expect(read).toMatchObject({status:'success',data:{records:[{sendAt:expected}]}});
  });
  it.each([
    ['America/Bogota','2026-10-11T21:00:00Z','today',16,0],
    ['America/Bogota','2026-10-11T21:00:00.001Z','today',16,0],
    ['America/Bogota','2026-10-11T17:49:00Z','today',9,0],
    ['America/New_York','2026-03-07T17:00:00Z','tomorrow',2,30],
    ['America/New_York','2026-11-01T06:30:00Z','today',1,30],
    ['Australia/Lord_Howe','2026-10-03T12:00:00Z','tomorrow',2,15],
    ['Pacific/Apia','2011-12-29T22:00:00Z','tomorrow',9,0],
    ['Not/AZone','2026-10-11T17:49:00Z','tomorrow',9,0],
  ])('rejects %s %s %s %s:%s without any domain mutation',async(timezone,referenceTimeIso,day,hour,minute)=>{
    const h=domain(),before=h.audit();const result=await h.tools[0].execute(explicit(day,Number(hour),Number(minute)),{...ctx(),timezone,referenceTimeIso},'reject');
    expect(result).toEqual({status:'validation_failed',code:'INVALID_LOCAL_TIME',observation:'No write dispatched. Check the clock, timezone and temporal anchor.'});
    expect(h.audit()).toBe(before);expect(h.execute).not.toHaveBeenCalled();
  });
});
describe('independent S4 legacy output preservation',()=>{
  it.each([
    [{unqualifiedLocalTime:{hour:9,minute:0}},'2026-10-12T02:00:00.000Z'],
    [{targetTimeIso:'2026-10-12T09:00:00-05:00'},'2026-10-12T09:00:00-05:00'],
    [{delayMinutes:5},'2026-10-11T17:54:00.000Z'],
    [{delayMinutes:525600},'2027-10-11T17:49:00.000Z'],
  ])('legacy %j => %s',async(input,expected)=>{
    const h=domain();const result=await h.tools[0].execute({content:'Legacy',...input},ctx(),'legacy');
    expect(result).toEqual({status:'success',data:{operation:'create',records:[{id:'dddddddd-dddd-4ddd-8ddd-000000000001',content:'Legacy',sendAt:expected,status:'pending',recurrence:null,isAdvanceNotice:false,parentReminderId:null,requiresConfirmation:false,acknowledgedAt:null}],complete:true,coverage:'operation',rejections:[],presentation:{canonicalCard:null,questions:[],cta:null}},
      observation:JSON.stringify({operation:'create',records:[{id:'dddddddd-dddd-4ddd-8ddd-000000000001',content:'Legacy',sendAt:expected,status:'pending',recurrence:null,isAdvanceNotice:false,parentReminderId:null,requiresConfirmation:false,acknowledgedAt:null}],complete:true,coverage:'operation',rejections:[],presentation:{canonicalCard:null,questions:[],cta:null}}),receipt:{userId:ctx().userId,operationId:'legacy',toolName:'reminder_create',resourceIds:['dddddddd-dddd-4ddd-8ddd-000000000001']}});
  });
});
describe('independent S4 invalid alternatives never dispatch',()=>{
  const alternatives=[{targetTimeIso:'2026-10-12T14:00:00Z'},{delayMinutes:5},{unqualifiedLocalTime:{hour:9,minute:0}},{relativeDayTime:{day:'tomorrow',hour:9,minute:0}}];
  it.each(alternatives.flatMap((a,i)=>alternatives.slice(i+1).map(b=>({...a,...b}))))('rejects pair %j',async input=>{
    const h=domain(),before=h.audit();expect(await h.tools[0].execute({content:'Mixed',...input},ctx(),'mixed')).toEqual({status:'validation_failed',code:'INVALID_ARGUMENTS',observation:'{"error":"Invalid arguments","fields":[{"path":"targetTimeIso","code":"custom"}]}'});expect(h.audit()).toBe(before);
  });
  it.each([
    {},{relativeDayTime:null},{relativeDayTime:{day:'tomorrow',hour:0}},
    explicit('tomorrow',-1),explicit('tomorrow',24),explicit('tomorrow',9,-1),explicit('tomorrow',9,60),explicit('tomorrow',9.5),explicit('today ',9),
    {relativeDayTime:{day:'tomorrow',hour:'9',minute:0}},{relativeDayTime:{day:'tomorrow',hour:9,minute:0,extra:true}},
    {...explicit(),typo:true},{...explicit(),delayMinutes:0},{...explicit(),targetTimeIso:null},
    {...explicit(),...alternatives[0],...alternatives[1],...alternatives[2]},
  ])('strict schema rejects %j',async input=>{
    const h=domain(),before=h.audit();expect(await h.tools[0].execute({content:'Invalid',...input},ctx(),'invalid')).toMatchObject({status:'validation_failed',code:'INVALID_ARGUMENTS'});expect(h.audit()).toBe(before);expect(h.execute).not.toHaveBeenCalled();
  });
});

describe('independent S2/S3/S5 mocked native wire and durable seam',()=>{
  it('exact two turns retain typed AM/PM, first operation, public receipt and durable delivery agreement',async()=>{
    const h=harness([envelope([call('meeting',{...explicit('today',16),content:'Preparar reunión',turnDisposition:'continue'})]),
      envelope([call('clarify',{domain:'reminders',missing:'today_or_tomorrow'},'conversation_clarify')]),
      envelope([call('report',{...explicit(),content:'Enviar informe',turnDisposition:'finish'})])]);
    const saved=new Map<string,JsonObject>();const sent: string[]=[];
    const originalExecute=h.execute.getMockImplementation()!;
    h.execute.mockImplementation(async (...args)=>{
      const cp=productivityCheckpointSchema.parse(saved.get(args[1].runId)?.agentCoreProductivity);
      expect(cp.effects.at(-1)?.call?.name).toBe('reminder_create');expect(cp.effects.at(-1)?.item).toBe(null);
      return originalExecute(...args);
    });
    const send:ProductivityDeliveryPort['send']=async m=>{sent.push(m.text??'');return {messageId:`accepted-${m.id}`};};
    const assistant=new DurableProductivityAssistant(h.runner,{send});
    const lease=(c:TurnContext):InboundTurnLease=>({inboundTurn:{id:c.runId,messageId:c.requestId,threadId:'thread',response:{}},signal:c.signal,assertActive:async()=>{},checkpoint:async patch=>{saved.set(c.runId,structuredClone(patch));}});
    const c1=ctx(),c2={...ctx(),runId:'r2',requestId:'q2'};
    const first=await withTurnLease(lease(c1),()=>assistant.handle(opening,c1,'thread'));
    expect(first.reply.text.endsWith(question)).toBe(true);expect(first.reply.text).toContain('4:00 PM');expect(h.execute).toHaveBeenCalledTimes(1);
    const original=digest(first.conversation.reminders[0]);
    const next=await withTurnLease(lease(c2),()=>assistant.handle('mañana',c2,'thread',first.conversation));
    expect(h.execute).toHaveBeenCalledTimes(2);expect(h.wires).toHaveLength(3);expect(digest(next.conversation.reminders[0])).toBe(original);
    expect(next.conversation.reminders.map(r=>r.sendAt)).toEqual(['2026-10-11T21:00:00.000Z','2026-10-12T14:00:00.000Z']);
    expect(next.reply.text).toContain('9:00 AM');expect(next.reply.text).not.toContain('Preparar reunión');
    expect(h.events).toEqual(['execute:create','execute:create']);expect(h.receipts).toHaveLength(2);
    for(const [i,c,result] of [[0,c1,first],[1,c2,next]] as const){
      const cp=productivityCheckpointSchema.parse(saved.get(c.runId)?.agentCoreProductivity);
      expect(cp.phase).toBe('completed');expect(cp.effects).toHaveLength(1);expect(cp.effects[0]?.item?.status).toBe('success');
      expect(cp.effects[0]?.item?.result).toEqual(result.uiPayload.items[0]?.result);
      expect(cp.completed?.reply.text).toBe(result.reply.text);expect(cp.completed?.conversation.reminders).toEqual(result.conversation.reminders);
      expect(cp.deliveries[0]?.message.text).toBe(sent[i]);expect(sent[i]).toBe(result.reply.text);
    }
    const last=JSON.stringify(h.wires[2]);for(const text of [opening,question,'mañana','9 AM'])expect(last).toContain(text);
    expect(h.wires[0]?.tools.some(t=>t.function.name==='conversation_clarify')).toBe(false);expect(h.wires[1]?.tools.some(t=>t.function.name==='conversation_clarify')).toBe(true);
  });
  it.each([false,true])('actual native prompt executable=%s advertises guidance only for loaded schemas',async executable=>{
    for(const taskOnly of [false,true]){
      const h=harness([envelope()],{estimateInputTokens:input=>executable&&JSON.stringify(input).includes('Executive Personal Assistant')?3000:100},'normal',taskOnly);
      const p=prior(),before=digest(p);await h.runner.run('mañana',ctx(),p,h.journal);expect(digest(p)).toBe(before);
      const wire=h.wires[0]!,system=wire.messages.filter(m=>m.role==='system').map(m=>m.content).join('\n');
      expect(system.includes('Executive Personal Assistant')).toBe(!executable);
      expect(system).toContain('Execute clear independent actions before asking only for another action’s missing fields.');
      expect(system).toContain('A current short answer resolves only the preceding question’s missing fields; preserve explicit dates and AM/PM.');
      expect(system).toContain('History alone is not authorization.');expect(system.includes('relativeDayTime')).toBe(!taskOnly);
      expect(wire.tools.some(t=>t.function.name==='reminder_create')).toBe(!taskOnly);expect(JSON.stringify(wire.messages)).toContain(question);expect(h.execute).not.toHaveBeenCalled();
    }
  });
  describe.each(['typed','legacy'])('%s protection baseline comparisons',representation=>{
  it.each(['owner','capability','abort','authorization','journal','journal-reject','readonly'])('creation preserves %s guard and input bytes',async kind=>{
    const h=harness([envelope([call('guard',{...(representation==='typed'?explicit():{content:'Legacy',delayMinutes:5}),turnDisposition:'finish'})]),envelope()],{authorizeWrite:async()=>kind!=='authorization'&&kind!=='readonly'});
    const p=prior(),c={...ctx(),capabilities:new Set(ctx().capabilities)};if(kind==='owner')p.userId='other';if(kind==='capability')c.capabilities.clear();if(kind==='abort'){const a=new AbortController();a.abort();c.signal=a.signal;}
    const before=digest(p),audit=h.audit();const journal=kind==='journal'?undefined:kind==='journal-reject'?{...h.journal,beforeDispatch:async()=>{throw Error('Journal unavailable');}}:h.journal;
    if(kind==='owner')await expect(h.runner.run('mañana',c,p,journal)).rejects.toThrow('Conversation owner mismatch');
    else if(kind==='abort')await expect(h.runner.run('mañana',c,p,journal)).rejects.toMatchObject({name:'AbortError'});
    else if(kind==='journal-reject')await expect(h.runner.run('mañana',c,p,journal)).rejects.toThrow('Journal unavailable');
    else {const result=await h.runner.run(kind==='readonly'?'Solo lee; no crees nada.':'mañana',c,p,journal);if(kind==='capability'){expect(result.uiPayload.items).toEqual([]);expect(h.wires.every(w=>(w.tools??[]).every(t=>t.function.name!=='reminder_create'))).toBe(true);}else expect(result.uiPayload.items[0]).toMatchObject({status:kind==='journal'?'failed':'approval_required',code:kind==='journal'?'DURABLE_JOURNAL_REQUIRED':'USER_AUTHORIZATION_REQUIRED'});}
    expect(h.execute).not.toHaveBeenCalled();expect(h.audit()).toBe(audit);expect(digest(p)).toBe(before);
  });
  });
  it.each(['unknown','foreign-receipt'])('new typed %s fences later actions and future retries',async mode=>{
    const h=harness([envelope([call('one',explicit()),call('two',explicit('tomorrow',21))])],{},mode);
    const result=await h.runner.run('mañana',ctx(),prior(),h.journal);expect(result.requiresReconciliation).toBe(true);expect(h.execute).toHaveBeenCalledTimes(1);
    expect(result.uiPayload.items.map(i=>i.status)).toEqual(['indeterminate','approval_required']);
    const before=h.audit();await expect(h.runner.run('otra vez',{...ctx(),requestId:'next'},result.conversation,h.journal)).rejects.toThrow('Prior effect requires reconciliation');expect(h.audit()).toBe(before);expect(h.wires).toHaveLength(1);
  });
});


describe('independent S5 privacy, rejected proposals, accounting and delivery',()=>{
  it.each([false,true])('forgotten context remains redacted on actual executable=%s wire',async executable=>{
    const h=harness([envelope()],{estimateInputTokens:input=>executable&&JSON.stringify(input).includes('Executive Personal Assistant')?3000:100});
    const p={...prior(),memories:[{id:'eeeeeeee-eeee-4eee-8eee-000000000001',content:'PRIVATE_FORGOTTEN_FACT',category:'fact' as const,topicKey:null,status:'forgotten' as const}]};
    p.history[0]!.content+=' PRIVATE_FORGOTTEN_FACT';p.history[1]!.content+=' PRIVATE_FORGOTTEN_FACT';
    const before=digest(p);await h.runner.run('mañana',ctx(),p,h.journal);
    const wire=JSON.stringify(h.wires[0]);expect(wire).not.toContain('PRIVATE_FORGOTTEN_FACT');expect(wire).toContain('[forgotten memory]');expect(wire).toContain(question);expect(digest(p)).toBe(before);expect(h.execute).not.toHaveBeenCalled();
  });
  it('rejection arguments cannot authorize/execute; fresh typed proposal preserves unknown accounting and telemetry privacy',async()=>{
    const authorize=vi.fn(async()=>true);
    const rejected={error:{code:502,message:"attempted to call tool 'reminder_create' which was not in request.tools",metadata:{failed_generation:JSON.stringify({content:'PRIVATE_REJECTED_ARGUMENTS',relativeDayTime:{day:'tomorrow',hour:21,minute:0}})}}};
    const h=harness([rejected,envelope([call('fresh',{...explicit(),content:'Fresh proposal',turnDisposition:'finish'})])],{discoverTools:true,initialTools:[],authorizeWrite:authorize});
    const result=await h.runner.run('mañana',ctx(),prior(),h.journal);
    expect(h.wires).toHaveLength(2);expect(h.execute).toHaveBeenCalledTimes(1);expect(authorize).toHaveBeenCalledTimes(1);
    expect(h.execute.mock.calls[0]?.[0]).toEqual({operation:'create',input:{content:'Fresh proposal',targetTimeIso:'2026-10-12T14:00:00.000Z'}});
    expect(result.usage).toMatchObject({accountingComplete:false,estimatedCostUsd:null});expect(result.uiPayload.items.map(i=>i.status)).toEqual(['success']);
    expect(JSON.stringify({wires:h.wires,result,authorize:authorize.mock.calls})).not.toContain('PRIVATE_REJECTED_ARGUMENTS');
    expect(h.wires[0]?.tools.map(t=>t.function.name)).toEqual(['tools_select']);expect(h.wires[1]?.tools.some(t=>t.function.name==='reminder_create')).toBe(true);
  });
  it('unknown delivery preserves verified typed effect and durable unknown receipt; never implies handset delivery',async()=>{
    const h=harness([envelope([call('meeting',{...explicit('today',16),content:'Preparar reunión',turnDisposition:'finish'})])]);
    let saved: JsonObject={};const send=vi.fn<ProductivityDeliveryPort['send']>(async()=>{throw Error('Lost delivery acknowledgement');});
    const assistant=new DurableProductivityAssistant(h.runner,{send}),c=ctx();
    const lease:InboundTurnLease={inboundTurn:{id:c.runId,messageId:c.requestId,threadId:'thread',response:{}},signal:c.signal,assertActive:async()=>{},checkpoint:async patch=>{saved=structuredClone(patch);}};
    await expect(withTurnLease(lease,()=>assistant.handle('Preparar reunión hoy a las 4 PM',c,'thread'))).rejects.toThrow('DELIVERY_OUTCOME_UNKNOWN');
    const cp=productivityCheckpointSchema.parse(saved.agentCoreProductivity);expect(h.execute).toHaveBeenCalledTimes(1);expect(send).toHaveBeenCalledTimes(1);
    expect(cp.effects[0]?.item).toMatchObject({status:'success',result:{records:[{sendAt:'2026-10-11T21:00:00.000Z'}]}});
    expect(cp.deliveries[0]).toMatchObject({status:'unknown',messageId:null});expect(cp.phase).toBe('delivering');expect(cp.completed?.reply.text).toContain('4:00 PM');
  });
});
