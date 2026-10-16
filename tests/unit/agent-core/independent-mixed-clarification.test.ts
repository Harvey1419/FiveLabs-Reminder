import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { MockAIProvider } from '@templelabs/ai';
import { createReminderTools, type ReminderDomainPort, ToolRegistry } from '@templelabs/tools';
import { aiTranscriptSchema, productivityCheckpointSchema, type ToolCall } from '@templelabs/contracts';
import { ProductivityTurnRunner } from '@templelabs/agent-core';
import { DurableProductivityAssistant } from '../../../src/adapters/agent-core/durable-productivity-assistant.js';
import { withTurnLease, type InboundTurnLease } from '../../../src/agent/core/turn-lease.js';
import { context, response, setup, taskCreate } from './productivity-fixtures.js';

const question = '¿El recordatorio pendiente es para hoy o para mañana?';
const clarify: ToolCall = { id: 'question', name: 'conversation_clarify',
  arguments: { domain: 'reminders', missing: 'today_or_tomorrow' } };
const decision = (calls: ToolCall[], content = '') => {
  const value = response(calls);
  return { ...value, message: { ...value.message, content } };
};
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

describe('independent mixed clarification S1–S3', () => {
  it.each([
    decision([{ ...clarify, arguments: { ...clarify.arguments, claim: 'Everything done' } }]),
    decision([{ ...clarify, arguments: { ...clarify.arguments, domain: 'admin' } }]),
    decision([{ ...clarify, arguments: { ...clarify.arguments, missing: 'authorize_write' } }]),
    decision([clarify], 'Everything done'),
    decision([clarify], ' '),
    decision([clarify, { id: 'escalate', name: 'admin_write', arguments: { approved: true } }]),
    decision([{ ...taskCreate, id: 'sibling' }, clarify]),
  ])('rejects malformed decisions without another effect %#', async rejected => {
    const h = setup([decision([taskCreate]), rejected]);
    const original = h.execute.getMockImplementation()!;
    const stored: unknown[] = [];
    let before = '';
    h.execute.mockImplementation(async request => {
      const result = await original(request);
      stored.push(result);
      before = hash(stored);
      return result;
    });
    const result = await h.run();
    expect(result.uiPayload.clarification).toBeUndefined();
    expect(result.uiPayload.notices).toEqual(['invalid_response']);
    expect(h.execute).toHaveBeenCalledTimes(1);
    expect(hash(stored)).toBe(before);
    expect(result.conversation.history).toHaveLength(4);
    expect(aiTranscriptSchema.safeParse(result.conversation.history).success).toBe(true);
    const checkpoint = productivityCheckpointSchema.parse(h.snapshot().agentCoreProductivity);
    expect(checkpoint.effects).toHaveLength(1);
    expect(checkpoint.completed?.reply.text).toBe(result.reply.text);
    expect(result.reply.text).not.toContain('Everything done');
  });

  it.each(['capability', 'effect'])('cannot clarify after an unknown %s', async fence => {
    const execute = vi.fn(async () => ({ status: 'failed' as const,
      code: 'UNEXPECTED', observation: 'Unexpected' }));
    const registry = new ToolRegistry([{ specification: { name: 'task_create',
      description: 'Synthetic task', inputSchema: { type: 'object' } },
      requiredCapability: 'tasks.create', effect: 'write', execute }]);
    if (fence === 'effect') vi.spyOn(registry, 'effect').mockReturnValue(undefined);
    const provider = new MockAIProvider([{ response: decision([taskCreate]) },
      { response: decision([clarify]) }], () => 100);
    const authorizeWrite = vi.fn(async () => true);
    const journal = { beforeDispatch: vi.fn(async () => {}), afterOutcome: vi.fn(async () => {}) };
    const runner = new ProductivityTurnRunner(provider, registry, {
      now: () => 100, continuation: 'observation_driven', authorizeWrite });
    const result = await runner.run('Create and clarify', fence === 'capability'
      ? { ...context, capabilities: new Set() } : context, undefined, journal);
    expect(result.uiPayload.notices).toEqual(['unavailable_tool', 'invalid_response']);
    expect(result.uiPayload.clarification).toBeUndefined();
    expect(execute).not.toHaveBeenCalled();
    expect(authorizeWrite).not.toHaveBeenCalled();
    expect(journal.beforeDispatch).not.toHaveBeenCalled();
    expect(journal.afterOutcome).not.toHaveBeenCalled();
  });

  it('retains a bounded host question in delivery and checkpoint history', async () => {
    const calls = Array.from({ length: 3 }, (_, index): ToolCall => ({
      id: `reminder-${index}`, name: 'reminder_create', arguments: {
        content: `${index}: ${'detail '.repeat(250)}`, targetTimeIso: '2026-10-11T21:00:00Z' } }));
    const h = setup([decision(calls), decision([clarify])]);
    let index = 0;
    h.execute.mockImplementation(async () => ({ success: true, action: 'created_reminders_batch',
      data: [{ id: `22222222-2222-4222-8222-${String(index + 1).padStart(12, '0')}`,
        content: String(calls[index++]!.arguments.content), sendAt: '2026-10-11T21:00:00Z' }] }));
    const result = await h.run();
    expect(h.execute).toHaveBeenCalledTimes(3);
    expect(result.uiPayload.notices).toEqual([]);
    expect(result.reply.text.length).toBeLessThanOrEqual(4000);
    expect(result.reply.text).toContain('…');
    expect(result.reply.text.endsWith(question)).toBe(true);
    expect(result.reply.text.split(question)).toHaveLength(2);
    const checkpoint = productivityCheckpointSchema.parse(h.snapshot().agentCoreProductivity);
    expect(checkpoint.effects).toHaveLength(3);
    expect(checkpoint.completed?.reply.text).toBe(result.reply.text);
    expect(checkpoint.completed?.conversation.history.at(-1)?.content).toBe(result.reply.text);
    expect(h.send.mock.calls[0]?.[0].text).toBe(result.reply.text);
  });
});

