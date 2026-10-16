import { describe, expect, it, vi } from 'vitest';
import { MockAIProvider, OpenRouterProvider, estimateBoundedInput } from '@templelabs/ai';
import type { CompletionRequest } from '@templelabs/ai';
import { aiTranscriptSchema, type AIMessage, type ProductivityConversation } from '@templelabs/contracts';
import { createReminderTools, createTaskTools, createCalendarTools, createMemoryTools, createAgendaTools, ToolRegistry, type ReminderDomainPort } from '@templelabs/tools';
import { ProductivityTurnRunner } from '../../../packages/agent-core/src/productivity-turn.js';
import type { AgentLoopOptions } from '../../../packages/agent-core/src/agent-loop.js';
import { productivityBudget } from '../../../src/adapters/agent-core/productivity-budget.js';
import { context, response } from './productivity-fixtures.js';

const records = Array.from({ length: 9 }, (_, index) => ({
  id: `22222222-2222-4222-8222-22222222222${index}`,
  content: `Recordatorio de prueba ${index + 1}`, status: 'pending' as const,
  sendAt: '2026-10-11T21:00:00Z', recurrence: 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR',
  isAdvanceNotice: false, parentReminderId: null, requiresConfirmation: false, acknowledgedAt: null,
}));
const view = records.slice(4);
const targets = [view[0]!, view[1]!, view[2]!, view[4]!];
const request = 'Elimina el 1, el 2, el 3 y el 5.';
const clarification = '¿Son recordatorios los que quieres eliminar?';
const ctx = { ...context, capabilities: new Set(['reminders.read', 'reminders.create', 'reminders.update', 'reminders.acknowledge', 'reminders.cancel',
  'tasks.read', 'tasks.create', 'tasks.update', 'tasks.complete', 'tasks.delete', 'calendar.read', 'calendar.create', 'calendar.update', 'calendar.delete', 'calendar.connect',
  'memories.read', 'memories.save', 'memories.forget', 'agenda.read']) };
function prior(challenging = false): ProductivityConversation {
  const history: AIMessage[] = [{ role: 'user', content: request },
    ...(challenging ? [{ role: 'assistant' as const, content: '', toolCalls: [{ id: 'old-read', name: 'reminder_read', arguments: {} }] },
      { role: 'tool' as const, toolCallId: 'old-read', isError: false, content: { status: 'success', observation: JSON.stringify({ operation: 'read', complete: true,
        records: Array.from({ length: 50 }, (_, index) => ({ ...records[0], id: `old-${index}`, content: 'Inventario anterior '.repeat(100) })) }) } }] : []),
    { role: 'assistant', content: clarification, toolCalls: [] }];
  return { userId: ctx.userId, history, reminders: structuredClone(records), tasks: [], events: [], handledRequestIds: [],
    referenceOrder: view.map((record, index) => ({ domain: 'reminders', id: record.id, position: index + 1 })) };
}
const select = (name: string) => response([{ id: 'select', name: 'tools_select', arguments: { name } }]);
const cancel = () => response(targets.map((record, index) => ({ id: `cancel-${index}`, name: 'reminder_cancel',
  arguments: { reminderId: record.id, ...(index === targets.length - 1 ? { turnDisposition: 'finish' } : {}) } })));
