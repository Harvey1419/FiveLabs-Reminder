import { describe, expect, it, vi } from 'vitest';
import { MockAIProvider } from '@templelabs/ai';
import { ProductivityTurnRunner } from '@templelabs/agent-core';
import { productivityConversationSchema, type JsonObject, type ProductivityConversation, type ToolCall } from '@templelabs/contracts';
import { createReminderTools, ToolRegistry } from '@templelabs/tools';
import { createSyntheticReminders } from '../../../scripts/evals/v2-fluent-conversation.js';
import { context as fixtureContext, response } from './productivity-fixtures.js';

const context = { ...fixtureContext, userId: 'fluent-eval-synthetic-owner', capabilities: new Set([...fixtureContext.capabilities, 'reminders.read']) };
const opening = 'Recuérdame preparar reunión hoy a las 4 PM y enviar informe a las 9 AM, pero no sé si hoy o mañana';
const pending = { tool: 'reminder_create', missing: 'today_or_tomorrow', knownArguments: { content: 'Enviar informe', relativeDayTime: { hour: 9, minute: 0 } } };
const decide = (args: JsonObject): ToolCall => ({ id: 'decision', name: 'conversation_decide', arguments: args });
const meeting: ToolCall = { id: 'meeting', name: 'reminder_create', arguments: { decisionItem: 'meeting', content: 'Preparar reunión', relativeDayTime: { day: 'today', hour: 16, minute: 0 } } };
function setup(script: ReturnType<typeof response>[], permit = true, store = createSyntheticReminders(), limits: { maxModelSteps?: number; maxToolCalls?: number } = {}) {
  const execute = vi.fn(store.execute);
  const provider = new MockAIProvider(script.map(response => ({ response })));
  const options = { structuredDecisions: true, continuation: 'observation_driven' as const, discoverTools: true,
    initialTools: ['reminder_create'], finishWithVerifiedResults: true, maxModelSteps: 10, maxToolCalls: 10,
    maxInputTokens: 2500, maxTotalTokens: 20000, maxOutputTokens: 2048, estimateInputTokens: () => 100,
    authorizeWrite: async () => permit, ...limits };
  const runner = new ProductivityTurnRunner(provider, new ToolRegistry(createReminderTools({ execute })), options);
  const before = vi.fn(async () => {}), after = vi.fn(async () => {});
  const journal = { beforeDispatch: before, afterOutcome: after };
  return { store, execute, provider, runner, before, after, journal };
}
const dateKinds = ['date', 'today_or_tomorrow'] as const;
const first = (missing: typeof dateKinds[number] = 'today_or_tomorrow') => response([
  decide({ ready: [{ key: 'meeting', tool: 'reminder_create' }], pending: { ...pending, missing } }), meeting,
]);

