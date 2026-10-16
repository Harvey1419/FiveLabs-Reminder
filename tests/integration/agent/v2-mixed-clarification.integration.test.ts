import { describe, expect, it, vi } from 'vitest';
import { MockAIProvider } from '@templelabs/ai';
import { ProductivityTurnRunner } from '@templelabs/agent-core';
import { aiTranscriptSchema, productivityCheckpointSchema, type JsonObject, type ToolCall, type TurnContext } from '@templelabs/contracts';
import { createReminderTools, ToolRegistry, type ReminderDomainPort } from '@templelabs/tools';
import { DurableProductivityAssistant, type ProductivityDeliveryPort } from '../../../src/adapters/agent-core/durable-productivity-assistant.js';
import { withTurnLease, type InboundTurnLease } from '../../../src/agent/core/turn-lease.js';
import { context, response } from '../../unit/agent-core/productivity-fixtures.js';

const question = '¿El recordatorio pendiente es para hoy o para mañana?';
const first: ToolCall = { id: 'first', name: 'reminder_create', arguments: {
  content: 'Preparar reunión', targetTimeIso: '2026-10-11T21:00:00Z', turnDisposition: 'continue',
} };
const clarify: ToolCall = { id: 'question', name: 'conversation_clarify', arguments: { domain: 'reminders', missing: 'today_or_tomorrow' } };
const second: ToolCall = { id: 'second', name: 'reminder_create', arguments: {
  content: 'Enviar informe', targetTimeIso: '2026-10-12T14:00:00Z', turnDisposition: 'finish',
} };

describe('S1–S3 durable mixed clarification through the public runner', () => {
  it('persists the first receipt and host question, then tomorrow creates only the second reminder without replay', async () => {
    const provider = new MockAIProvider([first, clarify, second].map(call => {
      const decision = response([call]);
      return { response: call.name === 'conversation_clarify'
        ? { ...decision, message: { ...decision.message, content: '' } } : decision };
    }), () => 100);
    let writeCount = 0;
    const execute = vi.fn<ReminderDomainPort['execute']>(async (request, scoped, operationId) => {
      if (request.operation !== 'create') throw new Error('Unexpected operation');
      const index = ++writeCount;
      const records = [{ id: `22222222-2222-4222-8222-${String(index).padStart(12, '0')}`, content: request.input.content,
        sendAt: request.input.targetTimeIso!, status: 'pending' as const, recurrence: null, isAdvanceNotice: false,
        parentReminderId: null, requiresConfirmation: false, acknowledgedAt: null }];
      const data = { operation: 'create' as const, complete: true, coverage: 'operation' as const, records, rejections: [],
        presentation: { canonicalCard: null, questions: [], cta: null } };
      return { status: 'success', data, observation: JSON.stringify(data), receipt: { userId: scoped.userId, operationId,
        toolName: 'reminder_create', resourceIds: records.map(record => record.id) } };
    });
    const runner = new ProductivityTurnRunner(provider, new ToolRegistry(createReminderTools({ execute })), {
      now: () => 100, continuation: 'observation_driven', finishWithVerifiedResults: true, authorizeWrite: async () => true,
    });
    const send = vi.fn<ProductivityDeliveryPort['send']>(async message => ({ messageId: `accepted-${message.id}` }));
    const assistant = new DurableProductivityAssistant(runner, { send });
    const snapshots = new Map<string, JsonObject>();
    const leaseFor = (ctx: TurnContext): InboundTurnLease => ({
      inboundTurn: { id: ctx.runId, messageId: ctx.requestId, threadId: 'thread', response: {} }, signal: ctx.signal,
      assertActive: vi.fn(async () => {}), checkpoint: vi.fn(async patch => { snapshots.set(ctx.runId, structuredClone(patch)); }),
    });
    const firstResult = await withTurnLease(leaseFor(context), () => assistant.handle(
      'Recuérdame preparar reunión hoy a las 4 PM y enviar informe a las 9 AM, pero no sé si hoy o mañana', context, 'thread'));
    expect(firstResult.reply.text).toContain('Preparar reunión');
    expect(firstResult.reply.text).toContain('4:00 PM');
    expect(firstResult.reply.text.endsWith(question)).toBe(true);
    expect(firstResult.reply.text).not.toContain('Listo, te lo recordaré.');
    expect(firstResult.uiPayload.items).toHaveLength(1);
    expect(firstResult.uiPayload).toMatchObject({ clarification: clarify.arguments, notices: [] });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(provider.requests).toHaveLength(2);
    expect(provider.requests[0]!.tools.map(tool => tool.name)).not.toContain('conversation_clarify');
    expect(provider.requests[1]!.tools.map(tool => tool.name)).toContain('conversation_clarify');
    const firstCheckpoint = productivityCheckpointSchema.parse(snapshots.get(context.runId)?.agentCoreProductivity);
    expect(firstCheckpoint.phase).toBe('completed');
    expect(firstCheckpoint.effects).toHaveLength(1);
    expect(firstCheckpoint.completed?.reply.text).toBe(firstResult.reply.text);
    expect(firstCheckpoint.completed?.conversation.history.at(-1)?.content).toBe(firstResult.reply.text);
    expect(firstCheckpoint.deliveries[0]?.message.text).toBe(firstResult.reply.text);
    expect(send.mock.calls[0]?.[0].text).toBe(firstResult.reply.text);

    const nextContext = { ...context, runId: 'run-next', requestId: 'request-next' };
    const nextResult = await withTurnLease(leaseFor(nextContext), () => assistant.handle('mañana', nextContext, 'thread', firstResult.conversation));
    expect(execute).toHaveBeenCalledTimes(2);
    expect(execute.mock.calls.map(([request]) => request)).toEqual([
      { operation: 'create', input: { content: 'Preparar reunión', targetTimeIso: '2026-10-11T21:00:00Z' } },
      { operation: 'create', input: { content: 'Enviar informe', targetTimeIso: '2026-10-12T14:00:00Z' } },
    ]);
    expect(provider.requests).toHaveLength(3);
    expect(send).toHaveBeenCalledTimes(2);
    expect(nextResult.reply.text).toContain('Enviar informe');
    expect(nextResult.reply.text).toContain('9:00 AM');
    expect(nextResult.reply.text).not.toContain('Preparar reunión');
    expect(nextResult.reply.text).not.toContain(question);
    expect(nextResult.conversation.reminders.map(record => record.sendAt)).toEqual(['2026-10-11T21:00:00Z', '2026-10-12T14:00:00Z']);
    expect(JSON.stringify(provider.requests[2]!.messages)).toContain(question);
    expect(JSON.stringify(provider.requests[2]!.messages)).toContain('mañana');
    const nextCheckpoint = productivityCheckpointSchema.parse(snapshots.get(nextContext.runId)?.agentCoreProductivity);
    expect(nextCheckpoint.effects).toHaveLength(1);
    expect(nextCheckpoint.completed?.reply.text).toBe(nextResult.reply.text);
    expect(nextCheckpoint.completed?.conversation.reminders).toHaveLength(2);
    expect(nextCheckpoint.deliveries[0]?.message.text).toBe(nextResult.reply.text);
    expect(send.mock.calls[1]?.[0].text).toBe(nextResult.reply.text);
    for (const history of [...provider.requests.map(request => request.messages), firstResult.conversation.history, nextResult.conversation.history]) {
      expect(aiTranscriptSchema.safeParse(history).success).toBe(true);
    }
  });
});