function harness(script: ReturnType<typeof response>[], options: AgentLoopOptions = {}) {
  const native = new OpenRouterProvider({ apiKey: 'fixture-key', routes: [{ id: 'offline', model: 'fixture/offline', providers: ['offline'], timeoutMs: 1000 }],
    fetch: vi.fn(async () => { throw new Error('Network forbidden'); }), estimateInputTokens: estimateBoundedInput, now: () => 100 });
  const estimate = (input: unknown) => native.estimateNativeInput(input as CompletionRequest);
  const provider = new MockAIProvider(script.map(response => ({ response })), () => 100);
  const execute = vi.fn<ReminderDomainPort['execute']>(async (request, scoped, operationId) => {
    const selected = request.operation === 'read' ? view : request.operation === 'cancel'
      ? records.filter(record => record.id === request.input.reminderId).map(record => ({ ...record, status: 'cancelled' as const })) : [records[0]!];
    const data = { operation: request.operation, complete: true, coverage: request.operation === 'read' ? 'bounded_list' as const : 'operation' as const, records: selected, rejections: [],
      presentation: { canonicalCard: null, questions: [], cta: null } };
    return { status: 'success', data, observation: JSON.stringify(data), receipt: { userId: scoped.userId, operationId,
      toolName: `reminder_${request.operation}`, resourceIds: selected.map(record => record.id) } };
  });
  const unused = { execute: vi.fn(async () => { throw new Error('Unexpected domain operation'); }) };
  const definitions = [...createReminderTools({ execute }), ...createTaskTools(unused), ...createCalendarTools(unused), ...createMemoryTools(unused)];
  const registry = new ToolRegistry([...definitions, ...createAgendaTools(new ToolRegistry(definitions))]);
  const runner = new ProductivityTurnRunner(provider, registry, { ...productivityBudget, continuation: 'observation_driven', compactObservations: true, discoverTools: true,
    maxPromptReferences: 50, now: () => 100, estimateInputTokens: estimate, authorizeWrite: async () => true,
    readFollowups: { reminder_read: ['reminder_cancel'] }, ...options });
  const journal = { beforeDispatch: vi.fn(async () => {}), afterOutcome: vi.fn(async () => {}) };
  return { runner, provider, execute, journal, estimate };
}
function assertWire(h: ReturnType<typeof harness>) {
  for (const wire of h.provider.requests) {
    expect(h.estimate(wire)).toBeLessThanOrEqual(2500);
    expect(aiTranscriptSchema.safeParse(wire.messages).success).toBe(true);
    const system = wire.messages.find(message => message.role === 'system')!.content;
    for (const record of view) expect(system).toContain(record.id);
    expect(JSON.stringify(wire.messages)).toContain(request);
    expect(JSON.stringify(wire.messages)).toContain(clarification);
  }
}
describe('executable continuation under the native input ceiling', () => {
  it.each([false, true])('S1/S2 loads cancellation then executes all four ordinal targets (prior read: %s)', async challenging => {
    const h = harness([select('reminder_cancel'), cancel()]);
    const state = prior(challenging), snapshot = structuredClone(state);
    const result = await h.runner.run('Si son recordatorios que quiero eloiminar', ctx, state, h.journal);
    expect(h.provider.requests).toHaveLength(2);
    expect(h.provider.requests[1]!.tools.map(tool => tool.name)).toContain('reminder_cancel');
    expect(h.provider.requests[1]!.tools.map(tool => tool.name)).not.toContain('reminder_create');
    expect(result.uiPayload.notices).toEqual([]);
    expect(result.uiPayload.items).toHaveLength(4);
    expect(h.execute.mock.calls.map(([call]) => call)).toEqual(targets.map(record => ({ operation: 'cancel', input: { reminderId: record.id } })));
    expect(h.journal.beforeDispatch).toHaveBeenCalledTimes(4);
    expect(h.journal.afterOutcome).toHaveBeenCalledTimes(4);
    expect(result.usage).toMatchObject({ modelSteps: 2, inputTokens: 60, outputTokens: 20, accountingComplete: true });
    expect(result.conversation.reminders).toEqual(records.map(record => targets.some(target => target.id === record.id) ? { ...record, status: 'cancelled' } : record));
    expect(state).toEqual(snapshot);
    expect(result.requiresReconciliation).toBe(false);
    assertWire(h);
    const second = h.provider.requests[1]!;
    expect(second.messages.some(message => message.role === 'tool')).toBe(true);
  });
  it('S1 preserves discovery/read/cancel protocol and read-followup execution', async () => {
    const h = harness([select('reminder_read'), response([{ id: 'read', name: 'reminder_read', arguments: { turnDisposition: 'continue' } }]), cancel()]);
    const result = await h.runner.run('Si son recordatorios que quiero eloiminar', ctx, prior(true), h.journal);
    expect(h.provider.requests).toHaveLength(3);
    expect(result.uiPayload.notices).toEqual([]);
    expect(h.execute).toHaveBeenCalledTimes(5);
    expect(result.uiPayload.items.map(item => item.status)).toEqual(Array(5).fill('success'));
    expect(result.usage).toMatchObject({ modelSteps: 3, inputTokens: 90, outputTokens: 30, accountingComplete: true });
    assertWire(h);
    const last = h.provider.requests[2]!;
    expect(JSON.stringify(last.messages)).toContain('reminder_read');
    expect(last.messages.filter(message => message.role === 'tool')).toHaveLength(2);
  });
  it.each([
    ['total_tokens', { maxTotalTokens: 1 }, [cancel()], 0],
    ['cost', { maxCostUsd: 0.000001, pricing: { inputUsdPerMillion: 1, outputUsdPerMillion: 1 } }, [cancel()], 0],
    ['tool_calls', { initialTools: ['reminder_cancel'], maxToolCalls: 1 }, [cancel()], 1],
    ['model_steps', { maxModelSteps: 2 }, [select('reminder_cancel'), select('reminder_read')], 2],
    ['time', { now: (() => { let calls = 0; return () => calls++ === 0 ? 100 : 45100; })() }, [cancel()], 0],
  ] as const)('S3 distinguishes %s without dispatch, even when telemetry throws', async (reason, options, script, steps) => {
    const onLimit = vi.fn(() => { throw new Error('Telemetry unavailable'); });
    const h = harness([...script], { ...options, onLimit });
    const state = prior(), snapshot = structuredClone(state);
    const result = await h.runner.run('Si', ctx, state, h.journal);
    expect(onLimit).toHaveBeenCalledExactlyOnceWith({ reason });
    expect(result.uiPayload.notices).toEqual(['limit_reached']);
    expect(result.uiPayload.items).toEqual([]);
    expect(result.usage).toMatchObject({ modelSteps: steps, inputTokens: steps * 30, outputTokens: steps * 10, accountingComplete: true });
    expect(h.provider.requests).toHaveLength(steps);
    expect(h.execute).not.toHaveBeenCalled();
    expect(h.journal.beforeDispatch).not.toHaveBeenCalled();
    expect(h.journal.afterOutcome).not.toHaveBeenCalled();
    expect(state).toEqual(snapshot);
    expect(result.conversation.reminders).toEqual(state.reminders);
  });
  it.each(['authorization', 'reference', 'journal'])('preserves the %s guard after projection', async guard => {
    const calls = guard === 'reference' ? response([{ id: 'unknown', name: 'reminder_cancel', arguments: { reminderId: '33333333-3333-4333-8333-333333333333', turnDisposition: 'finish' } }]) : cancel();
    const h = harness([select('reminder_cancel'), calls, response()], { authorizeWrite: async () => guard !== 'authorization' });
    const state = prior(true), snapshot = structuredClone(state);
    const result = await h.runner.run('Si', ctx, state, guard === 'journal' ? undefined : h.journal);
    expect(result.uiPayload.notices).toEqual([]);
    expect(result.uiPayload.items.map(item => item.code)).toEqual(Array(guard === 'reference' ? 1 : 4).fill(
      guard === 'authorization' ? 'USER_AUTHORIZATION_REQUIRED' : guard === 'reference' ? 'REFERENCE_REQUIRED' : 'DURABLE_JOURNAL_REQUIRED'));
    expect(result.requiresReconciliation).toBe(false);
    expect(result.conversation.reminders).toEqual(state.reminders);
    expect(state).toEqual(snapshot);
    expect(h.execute).not.toHaveBeenCalled();
    expect(h.journal.beforeDispatch).not.toHaveBeenCalled();
    assertWire(h);
  });
  it('preserves ordinary creation with the same budget and explicit host authorization', async () => {
    const h = harness([response([{ id: 'create', name: 'reminder_create', arguments: { content: 'Preparar informe', delayMinutes: 30, turnDisposition: 'finish' } }])],
      { initialTools: ['reminder_create'] });
    const result = await h.runner.run('Recuerdame preparar informe en 30 minutos', ctx, undefined, h.journal);
    expect(result.uiPayload.notices).toEqual([]);
    expect(result.uiPayload.items).toMatchObject([{ status: 'success', toolName: 'reminder_create' }]);
    expect(h.execute).toHaveBeenCalledOnce();
    expect(h.journal.beforeDispatch).toHaveBeenCalledOnce();
    expect(h.journal.afterOutcome).toHaveBeenCalledOnce();
    expect(h.provider.requests).toHaveLength(1);
    expect(h.estimate(h.provider.requests[0]!)).toBeLessThanOrEqual(2500);
  });
  it('S3 reports an input-context bound safely even if the diagnostic throws', async () => {
    const onLimit = vi.fn(() => { throw new Error('Telemetry unavailable'); });
    const h = harness([cancel()], { maxInputTokens: 1, onLimit });
    const state = prior(), snapshot = structuredClone(state);
    const result = await h.runner.run('Si', ctx, state, h.journal);
    expect(onLimit).toHaveBeenCalledWith({ reason: 'input_context' });
    expect(result.uiPayload.notices).toEqual(['limit_reached']);
    expect(result.uiPayload.items).toEqual([]);
    expect(result.usage).toMatchObject({ modelSteps: 0, inputTokens: 0, outputTokens: 0, accountingComplete: true });
    expect(h.provider.requests).toHaveLength(0);
    expect(h.execute).not.toHaveBeenCalled();
    expect(h.journal.beforeDispatch).not.toHaveBeenCalled();
    expect(state).toEqual(snapshot);
    expect(result.conversation.reminders).toEqual(state.reminders);
  });
});