describe('typed first-turn decision and last pending clarification', () => {
  it('advertises simple native shapes while keeping semantic validation in the host', async () => {
    const s = setup([first()]);
    await s.runner.run(opening, context, undefined, s.journal);
    const request = s.provider.requests[0]!;
    const schema = request.tools.find(tool => tool.name === 'conversation_decide')!.inputSchema;
    expect(schema).not.toHaveProperty('not');
    expect(schema.properties).toMatchObject({
      ready: { type: 'array', items: { type: 'object', required: ['key', 'tool'] } },
      pending: { type: 'object', required: ['tool', 'missing'] }, reply: { type: 'string' },
    });
    const properties = schema.properties as JsonObject;
    expect(properties.reply).not.toHaveProperty('minLength'); expect(properties.reply).not.toHaveProperty('pattern');
    expect(properties.ready).not.toHaveProperty('maxItems');
    expect(((properties.ready as JsonObject).items as JsonObject).properties).toMatchObject({ key: { type: 'string' } });
    const advertised = JSON.stringify(request);
    expect(advertised).toContain('ready:meeting, pending:report');
    expect(advertised).toContain('Omit reply for ready/pending/resolution');
    expect(s.store.snapshot()).toMatchObject([{ content: 'Preparar reunión', sendAt: '2026-10-11T21:00:00.000Z' }]);
    expect(s.store.operations).toHaveLength(1); expect(s.store.receipts).toHaveLength(1);
  });
  it.each([
    { ready: [], pending: { tool: 'reminder_create', missing: 'today_or_tomorrow', knownArguments: {} }, reply: '¿Hoy o mañana?' },
    { ready: [{ key: 'meeting', tool: 'reminder_create' }], reply: '' },
    { ready: [], reply: '   ' },
  ])('still rejects invalid reply combinations without repairing or executing rejected arguments: %j', async args => {
    const s = setup([response([decide(args as JsonObject), meeting])]);
    const result = await s.runner.run(opening, context, undefined, s.journal);
    expect(result.uiPayload.notices).toContain('invalid_response');
    expect(s.provider.requests).toHaveLength(1);
    expect(s.before).not.toHaveBeenCalled(); expect(s.after).not.toHaveBeenCalled(); expect(s.execute).not.toHaveBeenCalled();
    expect(s.store.snapshot()).toEqual([]); expect(s.store.operations).toEqual([]); expect(s.store.receipts).toEqual([]);
    expect(result.conversation).not.toHaveProperty('pending');
  });
  it.each(dateKinds)('asks for a fresh %s declaration when native output omits knownArguments, without admitting the omission', async missing => {
    const omitted = { ready: [{ key: 'meeting', tool: 'reminder_create' }], pending: { tool: 'reminder_create', missing } };
    const original = JSON.stringify(omitted);
    const s = setup([response([decide(omitted)]), first(missing)]);
    const result = await s.runner.run(opening, context, undefined, s.journal);
    expect(result.uiPayload.notices).toEqual([]); expect(s.provider.requests).toHaveLength(2);
    expect(JSON.stringify(omitted)).toBe(original);
    expect(s.execute).toHaveBeenCalledTimes(1); expect(s.before).toHaveBeenCalledTimes(1); expect(s.after).toHaveBeenCalledTimes(1);
    expect(s.store.operations).toHaveLength(1); expect(s.store.receipts).toHaveLength(1);
    expect(result.conversation.pending?.knownArguments).toEqual(pending.knownArguments);
    const controls = result.conversation.history.filter(message => message.role === 'assistant')
      .flatMap(message => message.role === 'assistant' ? message.toolCalls ?? [] : []).filter(call => call.name === 'conversation_decide');
    expect(controls).toHaveLength(1); expect(controls[0]!.arguments.pending).toHaveProperty('knownArguments', pending.knownArguments);
  });
  it.each(dateKinds)('never dispatches a sibling or persists omitted %s knownArguments', async missing => {
    const invalid = decide({ ready: [{ key: 'meeting', tool: 'reminder_create' }], pending: { tool: 'reminder_create', missing } });
    const s = setup([response([invalid, meeting])]);
    const result = await s.runner.run(opening, context, undefined, s.journal);
    expect(result.uiPayload.notices).toContain('invalid_response'); expect(s.provider.requests).toHaveLength(1);
    expect(s.execute).not.toHaveBeenCalled(); expect(s.before).not.toHaveBeenCalled(); expect(s.after).not.toHaveBeenCalled();
    expect(s.store.snapshot()).toEqual([]); expect(s.store.operations).toEqual([]); expect(s.store.receipts).toEqual([]);
    expect(result.conversation).not.toHaveProperty('pending');
  });
  it('bounds repeated native omission rather than accepting synthesized facts', async () => {
    const invalid = response([decide({ ready: [], pending: { tool: 'reminder_create', missing: 'date' } })]);
    const s = setup([invalid, invalid, first()]);
    const result = await s.runner.run(opening, context, undefined, s.journal);
    expect(result.uiPayload.notices).toContain('invalid_response'); expect(s.provider.requests).toHaveLength(2);
    expect(s.execute).not.toHaveBeenCalled(); expect(s.before).not.toHaveBeenCalled(); expect(s.after).not.toHaveBeenCalled();
    expect(s.store.snapshot()).toEqual([]); expect(s.store.operations).toEqual([]); expect(s.store.receipts).toEqual([]);
    expect(result.conversation).not.toHaveProperty('pending');
  });
  it('reproduces legacy prose closure and requires one fresh no-effect decision instead', async () => {
    const question = response(); question.message.content = '¿Confirmamos ambos?';
    const s = setup([question, first()]);
    const result = await s.runner.run(opening, context, undefined, s.journal);
    expect(s.provider.requests).toHaveLength(2);
    expect(result.conversationReply).toBeNull();
    expect(result.uiPayload).toMatchObject({ notices: [], clarification: { domain: 'reminders', missing: 'today_or_tomorrow' } });
    expect(s.store.snapshot()).toMatchObject([{ content: 'Preparar reunión', sendAt: '2026-10-11T21:00:00.000Z' }]);
    expect(s.before).toHaveBeenCalledTimes(1); expect(s.after).toHaveBeenCalledTimes(1);
  });
  it('executes same-response ready work then persists one host-bound pending; resolves only it after JSON reload', async () => {
    const s = setup([first()]);
    const a = await s.runner.run(opening, context, undefined, s.journal);
    expect(a.uiPayload.items).toHaveLength(1);
    expect(a.uiPayload.clarification).toEqual({ domain: 'reminders', missing: 'today_or_tomorrow' });
    const stored = productivityConversationSchema.parse(JSON.parse(JSON.stringify(a.conversation)));
    const p = (stored as ProductivityConversation & { pending?: { id: string; sourceRequestId: string; knownArguments: JsonObject } }).pending;
    expect(p).toMatchObject({ sourceRequestId: context.requestId, knownArguments: pending.knownArguments });
    expect(p?.id).toBeTruthy();
    const b = setup([response([decide({ ready: [{ key: 'report', tool: 'reminder_create' }], resolution: { pendingId: p!.id, key: 'report' } }),
      { id: 'report', name: 'reminder_create', arguments: { decisionItem: 'report', content: 'Enviar informe', relativeDayTime: { day: 'tomorrow', hour: 9, minute: 0 } } }])], true, s.store);
    const result = await b.runner.run('mañana', { ...context, requestId: 'answer' }, stored, b.journal);
    expect(result.uiPayload.items).toHaveLength(1);
    const resolutionRequest = b.provider.requests[0]!;
    expect(JSON.stringify(resolutionRequest)).toContain('Omit reply for ready/pending/resolution');
    expect(JSON.stringify(resolutionRequest)).toContain('one ready key');
    expect(result.uiPayload.notices).toEqual([]);
    expect(result.uiPayload).not.toHaveProperty('clarification');
    expect(b.provider.requests).toHaveLength(1);
    expect(result.conversation.reminders[0]).toEqual(a.conversation.reminders[0]);
    expect(b.execute).toHaveBeenCalledTimes(1);
    expect(b.store.operations).toHaveLength(2);
    expect(b.store.operations[1]!.request).toEqual({ operation: 'create', input: { content: 'Enviar informe', targetTimeIso: '2026-10-12T14:00:00.000Z' } });
    expect(result.conversation).not.toHaveProperty('pending');
  });
  it.each(dateKinds)('recovers %s empty-facts declaration and premature closure using only fresh real calls', async missing => {
    const declaration = { ready: [{ key: 'meeting', tool: 'reminder_create' }], pending: { ...pending, missing } };
    const q = response(); q.message.content = 'Listo.';
    const s = setup([response([decide({ ...declaration, pending: { ...pending, missing, knownArguments: {} } })]),
      response([decide(declaration)]), q, response([meeting])]);
    const a = await s.runner.run(opening, context, undefined, s.journal);
    expect(a.uiPayload.notices).toEqual([]);
    expect(s.provider.requests).toHaveLength(4);
    expect(a.usage.modelSteps).toBe(4);
    expect(s.before).toHaveBeenCalledTimes(1); expect(s.after).toHaveBeenCalledTimes(1);
    expect(s.execute).toHaveBeenCalledTimes(1); expect(s.store.operations).toHaveLength(1); expect(s.store.receipts).toHaveLength(1);
    expect(s.store.snapshot()).toMatchObject([{ content: 'Preparar reunión', sendAt: '2026-10-11T21:00:00.000Z' }]);
    expect(a.conversation.pending?.knownArguments).toEqual(pending.knownArguments);
    expect(JSON.stringify(s.provider.requests[2])).toContain('remainingReady');
    expect(JSON.stringify(s.provider.requests[3])).toContain('Emit fresh tool calls');
    const stored = productivityConversationSchema.parse(JSON.parse(JSON.stringify(a.conversation)));
    const report: ToolCall = { id: 'report', name: 'reminder_create', arguments: { decisionItem: 'report', content: 'Enviar informe',
      relativeDayTime: { day: 'tomorrow', hour: 9, minute: 0 } } };
    const b = setup([response([decide({ ready: [{ key: 'report', tool: 'reminder_create' }],
      resolution: { pendingId: stored.pending!.id, key: 'report' } })]), q, response([report])], true, s.store);
    const result = await b.runner.run('mañana', { ...context, requestId: 'answer' }, stored, b.journal);
    expect(result.uiPayload.notices).toEqual([]); expect(b.provider.requests).toHaveLength(3);
    expect(b.before).toHaveBeenCalledTimes(1); expect(b.after).toHaveBeenCalledTimes(1); expect(b.execute).toHaveBeenCalledTimes(1);
    expect(s.store.operations).toHaveLength(2); expect(s.store.receipts).toHaveLength(2);
    expect(result.conversation.reminders[0]).toEqual(a.conversation.reminders[0]);
    expect(s.store.snapshot()).toMatchObject([
      { content: 'Preparar reunión', sendAt: '2026-10-11T21:00:00.000Z' },
      { content: 'Enviar informe', sendAt: '2026-10-12T14:00:00.000Z' },
    ]);
    expect(result.conversation).not.toHaveProperty('pending');
  });
  it.each(dateKinds)('rejects missing known %s facts before every sibling dispatch', async missing => {
    const s = setup([response([decide({ ready: [{ key: 'meeting', tool: 'reminder_create' }],
      pending: { ...pending, missing, knownArguments: {} } }), meeting])]);
    const result = await s.runner.run(opening, context, undefined, s.journal);
    expect(result.uiPayload.notices).toContain('invalid_response'); expect(s.provider.requests).toHaveLength(1);
    expect(s.execute).not.toHaveBeenCalled(); expect(s.before).not.toHaveBeenCalled(); expect(s.after).not.toHaveBeenCalled();
    expect(s.store.snapshot()).toEqual([]); expect(s.store.operations).toEqual([]); expect(s.store.receipts).toEqual([]);
    expect(result.conversation).not.toHaveProperty('pending');
  });
  it.each(dateKinds)('bounds %s empty-ready/empty-facts correction without effects or pending persistence', async missing => {
    const invalid = response([decide({ ready: [], pending: { ...pending, missing, knownArguments: {} } })]);
    const s = setup([invalid, invalid, first()]);
    const result = await s.runner.run(opening, context, undefined, s.journal);
    expect(result.uiPayload.notices).toContain('invalid_response'); expect(s.provider.requests).toHaveLength(2);
    expect(s.execute).not.toHaveBeenCalled(); expect(s.before).not.toHaveBeenCalled(); expect(s.after).not.toHaveBeenCalled();
    expect(s.store.snapshot()).toEqual([]); expect(s.store.operations).toEqual([]); expect(s.store.receipts).toEqual([]);
    expect(result.conversation).not.toHaveProperty('pending');
  });
  it.each(['content', 'hour', 'minute', 'hour-low', 'hour-high', 'minute-low', 'minute-high'])('rejects incomplete or invalid known reminder facts: %s', async field => {
    const facts = structuredClone(pending.knownArguments) as JsonObject;
    const clock = facts.relativeDayTime as JsonObject;
    if (field === 'content') delete facts.content;
    else if (field === 'hour' || field === 'minute') delete clock[field];
    else clock[field.startsWith('hour') ? 'hour' : 'minute'] = field.endsWith('low') ? -1 : field.startsWith('hour') ? 24 : 60;
    const invalid = response([decide({ ready: [], pending: { ...pending, knownArguments: facts } })]);
    const s = setup([invalid, invalid]);
    const result = await s.runner.run(opening, context, undefined, s.journal);
    expect(result.uiPayload.notices).toContain('invalid_response'); expect(s.provider.requests).toHaveLength(2);
    expect(s.before).not.toHaveBeenCalled(); expect(s.after).not.toHaveBeenCalled(); expect(s.execute).not.toHaveBeenCalled();
    expect(s.store.snapshot()).toEqual([]); expect(s.store.operations).toEqual([]); expect(s.store.receipts).toEqual([]);
    expect(result.conversation).not.toHaveProperty('pending');
  });
  it.each([{ hour: 0, minute: 0 }, { hour: 23, minute: 59 }])('preserves valid known clock boundary %j without executing pending metadata', async clock => {
    const facts = { content: 'Enviar informe', relativeDayTime: clock };
    const s = setup([response([decide({ ready: [], pending: { ...pending, knownArguments: facts } })])]);
    const result = await s.runner.run(opening, context, undefined, s.journal);
    expect(result.uiPayload.notices).toEqual([]); expect(result.conversation.pending?.knownArguments).toEqual(facts);
    expect(s.provider.requests).toHaveLength(1); expect(s.execute).not.toHaveBeenCalled();
    expect(s.before).not.toHaveBeenCalled(); expect(s.after).not.toHaveBeenCalled();
    expect(s.store.snapshot()).toEqual([]); expect(s.store.operations).toEqual([]); expect(s.store.receipts).toEqual([]);
  });
  it.each(['model_steps', 'tool_calls'])('charges rejected controls and respects the existing %s ceiling', async limit => {
    const bad = response([decide({ ready: [{ key: 'meeting', tool: 'reminder_create' }], pending: { ...pending, knownArguments: {} } })]);
    const declaration = response([decide({ ready: [{ key: 'meeting', tool: 'reminder_create' }], pending })]);
    const s = setup([bad, declaration, response([meeting])], true, createSyntheticReminders(),
      limit === 'model_steps' ? { maxModelSteps: 2 } : { maxToolCalls: 2 });
    const result = await s.runner.run(opening, context, undefined, s.journal);
    expect(result.uiPayload.notices).toContain('limit_reached');
    expect(s.provider.requests).toHaveLength(limit === 'model_steps' ? 2 : 3);
    expect(s.execute).not.toHaveBeenCalled(); expect(s.before).not.toHaveBeenCalled(); expect(s.after).not.toHaveBeenCalled();
    expect(s.store.snapshot()).toEqual([]); expect(s.store.operations).toEqual([]); expect(s.store.receipts).toEqual([]);
    expect(result.conversation).not.toHaveProperty('pending');
  });
  it('does not replay a verified sibling during a fresh execution correction', async () => {
    const q = response(); q.message.content = 'Listo.';
    const s = setup([response([decide({ ready: [{ key: 'meeting', tool: 'reminder_create' }, { key: 'report', tool: 'reminder_create' }] })]),
      response([meeting]), q, response([meeting])]);
    const result = await s.runner.run('Reunión hoy16:00 e informe mañana09:00', context, undefined, s.journal);
    expect(result.uiPayload.notices).toContain('invalid_response'); expect(s.provider.requests).toHaveLength(4);
    expect(s.execute).toHaveBeenCalledTimes(1); expect(s.before).toHaveBeenCalledTimes(1); expect(s.after).toHaveBeenCalledTimes(1);
    expect(s.store.operations).toHaveLength(1); expect(s.store.receipts).toHaveLength(1);
    expect(s.store.snapshot()).toMatchObject([{ content: 'Preparar reunión', sendAt: '2026-10-11T21:00:00.000Z' }]);
    const hint = s.provider.requests[3]!.tools.find(tool => tool.name === 'reminder_create')!.description;
    expect(hint).toContain('remaining keys: report'); expect(hint).not.toContain('remaining keys: meeting');
  });
  it.each(dateKinds)('does not postpone declared ready work behind a %s question', async missing => {
    const q = response(); q.message.content = '¿Confirmamos?';
    const s = setup([response([decide({ ready: [{ key: 'meeting', tool: 'reminder_create' }], pending: { ...pending, missing } })]), q, q]);
    const result = await s.runner.run(opening, context, undefined, s.journal);
    expect(result.conversationReply).toBeNull(); expect(result.uiPayload.notices).toContain('invalid_response');
    expect(s.execute).not.toHaveBeenCalled(); expect(s.before).not.toHaveBeenCalled();
    expect(s.store.snapshot()).toEqual([]); expect(s.store.receipts).toEqual([]);
  });
  it('rejects an undeclared sibling before any dispatch, journal or receipt', async () => {
    const extra = { ...meeting, id: 'extra', arguments: { ...meeting.arguments, decisionItem: 'extra' } };
    const s = setup([response([decide({ ready: [{ key: 'meeting', tool: 'reminder_create' }] }), meeting, extra])]);
    const result = await s.runner.run(opening, context, undefined, s.journal);
    expect(result.uiPayload.notices).toContain('invalid_response');
    expect(s.execute).not.toHaveBeenCalled(); expect(s.before).not.toHaveBeenCalled(); expect(s.after).not.toHaveBeenCalled();
    expect(s.store.snapshot()).toEqual([]); expect(s.store.receipts).toEqual([]);
  });
  it('does not grant authority from the decision or pending state', async () => {
    const s = setup([first()], false);
    const result = await s.runner.run(opening, context, undefined, s.journal);
    expect(s.execute).not.toHaveBeenCalled(); expect(s.before).not.toHaveBeenCalled();
    expect(result.uiPayload.items).toMatchObject([{ status: 'approval_required' }]);
    expect(result.conversation).not.toHaveProperty('pending'); expect(s.store.receipts).toEqual([]);
  });
  it('allows typed pure conversation without effects and without inventing a pending item', async () => {
    const s = setup([response([decide({ ready: [], reply: 'Hola, ¿cómo estás?' })])]);
    const result = await s.runner.run('Hola', context, undefined, s.journal);
    expect(result.conversationReply).toBe('Hola, ¿cómo estás?'); expect(result.uiPayload.notices).toEqual([]);
    expect(result.uiPayload.items).toEqual([]); expect(s.execute).not.toHaveBeenCalled(); expect(s.before).not.toHaveBeenCalled();
    expect(result.conversation).not.toHaveProperty('pending');
  });
  it('preserves valid current legacy tool calls without inventing a plan or requiring new metadata', async () => {
    const s = setup([response([{ ...meeting, arguments: { content: 'Preparar reunión', relativeDayTime: { day: 'today', hour: 16, minute: 0 }, turnDisposition: 'finish' } }])]);
    const result = await s.runner.run('Recuérdame preparar reunión hoy a las4PM', context, undefined, s.journal);
    expect(result.uiPayload.notices).toEqual([]); expect(s.execute).toHaveBeenCalledTimes(1);
    expect(result.uiPayload.items).toMatchObject([{ status: 'success' }]);
    expect(s.store.snapshot()).toMatchObject([{ sendAt: '2026-10-11T21:00:00.000Z' }]);
    expect(result.conversation).not.toHaveProperty('pending');
  });
  it('does not permit the legacy bridge to bypass a required decision after initial prose was rejected', async () => {
    const q = response(); q.message.content = '¿Confirmamos ambos?';
    const s = setup([q, response([{ ...meeting, arguments: { content: 'Preparar reunión', relativeDayTime: { day: 'today', hour: 16, minute: 0 } } }])]);
    const result = await s.runner.run(opening, context, undefined, s.journal);
    expect(result.uiPayload.notices).toContain('invalid_response'); expect(result.conversationReply).toBeNull();
    expect(s.execute).not.toHaveBeenCalled(); expect(s.before).not.toHaveBeenCalled(); expect(s.store.receipts).toEqual([]);
  });
  it('preserves read continuation for requested analysis instead of prematurely closing with cards', async () => {
    const analysis = response(); analysis.message.content = 'Podés enfocarte en preparar la reunión.';
    const s = setup([response([{ id: 'select', name: 'tools_select', arguments: { name: 'reminder_read' } }]),
      response([decide({ ready: [{ key: 'read', tool: 'reminder_read' }] }),
        { id: 'read', name: 'reminder_read', arguments: { decisionItem: 'read', filter: 'today', turnDisposition: 'continue' } }]), analysis]);
    const result = await s.runner.run('Lee mis recordatorios y ayudame a priorizar el día', context, undefined, s.journal);
    expect(result.conversationReply).toBe(analysis.message.content);
    expect(s.provider.requests).toHaveLength(3); expect(result.uiPayload.notices).toEqual([]);
    expect(s.store.operations).toMatchObject([{ request: { operation: 'read' }, wrote: false }]);
    expect(s.store.snapshot()).toEqual([]); expect(s.store.receipts).toHaveLength(1);
    expect(result.uiPayload.items).toMatchObject([{ toolName: 'reminder_read', status: 'success' }]);
  });
  it('preserves pending through unrelated conversation and replaces it only with a new typed clarification', async () => {
    const s = setup([first()]); const a = await s.runner.run(opening, context, undefined, s.journal);
    const b = setup([response([decide({ ready: [], reply: 'De nada.' })])], true, s.store);
    const unrelated = await b.runner.run('Gracias', { ...context, requestId: 'thanks' }, a.conversation, b.journal);
    expect(unrelated.conversation.pending).toEqual(a.conversation.pending);
    expect(b.execute).not.toHaveBeenCalled(); expect(b.before).not.toHaveBeenCalled(); expect(b.after).not.toHaveBeenCalled();
    const newer = { tool: 'reminder_create', missing: 'time', knownArguments: { content: 'Otra cosa' } };
    const c = setup([response([decide({ ready: [], pending: newer })])], true, s.store);
    const replaced = await c.runner.run('Otro recordatorio, no sé a qué hora', { ...context, requestId: 'new-pending' }, unrelated.conversation, c.journal);
    expect(replaced.conversation.pending).toMatchObject({ ...newer, userId: context.userId, sourceRequestId: 'new-pending' });
    expect(replaced.conversation.pending!.id).not.toBe(a.conversation.pending!.id);
    expect(c.execute).not.toHaveBeenCalled(); expect(c.before).not.toHaveBeenCalled(); expect(s.store.operations).toHaveLength(1);
  });
  it('rejects foreign pending ownership and abort before any request, journal or effect', async () => {
    const a = setup([first()]); const prior = await a.runner.run(opening, context, undefined, a.journal);
    const s = setup([first()]);
    await expect(s.runner.run('mañana', { ...context, requestId: 'answer' }, { ...prior.conversation,
      pending: { ...prior.conversation.pending!, userId: 'foreign' } }, s.journal)).rejects.toThrow();
    const controller = new AbortController(); controller.abort();
    await expect(s.runner.run('mañana', { ...context, requestId: 'answer', signal: controller.signal }, prior.conversation, s.journal)).rejects.toThrow();
    expect(s.provider.requests).toEqual([]); expect(s.execute).not.toHaveBeenCalled(); expect(s.before).not.toHaveBeenCalled();
    expect(s.store.operations).toEqual([]); expect(s.store.receipts).toEqual([]);
  });
  it('does not save pending or certify declared work after an uncertain outcome', async () => {
    const s = setup([first()]); s.execute.mockImplementation(async () => { throw new Error('unknown effect'); });
    const result = await s.runner.run(opening, context, undefined, s.journal);
    expect(result.requiresReconciliation).toBe(true); expect(result.uiPayload.items).toMatchObject([{ status: 'indeterminate' }]);
    expect(result.conversation).not.toHaveProperty('pending'); expect(result.uiPayload).not.toHaveProperty('clarification');
    expect(s.before).toHaveBeenCalledTimes(1); expect(s.after).toHaveBeenCalledTimes(1);
    expect(s.store.operations).toEqual([]); expect(s.store.receipts).toEqual([]);
  });
  it.each(['unknown-tool', 'duplicate-key', 'excess-facts'])('rejects malformed %s decision before all sibling effects', async kind => {
    const args: JsonObject = { ready: [{ key: 'meeting', tool: kind === 'unknown-tool' ? 'not_authorized' : 'reminder_create' }] };
    if (kind === 'duplicate-key') args.ready = [{ key: 'meeting', tool: 'reminder_create' }, { key: 'meeting', tool: 'reminder_create' }];
    if (kind === 'excess-facts') args.pending = { ...pending, knownArguments: { content: 'x'.repeat(1001) } };
    const s = setup([response([decide(args), meeting])]);
    const result = await s.runner.run(opening, context, undefined, s.journal);
    expect(result.uiPayload.notices).toContain('invalid_response'); expect(s.execute).not.toHaveBeenCalled();
    expect(s.before).not.toHaveBeenCalled(); expect(s.after).not.toHaveBeenCalled(); expect(s.store.receipts).toEqual([]);
  });
  it.each(dateKinds.flatMap(missing => ['content', 'hour', 'minute', 'recurrence', 'delivery', 'drop-clock'].map(change => ({ missing, change }))))(
    'preserves %s known arguments and permits only filling the missing date', async ({ missing, change }) => {
      const a = setup([first(missing)]); const prior = await a.runner.run(opening, context, undefined, a.journal);
      const args: JsonObject = { decisionItem: 'report', content: 'Enviar informe', relativeDayTime: { day: 'tomorrow', hour: 9, minute: 0 } };
      if (change === 'content') args.content = 'Otra cosa';
      else if (change === 'hour' || change === 'minute') (args.relativeDayTime as JsonObject)[change] = change === 'hour' ? 10 : 1;
      else if (change === 'recurrence') args.recurrence = 'daily';
      else if (change === 'delivery') args.requiresConfirmation = true;
      else delete args.relativeDayTime;
      const s = setup([response([decide({ ready: [{ key: 'report', tool: 'reminder_create' }], resolution: { pendingId: prior.conversation.pending!.id, key: 'report' } }),
        { id: 'report', name: 'reminder_create', arguments: args }])], true, a.store);
      const before = a.store.snapshot();
      const result = await s.runner.run('mañana', { ...context, requestId: 'answer' }, JSON.parse(JSON.stringify(prior.conversation)), s.journal);
      expect(result.uiPayload.notices).toContain('invalid_response'); expect(result.conversation.pending).toEqual(prior.conversation.pending);
      expect(s.execute).not.toHaveBeenCalled(); expect(s.before).not.toHaveBeenCalled(); expect(s.after).not.toHaveBeenCalled();
      expect(s.store.snapshot()).toEqual(before); expect(s.store.operations).toHaveLength(1); expect(s.store.receipts).toHaveLength(1);
    });
  it('does not roll a known relative day forward after a restart on another local date', async () => {
    const a = setup([response([decide({ ready: [], pending: { tool: 'reminder_create', missing: 'time',
      knownArguments: { content: 'Revisión', relativeDayTime: { day: 'tomorrow' } } } })])]);
    const prior = await a.runner.run('Recuérdame la revisión mañana, no sé a qué hora', context, undefined, a.journal);
    const s = setup([response([decide({ ready: [{ key: 'review', tool: 'reminder_create' }], resolution: { pendingId: prior.conversation.pending!.id, key: 'review' } }),
      { id: 'review', name: 'reminder_create', arguments: { decisionItem: 'review', content: 'Revisión', relativeDayTime: { day: 'tomorrow', hour: 9, minute: 0 } } }])]);
    const result = await s.runner.run('A las9AM', { ...context, requestId: 'later', referenceTimeIso: '2026-10-12T17:49:00Z' },
      JSON.parse(JSON.stringify(prior.conversation)), s.journal);
    expect(result.uiPayload.notices).toContain('invalid_response'); expect(result.conversation.pending).toEqual(prior.conversation.pending);
    expect(s.execute).not.toHaveBeenCalled(); expect(s.before).not.toHaveBeenCalled(); expect(s.store.receipts).toEqual([]);
  });
  it('does not move the unresolved today-or-tomorrow choice after a local-day boundary', async () => {
    const a = setup([first()]); const prior = await a.runner.run(opening, context, undefined, a.journal);
    const s = setup([response([decide({ ready: [{ key: 'report', tool: 'reminder_create' }], resolution: { pendingId: prior.conversation.pending!.id, key: 'report' } }),
      { id: 'report', name: 'reminder_create', arguments: { decisionItem: 'report', content: 'Enviar informe', relativeDayTime: { day: 'tomorrow', hour: 9, minute: 0 } } }])]);
    const result = await s.runner.run('mañana', { ...context, requestId: 'later-date', referenceTimeIso: '2026-10-12T17:49:00Z' },
      JSON.parse(JSON.stringify(prior.conversation)), s.journal);
    expect(result.uiPayload.notices).toContain('invalid_response'); expect(result.conversation.pending).toEqual(prior.conversation.pending);
    expect(s.execute).not.toHaveBeenCalled(); expect(s.before).not.toHaveBeenCalled(); expect(s.after).not.toHaveBeenCalled();
    expect(s.store.snapshot()).toEqual([]); expect(s.store.receipts).toEqual([]);
  });
  it('does not re-expose forgotten memory content through persisted pending facts', async () => {
    const a = setup([first()]); const prior = await a.runner.run(opening, context, undefined, a.journal);
    const s = setup([response([decide({ ready: [], reply: 'De nada.' })])]);
    const result = await s.runner.run('Gracias', { ...context, requestId: 'thanks' }, { ...prior.conversation,
      memories: [{ id: '33333333-3333-4333-8333-333333333333', content: 'Enviar informe', category: 'fact', topicKey: null, status: 'forgotten' }] }, s.journal);
    expect(JSON.stringify(s.provider.requests[0]!.messages)).not.toContain('Enviar informe');
    expect(result.conversation.pending).toEqual(prior.conversation.pending); expect(s.execute).not.toHaveBeenCalled();
  });
  it.each(['stale', 'conflicting'])('rejects %s pending resolution without any effects', async kind => {
    const a = setup([first()]); const prior = await a.runner.run(opening, context, undefined, a.journal);
    const p = (prior.conversation as ProductivityConversation & { pending?: { id: string } }).pending;
    const s = setup([response([decide({ ready: [{ key: 'report', tool: 'reminder_create' }], resolution: { pendingId: kind === 'stale' ? 'stale' : p!.id, key: 'report' } }),
      { id: 'report', name: 'reminder_create', arguments: { decisionItem: 'report', content: 'Enviar informe', relativeDayTime: { day: 'tomorrow', hour: kind === 'conflicting' ? 21 : 9, minute: 0 } } }])]);
    const result = await s.runner.run('mañana', { ...context, requestId: 'answer' }, prior.conversation, s.journal);
    expect(result.uiPayload.notices).toContain('invalid_response'); expect(result.conversationReply).toBeNull();
    expect(s.execute).not.toHaveBeenCalled(); expect(s.before).not.toHaveBeenCalled(); expect(s.after).not.toHaveBeenCalled();
    expect(s.store.snapshot()).toEqual([]); expect(s.store.receipts).toEqual([]);
    expect((result.conversation as typeof prior.conversation & { pending?: unknown }).pending).toEqual(p);
  });
});
