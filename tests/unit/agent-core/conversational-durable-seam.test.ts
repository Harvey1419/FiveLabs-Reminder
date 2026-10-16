import { expect, it, vi } from 'vitest';
import { MockAIProvider, estimateBoundedInput } from '@templelabs/ai';
import { ProductivityTurnRunner } from '@templelabs/agent-core';
import { ToolRegistry, createReminderTools } from '@templelabs/tools';
import { type ProductivityConversation, productivityCheckpointSchema } from '@templelabs/contracts';
import { DurableProductivityAssistant } from '../../../src/adapters/agent-core/durable-productivity-assistant.js';
import { createLegacyReminderPort } from '../../../src/adapters/agent-core/legacy-reminders.js';
import { withTurnLease } from '../../../src/agent/core/turn-lease.js';
import { context, response, setup } from './productivity-fixtures.js';

it('carries owned ordinals and the actual failure reply across the durable/core seam', async () => {
  const ids = Array.from({ length: 5 }, (_, i) => `22222222-2222-4222-8222-22222222222${i}`);
  const execute = vi.fn(async () => { throw new Error('Unexpected execution'); });
  const send = vi.fn(async () => ({ messageId: 'accepted-fixture' }));
  const provider = new MockAIProvider([
    { response: new Error('provider unavailable') }, { response: response() },
  ], () => 100);
  const runner = new ProductivityTurnRunner(provider, new ToolRegistry(
    createReminderTools(createLegacyReminderPort({ id: context.userId, timezone: context.timezone }, execute)),
  ), {
    compactObservations: true, discoverTools: true, initialTools: ['reminder_create'],
    continuation: 'observation_driven', now: () => 100, maxInputTokens: 2500,
    estimateInputTokens: estimateBoundedInput, authorizeWrite: async () => false,
  });
  const assistant = new DurableProductivityAssistant(runner, { send });
  const previous: ProductivityConversation = {
    userId: context.userId, tasks: [], events: [], handledRequestIds: [],
    reminders: ids.map(id => ({
      id, content: 'Recordatorio', status: 'pending', sendAt: '2026-10-11T21:00:00Z',
      recurrence: null, isAdvanceNotice: false, parentReminderId: null,
      requiresConfirmation: false, acknowledgedAt: null,
    })),
    referenceOrder: ids.map((id, i) => ({ domain: 'reminders', id, position: i + 1 })),
    history: [
      { role: 'user', content: 'Consulta mis recordatorios' },
      { role: 'assistant', content: '', toolCalls: [{ id: 'old', name: 'reminder_read', arguments: {} }] },
      { role: 'tool', toolCallId: 'old', isError: false, content: {
        status: 'success', observation: JSON.stringify({ operation: 'read', complete: true,
          records: Array.from({ length: 40 }, (_, i) => ({
            id: `old-${i}`, content: 'inventory '.repeat(250), status: 'pending',
          })),
        }),
      } },
      { role: 'assistant', content: 'Aquí están.', toolCalls: [] },
    ],
  };
  async function turn(text: string, prior: ProductivityConversation, n: number) {
    const state = setup([]);
    const ctx = { ...context, runId: `run-${n}`, requestId: `message-${n}` };
    const lease = { ...state.lease, inboundTurn: {
      ...state.lease.inboundTurn, id: ctx.runId, messageId: ctx.requestId,
    } };
    const result = await withTurnLease(lease, () => assistant.handle(text, ctx, 'thread', prior));
    const checkpoint = productivityCheckpointSchema.parse(state.snapshot().agentCoreProductivity);
    expect(checkpoint.completed?.conversation.history).toEqual(result.conversation.history);
    expect(checkpoint.phase).toBe('completed');
    expect(checkpoint.deliveries).toMatchObject([{ status: 'accepted', messageId: 'accepted-fixture' }]);
    return result;
  }
  const original = structuredClone(previous);
  const failed = await turn('Elimina el 1, el 2, el 3 y el 5.', previous, 1);
  const first = provider.requests[0]!;
  expect(first.tools.some(tool => tool.name === 'reminder_cancel')).toBe(false);
  for (const id of ids) expect(first.messages[0]!.content).toContain(id);
  expect(failed.uiPayload.notices).toEqual(['provider_unavailable']);
  expect(failed.uiPayload.items).toEqual([]);
  expect(failed.conversation.history.at(-1)?.content).toBe(failed.reply.text);
  expect(failed.reply.text).toContain('No hice cambios');
  const next = await turn('por que ?', failed.conversation, 2);
  expect(JSON.stringify(provider.requests.at(-1)!.messages)).toContain(failed.reply.text);
  expect(next.uiPayload.notices).toEqual([]);
  expect(next.uiPayload.items).toEqual([]);
  expect(previous).toEqual(original);
  expect(failed.conversation.reminders).toEqual(previous.reminders);
  expect(next.conversation.reminders).toEqual(previous.reminders);
  expect(execute).not.toHaveBeenCalled();
  expect(send).toHaveBeenCalledTimes(2);
});