describe('independent continuation acceptance S2', () => {
  it('keeps receipts and creates only tomorrow’s remaining reminder across local midnight', async () => {
    const first: ToolCall = { id: 'first', name: 'reminder_create', arguments: {
      content: 'Primero', targetTimeIso: '2026-10-12T04:45:00Z', turnDisposition: 'continue' } };
    const second: ToolCall = { id: 'second', name: 'reminder_create', arguments: {
      content: 'Segundo', targetTimeIso: '2026-10-12T14:00:00Z', turnDisposition: 'finish' } };
    const provider = new MockAIProvider([first, clarify, second].map(call => ({ response: decision([call]) })), () => 100);
    const stored: { id: string; content: string; sendAt: string; status: 'pending'; recurrence: null;
      isAdvanceNotice: false; parentReminderId: null; requiresConfirmation: false; acknowledgedAt: null }[] = [];
    const execute = vi.fn<ReminderDomainPort['execute']>(async (request, ctx, operationId) => {
      if (request.operation !== 'create') throw new Error('Unexpected operation');
      const record = { id: `22222222-2222-4222-8222-${String(stored.length + 1).padStart(12, '0')}`,
        content: request.input.content, sendAt: request.input.targetTimeIso!, status: 'pending' as const,
        recurrence: null, isAdvanceNotice: false as const, parentReminderId: null,
        requiresConfirmation: false as const, acknowledgedAt: null };
      stored.push(record);
      const data = { operation: 'create' as const, complete: true, coverage: 'operation' as const,
        records: [record], rejections: [], presentation: { canonicalCard: null, questions: [], cta: null } };
      return { status: 'success', data, observation: JSON.stringify(data), receipt: {
        userId: ctx.userId, operationId, toolName: 'reminder_create', resourceIds: [record.id] } };
    });
    const runner = new ProductivityTurnRunner(provider, new ToolRegistry(createReminderTools({ execute })), {
      now: () => 100, continuation: 'observation_driven', finishWithVerifiedResults: true, authorizeWrite: async () => true });
    const send = vi.fn(async () => ({ messageId: 'synthetic-delivery' }));
    const assistant = new DurableProductivityAssistant(runner, { send });
    const snapshots = new Map<string, unknown>();
    const local = { ...context, referenceTimeIso: '2026-10-12T04:30:00Z' };
    const run = async (text: string, ctx: typeof context, previous?: Parameters<typeof assistant.handle>[3]) => {
      const lease: InboundTurnLease = { inboundTurn: { id: ctx.runId, messageId: ctx.requestId,
        threadId: 'synthetic', response: {} }, signal: ctx.signal, assertActive: async () => {},
        checkpoint: async patch => { snapshots.set(ctx.runId, structuredClone(patch.agentCoreProductivity)); } };
      return withTurnLease(lease, () => assistant.handle(text, ctx, 'synthetic', previous));
    };
    const firstResult = await run('Primero hoy 11:45 PM; segundo 9 AM, ¿hoy o mañana?', local);
    const retained = hash(stored[0]);
    expect(firstResult.reply.text.endsWith(question)).toBe(true);
    expect(firstResult.reply.text).toContain('11:45 PM');
    expect(stored).toHaveLength(1);
    const next = { ...local, requestId: 'next', runId: 'next-run' };
    const secondResult = await run('mañana', next, firstResult.conversation);
    expect(execute).toHaveBeenCalledTimes(2);
    expect(stored.map(record => record.sendAt)).toEqual(['2026-10-12T04:45:00Z', '2026-10-12T14:00:00Z']);
    expect(hash(stored[0])).toBe(retained);
    expect(secondResult.conversation.reminders).toHaveLength(2);
    expect(secondResult.reply.text).toContain('9:00 AM');
    expect(secondResult.reply.text).not.toContain('Primero');
    expect(JSON.stringify(provider.requests[2]!.messages)).toContain(question);
    for (const [ctx, result] of [[local, firstResult], [next, secondResult]] as const) {
      const checkpoint = productivityCheckpointSchema.parse(snapshots.get(ctx.runId));
      expect(checkpoint.effects).toHaveLength(1);
      expect(checkpoint.effects[0]?.item?.status).toBe('success');
      expect(checkpoint.completed?.conversation.history).toEqual(result.conversation.history);
      expect(checkpoint.completed?.reply.text).toBe(result.reply.text);
      expect(aiTranscriptSchema.safeParse(result.conversation.history).success).toBe(true);
    }
  });
});

