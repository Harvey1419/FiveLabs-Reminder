import { describe, expect, it } from 'vitest';
import { MockAIProvider, estimateBoundedInput } from '@templelabs/ai';
import { ProductivityTurnRunner } from '@templelabs/agent-core';
import { ToolRegistry, createCalendarTools } from '@templelabs/tools';
import type { AIResponse, ProductivityConversation, ToolCall, TurnContext } from '@templelabs/contracts';
import { calendarCorrectionFixture, calendarAnchor } from '../../../scripts/evals/calendar-correction-fixture.js';
import { nativeProductivityPolicy } from '../../../src/adapters/agent-core/native-productivity-policy.js';
import { DurableProductivityAssistant } from '../../../src/adapters/agent-core/durable-productivity-assistant.js';
import { withTurnLease } from '../../../src/agent/core/turn-lease.js';

const response = (calls: ToolCall[] = []): AIResponse => ({ message: { role: 'assistant', content: calls.length ? '' : 'Listo.', toolCalls: calls },
  stopReason: calls.length ? 'tool_calls' : 'completed', usage: { inputTokens: 100, outputTokens: 50 } });
describe('calendar correction through the production domain boundary', () => {
  it('renames the observed all-day event using the same ID without creating a replacement', async () => {
    const f = calendarCorrectionFixture();
    const inputs: { text: string; call: ToolCall }[] = [
      { text: 'Para el 2 de enero añade cumpleaños Trena.', call: { id: 'create', name: 'calendar_create', arguments: {
        kind: 'all_day', summary: 'Cumpleaños de Trena', startDate: '2027-01-02', endDateExclusive: '2027-01-03' } } },
      { text: 'Trina no trena', call: { id: 'update', name: 'calendar_update', arguments: {
        eventId: 'hermesfixture1', lookupDate: '2027-01-02', summary: 'Cumpleaños de Trina' } } },
      { text: 'Muéstrame los del 2 de enero.', call: { id: 'read', name: 'calendar_read', arguments: { scope: '2027-01-02' } } },
    ];
    let previous: ProductivityConversation | undefined;
    for (const [index, input] of inputs.entries()) {
      const context: TurnContext = { userId: f.user.id, runId: `run-${index}`, requestId: `request-${index}`, timezone: f.user.timezone,
        language: 'es', referenceTimeIso: calendarAnchor, capabilities: new Set(['calendar.read', 'calendar.create', 'calendar.update']), signal: new AbortController().signal };
      const provider = new MockAIProvider([response([input.call]), response()].map(response => ({ response })), () => 100);
      const runner = new ProductivityTurnRunner(provider, new ToolRegistry(createCalendarTools(f.port)), { ...nativeProductivityPolicy,
        compactObservations: true, estimateInputTokens: estimateBoundedInput, authorizeWrite: async () => true });
      const assistant = new DurableProductivityAssistant(runner, { send: async message => ({ messageId: `local:${message.id}` }) });
      const result = await withTurnLease({ inboundTurn: { id: context.runId, messageId: context.requestId, threadId: 'thread', response: {} },
        signal: context.signal, assertActive: async () => {}, checkpoint: async () => {} }, () => assistant.handle(input.text, context, 'thread', previous));
      expect(result.uiPayload.items.every(item => item.status === 'success')).toBe(true);
      expect(result.uiPayload.notices).toEqual([]);
      expect(result.reply.text).not.toMatch(/No pude|lista limitada/);
      if (index > 0) expect(result.reply.text).toContain('Trina');
      previous = result.conversation;
    }
    expect(f.operations.map(o => o.operation)).toEqual(['create', 'update']);
    expect(f.events).toEqual([{ id: 'hermesfixture1', summary: 'Cumpleaños de Trina', start: '2027-01-02', end: '2027-01-03', isAllDay: true }]);
    expect(f.reads.every(read => !read.q)).toBe(true);
  });
});
