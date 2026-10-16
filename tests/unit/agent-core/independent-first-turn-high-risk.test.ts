import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { MockAIProvider } from '@templelabs/ai';
import { ProductivityTurnRunner, type ProductivityExecutionJournal } from '@templelabs/agent-core';
import { productivityCheckpointSchema, productivityConversationSchema, type AIResponse, type JsonObject, type ToolCall, type TurnContext, type ProductivityConversation } from '@templelabs/contracts';
import { createReminderTools, ToolRegistry } from '@templelabs/tools';
import { createSyntheticReminders } from '../../../scripts/evals/v2-fluent-conversation.js';
import { productivityBudget, productivityDecisionPolicy } from '../../../src/adapters/agent-core/productivity-budget.js';
import { DurableProductivityAssistant } from '../../../src/adapters/agent-core/durable-productivity-assistant.js';
import { recoverProductivityStoredTurn } from '../../../src/adapters/agent-core/productivity-state-recovery.js';
import { withTurnLease, type InboundTurnLease } from '../../../src/agent/core/turn-lease.js';

// Independent S1-S5 public-API probes: only domain storage and transport are synthetic.
const opening = 'Recuérdame preparar reunión hoy a las 4 PM y enviar informe a las 9 AM, pero no sé si hoy o mañana';
const ctx: TurnContext = { userId: 'fluent-eval-synthetic-owner', runId: 'probe-run', requestId: 'probe-request', language: 'es', timezone: 'America/Bogota', referenceTimeIso: '2026-10-11T17:49:00Z', signal: new AbortController().signal, capabilities: new Set(['reminders.create', 'reminders.read']) };
const call = (name: string, args: JsonObject, id = name): ToolCall => ({ id, name, arguments: args });
const plan = (args: JsonObject) => call('conversation_decide', args);
const pending: JsonObject = { tool: 'reminder_create', missing: 'today_or_tomorrow', knownArguments: { content: 'Enviar informe', relativeDayTime: { hour: 9, minute: 0 } } };
const proposal = (key = 'meeting', extra: JsonObject = {}) => call('reminder_create', { decisionItem: key, content: key === 'meeting' ? 'Preparar reunión' : 'Enviar informe', relativeDayTime: { day: key === 'meeting' ? 'today' : 'tomorrow', hour: key === 'meeting' ? 16 : 9, minute: 0 }, turnDisposition: 'finish', ...extra }, key);
const answer = (...calls: ToolCall[]): AIResponse => ({ message: { role: 'assistant', content: '', toolCalls: calls }, stopReason: calls.length ? 'tool_calls' : 'completed', usage: { inputTokens: 30, outputTokens: 10 } });
const initial = () => answer(plan({ ready: [{ key: 'meeting', tool: 'reminder_create' }], pending }), proposal());
function setup(responses: AIResponse[], store = createSyntheticReminders(), overrides = {}) {
  const provider = new MockAIProvider(responses.map(response => ({ response })));
  const execute = vi.fn(store.execute);
  const runner = new ProductivityTurnRunner(provider, new ToolRegistry(createReminderTools({ execute })), { ...productivityBudget, ...productivityDecisionPolicy, continuation: 'observation_driven', discoverTools: true, compactObservations: true, estimateInputTokens: () => 100, authorizeWrite: async () => true, ...overrides });
  const journal = { beforeDispatch: vi.fn<ProductivityExecutionJournal['beforeDispatch']>(async () => {}), afterOutcome: vi.fn<ProductivityExecutionJournal['afterOutcome']>(async () => {}) };
  return { provider, execute, runner, store, journal };
}
const hash = (x: unknown) => createHash('sha256').update(JSON.stringify(x)).digest('hex');
const data = (s: ReturnType<typeof setup>) => ({ records: s.store.snapshot(), operations: s.store.operations, receipts: s.store.receipts });
async function seed() { const s = setup([initial()]); const r = await s.runner.run(opening, ctx, undefined, s.journal); return { ...s, r }; }
const resolution = (id: string, extra: JsonObject = {}) => answer(plan({ ready: [{ key: 'report', tool: 'reminder_create' }], resolution: { pendingId: id, key: 'report' } }), proposal('report', extra));
function untouched(s: ReturnType<typeof setup>, before: string) {
  expect(hash(data(s))).toBe(before); expect(s.execute).not.toHaveBeenCalled();
  expect(s.journal.beforeDispatch).not.toHaveBeenCalled(); expect(s.journal.afterOutcome).not.toHaveBeenCalled();
}
async function durable(s: ReturnType<typeof setup>, text: string, context: TurnContext, previous?: ProductivityConversation, failDelivery = false) {
  const patches: JsonObject[] = []; const sent: unknown[] = [];
  const lease: InboundTurnLease = { inboundTurn: { id: context.runId, messageId: context.requestId, threadId: 'probe-thread', response: {} }, signal: context.signal, assertActive: async () => {}, checkpoint: async patch => { patches.push(structuredClone(patch)); } };
  const assistant = new DurableProductivityAssistant(s.runner, { send: async message => { sent.push(structuredClone(message)); if (failDelivery) throw new Error('synthetic delivery uncertainty'); return { messageId: 'synthetic-acceptance' }; } });
  let error: unknown; let result;
  try { result = await withTurnLease(lease, () => assistant.handle(text, context, 'probe-thread', previous)); } catch (e) { error = e; }
  const checkpoint = productivityCheckpointSchema.parse(JSON.parse(JSON.stringify(patches.at(-1)!.agentCoreProductivity)));
  return { result, error, patches, checkpoint, sent };
}
function row(checkpoint: unknown, context = ctx) { return { id: context.runId, message_id: context.requestId, thread_id: 'probe-thread', sequence_id: 1, status: 'completed', response: { agentCoreProductivity: checkpoint } }; }