describe('independent channel guard regressions S3', () => {
  function harness(options: ConstructorParameters<typeof ProductivityTurnRunner>[2] = {}) {
    const provider = new MockAIProvider([{ response: decision([taskCreate]) },
      { response: decision([clarify]) }], () => 100);
    const execute = vi.fn(async (_input: unknown, ctx: typeof context, operationId: string) => {
      const data = { operation: 'create' as const, complete: true, coverage: 'operation' as const,
        records: [{ id: '11111111-1111-4111-8111-111111111111', title: 'Propuesta', description: null,
          priority: null, status: 'pending' as const, dueDateIso: null, entityId: null, entityName: null }],
        issues: [], presentation: { canonicalCard: null, questions: [], cta: null }, flow: null };
      return { status: 'success' as const, data, observation: JSON.stringify(data), receipt: {
        userId: ctx.userId, operationId, toolName: 'task_create', resourceIds: data.records.map(record => record.id) } };
    });
    const registry = new ToolRegistry([{ specification: { name: 'task_create', description: 'Synthetic',
      inputSchema: { type: 'object' } }, effect: 'write', requiredCapability: 'tasks.create', execute }]);
    const journal = { beforeDispatch: vi.fn(async () => {}), afterOutcome: vi.fn(async () => {}) };
    const runner = new ProductivityTurnRunner(provider, registry, { now: () => 100,
      continuation: 'observation_driven', authorizeWrite: async () => true, ...options });
    return { provider, registry, execute, journal, runner };
  }
  it.each([
    { maxToolCalls: 1 },
    { maxTotalTokens: 70, estimateInputTokens: () => 0 },
    { maxHistoryMessages: 4 },
    { maxCostUsd: 0.00007, pricing: { inputUsdPerMillion: 1, outputUsdPerMillion: 1 },
      maxOutputTokens: 10, estimateInputTokens: () => 0 },
  ])('retains existing budget fences %#', async options => {
    const h = harness(options);
    const result = await h.runner.run('Create and clarify', context, undefined, h.journal);
    expect(result.uiPayload.clarification).toBeUndefined();
    expect(result.uiPayload.notices).toEqual(['limit_reached']);
    expect(h.execute).toHaveBeenCalledTimes(1);
    expect(h.journal.afterOutcome).toHaveBeenCalledTimes(1);
  });
  it('does not let cancellation authorize clarification', async () => {
    const controller = new AbortController();
    const h = harness();
    const complete = h.provider.complete.bind(h.provider);
    vi.spyOn(h.provider, 'complete').mockImplementation(async request => {
      const result = await complete(request);
      if (h.provider.requests.length === 2) controller.abort();
      return result;
    });
    const result = await h.runner.run('Create and clarify', { ...context, signal: controller.signal }, undefined, h.journal);
    expect(result.uiPayload.clarification).toBeUndefined();
    expect(result.uiPayload.notices).toEqual(['limit_reached']);
    expect(h.execute).toHaveBeenCalledTimes(1);
  });
  it.each(['failed', 'indeterminate'] as const)('does not open the channel after a %s sibling', async status => {
    const h = harness();
    const original = h.registry.execute.bind(h.registry);
    let count = 0;
    vi.spyOn(h.registry, 'execute').mockImplementation(async (name, input, ctx, id) => {
      if (++count === 1) return original(name, input, ctx, id);
      return status === 'failed' ? { status, code: 'FAILED', observation: 'Rejected' }
        : { status, operationId: id, observation: 'Effect unknown' };
    });
    const complete = vi.spyOn(h.provider, 'complete').mockResolvedValueOnce(decision([taskCreate,
      { ...taskCreate, id: 'other', arguments: { ...taskCreate.arguments, title: 'Other' } }])).mockResolvedValueOnce(decision([clarify]));
    const result = await h.runner.run('Two tasks and clarify', context, undefined, h.journal);
    expect(result.uiPayload.clarification).toBeUndefined();
    expect(result.uiPayload.items.map(item => item.status)).toEqual(['success', status]);
    expect(result.requiresReconciliation).toBe(status === 'indeterminate');
    expect(complete).toHaveBeenCalledTimes(status === 'failed' ? 2 : 1);
    if (status === 'failed') {
      expect(complete.mock.calls[1]![0].tools.some(tool => tool.name === 'conversation_clarify')).toBe(false);
      expect(result.uiPayload.notices).toEqual(['invalid_response']);
    }
    expect(h.execute).toHaveBeenCalledTimes(1);
  });
});