describe('independent first-turn high-risk specification probes', () => {
  it('S2/S3 exact two turns cross actual durable JSON/recovery and all evidence agrees', async () => {
    const a = setup([initial()]); const first = await durable(a, opening, ctx);
    expect(first.error).toBeUndefined(); expect(first.checkpoint.phase).toBe('completed');
    expect(first.checkpoint.effects).toHaveLength(1); expect(first.checkpoint.effects[0]!.call!.arguments).not.toHaveProperty('decisionItem');
    expect(first.checkpoint.effects[0]!.item).toMatchObject({ result: { records: [{ content: 'Preparar reunión', sendAt: '2026-10-11T21:00:00.000Z' }] } });
    expect(a.store.receipts).toHaveLength(1); expect(first.sent).toHaveLength(1);
    const old = hash(a.store.snapshot()[0]);
    const reload = recoverProductivityStoredTurn(JSON.parse(JSON.stringify(row(first.checkpoint))), ctx.userId);
    expect(reload.pending).toMatchObject({ userId: ctx.userId, sourceRequestId: ctx.requestId, sourceContext: { referenceTimeIso: ctx.referenceTimeIso, timezone: ctx.timezone }, knownArguments: pending.knownArguments });
    expect(first.result!.reply.text).toContain('¿El recordatorio pendiente es para hoy o para mañana?');
    expect(reload.history.at(-1)!.content).toBe(first.result!.reply.text);
    const b = setup([resolution(reload.pending!.id)], a.store);
    const secondContext = { ...ctx, runId: 'answer-run', requestId: 'answer-request' };
    const second = await durable(b, 'mañana', secondContext, reload);
    expect(second.error).toBeUndefined(); expect(second.checkpoint.phase).toBe('completed');
    expect(second.checkpoint.completed!.conversation).not.toHaveProperty('pending');
    expect(second.checkpoint.effects).toHaveLength(1); expect(second.checkpoint.effects[0]!.item).toMatchObject({ result: { records: [{ content: 'Enviar informe', sendAt: '2026-10-12T14:00:00.000Z' }] } });
    expect(hash(a.store.snapshot()[0])).toBe(old); expect(a.store.operations).toHaveLength(2); expect(a.store.receipts).toHaveLength(2);
    expect(a.store.snapshot().map(r => r.sendAt)).toEqual(['2026-10-11T21:00:00.000Z', '2026-10-12T14:00:00.000Z']);
    expect(second.checkpoint.completed!.reply.text).toBe(second.result!.reply.text);
    expect(second.checkpoint.completed!.conversation.history.at(-1)!.content).toBe(second.result!.reply.text);
    expect(second.checkpoint.deliveries.every(x => x.status === 'accepted')).toBe(true);
    expect(recoverProductivityStoredTurn(row(second.checkpoint, secondContext), ctx.userId)).toEqual(second.result!.conversation);
  });
  it.each(['duplicate-key', 'duplicate-action', 'undeclared-sibling', 'empty', 'eleven', 'oversized', 'unavailable', 'unknown-field'])('S4 whole-batch admission: %s leaves domain bytes/counters unchanged', async variant => {
    const ready = [{ key: 'meeting', tool: 'reminder_create' }]; const args: JsonObject = { ready };
    const actions = [proposal()];
    if (variant === 'duplicate-key') ready.push({ ...ready[0]! });
    if (variant === 'duplicate-action') actions.push({ ...proposal(), id: 'second' });
    if (variant === 'undeclared-sibling') actions.push(proposal('other'));
    if (variant === 'empty') args.ready = [];
    if (variant === 'eleven') args.ready = Array.from({ length: 11 }, (_, i) => ({ key: `k${i}`, tool: 'reminder_create' }));
    if (variant === 'oversized') args.pending = { ...pending, knownArguments: { content: 'x'.repeat(1001) } };
    if (variant === 'unavailable') ready[0]!.tool = 'calendar_create';
    if (variant === 'unknown-field') args.ignored = true;
    const s = setup([answer(plan(args), ...actions)]); const before = hash(data(s));
    const r = await s.runner.run(opening, ctx, undefined, s.journal);
    expect(r.uiPayload.notices).toEqual(['invalid_response']); expect(r.conversationReply).toBeNull(); untouched(s, before);
  });
  it('S4 declared outstanding work cannot close via prose or pending', async () => {
    const premature = { ...answer(), message: { role: 'assistant' as const, content: 'Todo listo', toolCalls: [] } };
    const s = setup([answer(plan({ ready: [{ key: 'meeting', tool: 'reminder_create' }], pending })), premature, premature]);
    const before = hash(data(s)); const r = await s.runner.run(opening, ctx, undefined, s.journal);
    expect(r.uiPayload.notices).toContain('invalid_response'); expect(r.conversationReply).toBeNull(); expect(r.conversation).not.toHaveProperty('pending');
    expect(s.provider.requests).toHaveLength(3); untouched(s, before);
  });
  it.each(['stale-id', 'wrong-tool', 'content', 'clock', 'recurrence', 'new-flag', 'timezone', 'local-day', 'source-less'])('S2/S4 resolution %s cannot dispatch and preserves stored facts byte-for-byte', async variant => {
    const a = await seed(); const previous = productivityConversationSchema.parse(JSON.parse(JSON.stringify(a.r.conversation)));
    if (variant === 'source-less') delete previous.pending!.sourceContext;
    let script = resolution(variant === 'stale-id' ? 'old-pending-id' : previous.pending!.id,
      variant === 'content' ? { content: 'Otra cosa' } : variant === 'clock' ? { relativeDayTime: { day: 'tomorrow', hour: 10, minute: 0 } } : variant === 'recurrence' ? { recurrence: 'daily' } : variant === 'new-flag' ? { requiresConfirmation: true } : {});
    if (variant === 'wrong-tool') script = answer(plan({ ready: [{ key: 'report', tool: 'reminder_read' }], resolution: { pendingId: previous.pending!.id, key: 'report' } }), call('reminder_read', { decisionItem: 'report', filter: 'today', turnDisposition: 'finish' }));
    const s = setup([script], a.store); const before = hash(data(s)); const facts = hash(previous);
    const context = { ...ctx, requestId: 'rejected', ...(variant === 'timezone' ? { timezone: 'America/New_York' } : {}), ...(variant === 'local-day' ? { referenceTimeIso: '2026-10-12T05:00:00Z' } : {}) };
    const r = await s.runner.run('mañana', context, previous, s.journal);
    expect(r.uiPayload.notices).toEqual(['invalid_response']); expect(hash(previous)).toBe(facts); expect(r.conversation.pending).toEqual(previous.pending); untouched(s, before);
  });
  it('S2/S4 keeps same local date across UTC midnight, then consumes exact pending only', async () => {
    const a = await seed(); const prior = a.r.conversation;
    prior.pending!.sourceContext!.referenceTimeIso = '2026-10-11T23:59:00Z';
    const s = setup([resolution(prior.pending!.id)], a.store);
    const r = await s.runner.run('mañana', { ...ctx, requestId: 'after-utc-midnight', referenceTimeIso: '2026-10-12T00:01:00Z' }, prior, s.journal);
    expect(r.uiPayload.notices).toEqual([]); expect(r.conversation).not.toHaveProperty('pending'); expect(a.store.snapshot()[1]!.sendAt).toBe('2026-10-12T14:00:00.000Z');
  });
  it.each(['owner', 'capability', 'approval', 'no-journal', 'abort'])('S4 authority %s remains independent of typed plan', async variant => {
    const a = await seed(); const previous = structuredClone(a.r.conversation);
    if (variant === 'owner') previous.pending!.userId = 'another-owner';
    const s = setup([resolution(previous.pending!.id)], a.store, variant === 'approval' ? { authorizeWrite: async () => false } : {});
    const before = hash(data(s)); const controller = new AbortController(); if (variant === 'abort') controller.abort();
    const context = { ...ctx, requestId: 'guard', signal: controller.signal, ...(variant === 'capability' ? { capabilities: new Set(['reminders.read']) } : {}) };
    const run = s.runner.run('mañana', context, previous, variant === 'no-journal' ? undefined : s.journal);
    if (variant === 'owner') await expect(run).rejects.toThrow(); else if (variant === 'abort') await expect(run).rejects.toThrow(); else { const r = await run; expect(r.conversation.pending).toEqual(previous.pending); expect(r.uiPayload.items.every(item => item.status !== 'success')).toBe(true); }
    if (variant === 'approval') { expect(hash(data(s))).toBe(before); expect(s.execute).not.toHaveBeenCalled(); expect(s.journal.beforeDispatch).not.toHaveBeenCalled(); expect(s.journal.afterOutcome).toHaveBeenCalledTimes(1); expect(s.journal.afterOutcome.mock.calls[0]![1]).toMatchObject({ status: 'approval_required', code: 'USER_AUTHORIZATION_REQUIRED' }); } else untouched(s, before); if (['owner', 'abort'].includes(variant)) expect(s.provider.requests).toHaveLength(0);
  });
  it('S2 unrelated reply preserves pending, replacement changes identity, historical ready work never replays', async () => {
    const a = await seed(); const s = setup([answer(plan({ ready: [], reply: 'Con gusto.' }))], a.store); const before = hash(data(s));
    const r = await s.runner.run('Gracias', { ...ctx, requestId: 'thanks' }, a.r.conversation, s.journal);
    expect(r.conversationReply).toBe('Con gusto.'); expect(r.conversation.pending).toEqual(a.r.conversation.pending); untouched(s, before);
    const b = setup([answer(plan({ ready: [], pending: { tool: 'reminder_create', missing: 'time', knownArguments: { content: 'Llamar a Ana' } } }))], a.store);
    const replaced = await b.runner.run('Recuérdame llamar a Ana; falta la hora', { ...ctx, requestId: 'replace' }, r.conversation, b.journal);
    expect(replaced.conversation.pending!.id).not.toBe(r.conversation.pending!.id); expect(replaced.conversation.pending!.sourceRequestId).toBe('replace'); untouched(b, before);
    const c = setup([resolution(r.conversation.pending!.id)], a.store); const rejected = await c.runner.run('mañana', { ...ctx, requestId: 'obsolete' }, replaced.conversation, c.journal);
    expect(rejected.uiPayload.notices).toEqual(['invalid_response']); untouched(c, before);
  });
  it('S4 forgotten facts are hidden in all prompt messages but not rewritten in durable data', async () => {
    const a = await seed(); const previous = structuredClone(a.r.conversation);
    previous.memories = [{ id: '33333333-3333-4333-8333-333333333333', content: 'Enviar informe', category: 'fact', topicKey: null, status: 'forgotten' }];
    const s = setup([answer(plan({ ready: [], reply: 'Hola.' }))], a.store); const before = hash(data(s)); const stateHash = hash(previous);
    const r = await s.runner.run('Hola', { ...ctx, requestId: 'privacy' }, previous, s.journal);
    expect(JSON.stringify(s.provider.requests)).not.toContain('Enviar informe'); expect(r.conversation.pending).toEqual(previous.pending); expect(hash(previous)).toBe(stateHash); untouched(s, before);
  });
  it('S4 read plus analysis survives phase-scoped controls and legacy JSON without pending', async () => {
    const prose = { ...answer(), message: { role: 'assistant' as const, content: 'No hay pendientes; podés concentrarte en tu proyecto.', toolCalls: [] } };
    const s = setup([answer(call('tools_select', { name: 'reminder_read' })), answer(plan({ ready: [{ key: 'read', tool: 'reminder_read' }] }), call('reminder_read', { decisionItem: 'read', filter: 'today', turnDisposition: 'continue' })), prose]);
    const old = productivityConversationSchema.parse(JSON.parse(JSON.stringify({ userId: ctx.userId, history: [{ role: 'user', content: 'Hola' }, { role: 'assistant', content: 'Hola', toolCalls: [] }], reminders: [], tasks: [], events: [], handledRequestIds: ['old-request'] })));
    const r = await s.runner.run('Lee mis recordatorios y analizá el día', ctx, old, s.journal);
    expect(r.conversationReply).toBe(prose.message.content); expect(r.uiPayload.notices).toEqual([]); expect(s.store.snapshot()).toEqual([]); expect(s.store.operations).toHaveLength(1); expect(s.store.operations[0]!.wrote).toBe(false);
    expect(s.provider.requests[0]!.tools.some(t => t.name === 'conversation_decide')).toBe(true);
    expect(s.provider.requests[1]!.tools.some(t => t.name === 'conversation_decide')).toBe(false);
    expect(r.usage).toMatchObject({ modelSteps: 3, inputTokens: 90, outputTokens: 30, accountingComplete: true });
  });
  it('S4 uncertain effects cannot commit pending/consume it or produce certified closure', async () => {
    const a = await seed(); const s = setup([resolution(a.r.conversation.pending!.id)], a.store); const before = hash(data(s));
    s.execute.mockRejectedValue(new Error('synthetic unknown effect'));
    const r = await s.runner.run('mañana', { ...ctx, requestId: 'uncertain' }, a.r.conversation, s.journal);
    expect(r.requiresReconciliation).toBe(true); expect(r.conversation.pending).toEqual(a.r.conversation.pending); expect(r.uiPayload.items[0]!.status).toBe('indeterminate'); expect(r.uiPayload).not.toHaveProperty('clarification'); expect(hash(data(s))).toBe(before);
    expect(s.journal.beforeDispatch).toHaveBeenCalledTimes(1); expect(s.journal.afterOutcome).toHaveBeenCalledTimes(1);
    const t = setup([], a.store); await expect(t.runner.run('Hola', { ...ctx, requestId: 'blocked' }, r.conversation, t.journal)).rejects.toThrow('Prior effect requires reconciliation'); expect(t.provider.requests).toHaveLength(0);
  });
  it('S4 delivery unknown quarantines actual durable completion; recovery refuses it', async () => {
    const s = setup([initial()]); const d = await durable(s, opening, ctx, undefined, true);
    expect(d.error).toMatchObject({ code: 'DELIVERY_OUTCOME_UNKNOWN' }); expect(d.checkpoint.deliveries[0]!.status).toBe('unknown'); expect(d.checkpoint.phase).toBe('delivering'); expect(s.store.snapshot()).toHaveLength(1);
    await expect(async () => recoverProductivityStoredTurn(row(d.checkpoint), ctx.userId)).rejects.toThrow('Prior turn requires reconciliation or engine handoff');
  });
  it('S5 one no-effect correction is fresh/accounted and never replays rejected arguments', async () => {
    const prose = { ...answer(), message: { role: 'assistant' as const, content: '¿Para cuándo?', toolCalls: [] } };
    const s = setup([prose, initial()]); const r = await s.runner.run(opening, ctx, undefined, s.journal);
    expect(s.provider.requests).toHaveLength(2); expect(r.usage).toMatchObject({ modelSteps: 2, inputTokens: 60, outputTokens: 20, accountingComplete: true }); expect(s.store.operations).toHaveLength(1);
    const t = setup([prose, prose, initial()]); const before = hash(data(t)); const stopped = await t.runner.run(opening, ctx, undefined, t.journal);
    expect(t.provider.requests).toHaveLength(2); expect(stopped.uiPayload.notices).toEqual(['invalid_response']); untouched(t, before);
  });
  it.each([
    [{ targetTimeIso: '2026-10-11T21:00:00Z' }, '2026-10-11T21:00:00Z'],
    [{ delayMinutes: 15 }, '2026-10-11T18:04:00.000Z'],
    [{ unqualifiedLocalTime: { hour: 9, minute: 0 } }, '2026-10-12T02:00:00.000Z'],
  ])('S5 retains ISO/delay/bare-clock through active policy: %j', async (time, expected) => {
    const s = setup([answer(plan({ ready: [{ key: 'meeting', tool: 'reminder_create' }] }), call('reminder_create', { decisionItem: 'meeting', content: 'Preparar reunión', ...time, turnDisposition: 'finish' } as JsonObject))]);
    const r = await s.runner.run('Recuérdame preparar reunión', ctx, undefined, s.journal);
    expect(r.uiPayload.notices).toEqual([]); expect(s.store.snapshot()[0]!.sendAt).toBe(expected); expect(s.store.receipts).toHaveLength(1);
  });
  it.each([0, -1, 1.5])('S5 invalid delay %s does not execute rejected arguments', async delayMinutes => {
    const s = setup([answer(plan({ ready: [{ key: 'meeting', tool: 'reminder_create' }] }), call('reminder_create', { decisionItem: 'meeting', content: 'Preparar reunión', delayMinutes, turnDisposition: 'finish' }))]);
    const before = hash(data(s)); const r = await s.runner.run('Recuérdame preparar reunión', ctx, undefined, s.journal);
    expect(hash(data(s))).toBe(before); expect(s.execute).not.toHaveBeenCalled(); expect(r.uiPayload.items.every(i => i.status !== 'success')).toBe(true);
  });
  it('S5 exact active numeric caps, decision calls count toward unchanged tool/step limits', async () => {
    expect(productivityBudget).toMatchObject({ maxInputTokens: 2500, maxOutputTokens: 2048, maxModelSteps: 10, maxToolCalls: 10, maxTotalTokens: 20000 });
    const s = setup([initial()], undefined, { maxToolCalls: 1 }); const before = hash(data(s)); const r = await s.runner.run(opening, ctx, undefined, s.journal);
    expect(r.uiPayload.notices).toContain('limit_reached'); untouched(s, before);
  });
});
