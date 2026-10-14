import { describe, expect, it, vi } from 'vitest';
import { MockAIProvider } from '@templelabs/ai';
import { ReminderTurnRunner } from '@templelabs/agent-core';
import { createReminderTools, ToolRegistry } from '@templelabs/tools';
import { reminderCheckpointSchema, type AIResponse, type JsonObject, type TurnContext } from '@templelabs/contracts';
import { withTurnLease, type InboundTurnLease } from '../../../src/agent/core/turn-lease.js';
import { createLegacyReminderPort } from '../../../src/adapters/agent-core/legacy-reminders.js';
import { DurableReminderAssistant, type ReminderDeliveryPort } from '../../../src/adapters/agent-core/durable-reminder-assistant.js';
import type { LegacyToolRequest } from '../../../src/agent/tools/index.js';

const context: TurnContext = { userId: 'owner', runId: 'turn', requestId: 'message', language: 'es',
  timezone: 'America/Bogota', referenceTimeIso: '2026-10-11T17:49:00Z', capabilities: new Set(['reminders.create']),
  signal: new AbortController().signal };
const args = { content: 'Llamar a Ana', targetTimeIso: '2026-10-11T21:00:00Z' };
const response: AIResponse = { message: { role: 'assistant', content: 'internal instructions',
  toolCalls: [{ id: 'call', name: 'reminder_create', arguments: args }] }, stopReason: 'tool_calls',
  usage: { inputTokens: 30, outputTokens: 10 } };
const raw = { success: true, action: 'created_reminders_batch', data: [{
  id: '11111111-1111-4111-8111-111111111111', content: args.content, sendAt: args.targetTimeIso,
}] };
function setup() {
  let persisted: JsonObject = {};
  let count = 0;
  let failAt = 0;
  const events: string[] = [];
  const execute = vi.fn<(request: LegacyToolRequest) => Promise<unknown>>(async () => { events.push('write'); return raw; });
  const send = vi.fn<ReminderDeliveryPort['send']>(async message => { events.push('send'); return { messageId: `accepted-${message.id}` }; });
  const provider = new MockAIProvider([{ response }], () => 100);
  const runner = new ReminderTurnRunner(provider, new ToolRegistry(createReminderTools(
    createLegacyReminderPort({ id: context.userId, timezone: context.timezone }, execute))), {
    now: () => 100, authorizeWrite: async () => true,
  });
  const controller = new AbortController();
  const lease: InboundTurnLease = {
    inboundTurn: { id: context.runId, messageId: context.requestId, threadId: 'thread', response: {} },
    signal: controller.signal,
    assertActive: vi.fn(async () => {}),
    checkpoint: vi.fn(async patch => {
      count++;
      events.push(`checkpoint-${count}`);
      if (count === failAt) throw new Error('storage unavailable');
      persisted = { ...persisted, ...structuredClone(patch) };
    }),
  };
  const assistant = new DurableReminderAssistant(runner, { send });
  const run = () => withTurnLease(lease, () => assistant.handle('Crea un recordatorio', context, 'thread'));
  return { run, assistant, runner, lease, controller, execute, send, provider, events,
    fail: (at: number) => { failAt = at; }, snapshot: () => structuredClone(persisted) };
}
function journal(value: JsonObject) {
  return value.agentCore as JsonObject;
}

describe('durable reminder execution and delivery boundaries', () => {
  it('checkpoints each multihop batch and delivers only after the final model decision', async () => {
    const s = setup();
    const ctx = { ...context, capabilities: new Set(['reminders.create', 'reminders.update']) };
    const final: AIResponse = { ...response, stopReason: 'completed', message: { role: 'assistant', content: 'internal', toolCalls: [] } };
    const provider = new MockAIProvider([{ response }, { response: { ...response, message: { ...response.message,
      toolCalls: [{ id: 'call', name: 'reminder_update', arguments: { reminderId: raw.data[0]!.id, targetTimeIso: '2026-10-11T22:00:00Z' } }] } } },
      { response: final, inspect: () => { expect(s.send).not.toHaveBeenCalled();
        expect(reminderCheckpointSchema.parse(s.snapshot().agentCore).effects).toHaveLength(2); } }], () => 100);
    s.execute.mockImplementationOnce(async () => { s.events.push('write'); return raw; })
      .mockImplementationOnce(async () => { s.events.push('write'); return { success: true, action: 'updated_reminder',
        data: { ...raw.data[0]!, sendAt: '2026-10-11T22:00:00Z' } }; });
    const runner = new ReminderTurnRunner(provider, new ToolRegistry(createReminderTools(createLegacyReminderPort({
      id: context.userId, timezone: context.timezone,
    }, s.execute))), { now: () => 100, continuation: 'observation_driven', authorizeWrite: async () => true });
    const assistant = new DurableReminderAssistant(runner, { send: s.send });
    await withTurnLease(s.lease, () => assistant.handle('Crea y luego cambia la hora', ctx, 'thread'));
    const checkpoint = reminderCheckpointSchema.parse(s.snapshot().agentCore);
    expect(checkpoint.phase).toBe('completed');
    expect(checkpoint.effects.map(effect => effect.call?.id)).toEqual(['message:call', 'message:step:1:call']);
    expect(s.events.slice(0, 7)).toEqual(['checkpoint-1', 'checkpoint-2', 'write', 'checkpoint-3', 'checkpoint-4', 'write', 'checkpoint-5']);
    expect(s.send).toHaveBeenCalledTimes(1);
  });

  it('restores a stored first turn and updates its observed ID on the second turn', async () => {
    const first = setup();
    await first.run();
    const saved = reminderCheckpointSchema.parse(first.snapshot().agentCore).completed!.conversation;
    const nextContext = { ...context, runId: 'second-turn', requestId: 'second-message', capabilities: new Set(['reminders.update']) };
    const second = setup();
    const nextLease = { ...second.lease, inboundTurn: { ...second.lease.inboundTurn, id: nextContext.runId, messageId: nextContext.requestId } };
    const record = saved.references[0]!;
    const provider = new MockAIProvider([{ response: { ...response, message: { ...response.message,
      toolCalls: [{ id: 'update', name: 'reminder_update', arguments: { reminderId: record.id, targetTimeIso: '2026-10-11T21:30:00Z' } }] } } }], () => 100);
    second.execute.mockResolvedValueOnce({ success: true, action: 'updated_reminder', data: {
      id: record.id, content: record.content, sendAt: '2026-10-11T21:30:00Z',
    } });
    const runner = new ReminderTurnRunner(provider, new ToolRegistry(createReminderTools(createLegacyReminderPort({
      id: context.userId, timezone: context.timezone,
    }, second.execute))), { now: () => 100, authorizeWrite: async () => true });
    const recovery = { load: vi.fn(async () => structuredClone(saved)) };
    const assistant = new DurableReminderAssistant(runner, { send: second.send }, undefined, recovery);
    const result = await withTurnLease(nextLease, () => assistant.handle('Muévelo media hora', nextContext, 'thread'));
    expect(recovery.load).toHaveBeenCalledWith(nextContext, 'thread');
    expect(second.execute.mock.calls[0]?.[0].params).toMatchObject({ action: 'update', target: record.id });
    expect(result.conversation.handledRequestIds).toEqual(['message', 'second-message']);
    expect(result.conversation.references[0]?.sendAt).toBe('2026-10-11T21:30:00Z');
    expect(second.execute).toHaveBeenCalledTimes(1);
    expect(second.send).toHaveBeenCalledTimes(1);
    expect(first.execute).toHaveBeenCalledTimes(1);
  });

  it('stops before inference, writes, checkpoints and delivery when recovery requires reconciliation', async () => {
    const s = setup();
    const recovery = { load: vi.fn(async () => { throw Object.assign(new Error('prior unknown'), { code: 'PRIOR_TURN_RECONCILIATION_REQUIRED' }); }) };
    const assistant = new DurableReminderAssistant(s.runner, { send: s.send }, undefined, recovery);
    await expect(withTurnLease(s.lease, () => assistant.handle('Crea', context, 'thread'))).rejects.toMatchObject({ code: 'PRIOR_TURN_RECONCILIATION_REQUIRED' });
    expect(s.provider.requests).toHaveLength(0);
    expect(s.execute).not.toHaveBeenCalled();
    expect(s.send).not.toHaveBeenCalled();
    expect(s.lease.checkpoint).not.toHaveBeenCalled();
  });

  it('rejects a caller checkpoint override when durable recovery is configured', async () => {
    const s = setup();
    const recovery = { load: vi.fn(async () => undefined) };
    const assistant = new DurableReminderAssistant(s.runner, { send: s.send }, undefined, recovery);
    await expect(withTurnLease(s.lease, () => assistant.handle('Crea', context, 'thread', {
      userId: context.userId, references: [], history: [], handledRequestIds: [],
    }))).rejects.toMatchObject({ code: 'RECOVERY_CHECKPOINT_OVERRIDE_FORBIDDEN' });
    expect(recovery.load).not.toHaveBeenCalled();
    expect(s.provider.requests).toHaveLength(0);
  });
  it('persists dispatch, observed effects, final reply and provider receipts in order', async () => {
    const s = setup();
    const result = await s.run();
    expect(s.events).toEqual(['checkpoint-1', 'checkpoint-2', 'write', 'checkpoint-3', 'checkpoint-4',
      'checkpoint-5', 'send', 'checkpoint-6', 'checkpoint-7']);
    const state = journal(s.snapshot());
    expect(state).toMatchObject({ version: 2, phase: 'completed', userId: context.userId,
      effects: [{ call: { id: 'message:call' }, item: { status: 'success' } }],
      deliveries: [{ status: 'accepted', messageId: 'accepted-message:reply:0' }] });
    expect(state.completed).toMatchObject({ conversation: { handledRequestIds: ['message'] } });
    expect(result.messageIds).toEqual(['accepted-message:reply:0']);
    expect(s.send.mock.calls[0]?.[0].text).toContain('Llamar a Ana');
    expect(s.send.mock.calls[0]?.[0].text).not.toContain('internal');
  });

  it('requires an actual inbound lease rather than treating absent ambient context as safe', async () => {
    const s = setup();
    await expect(s.assistant.handle('Crea', context, 'thread')).rejects.toMatchObject({ code: 'INBOUND_LEASE_REQUIRED' });
    expect(s.provider.requests).toHaveLength(0);
    expect(s.execute).not.toHaveBeenCalled();
  });

  it.each(['runId', 'requestId', 'threadId'] as const)('rejects a mismatched %s before persistence or inference', async key => {
    const s = setup();
    const ctx = key === 'threadId' ? context : { ...context, [key]: 'foreign' };
    await expect(withTurnLease(s.lease, () => s.assistant.handle('Crea', ctx, key === 'threadId' ? 'foreign' : 'thread')))
      .rejects.toMatchObject({ code: 'INBOUND_IDENTITY_MISMATCH' });
    expect(s.lease.checkpoint).not.toHaveBeenCalled();
    expect(s.provider.requests).toHaveLength(0);
  });

  it('rejects simultaneous entry on the same lease without another model call or effect', async () => {
    const s = setup();
    await withTurnLease(s.lease, async () => {
      const first = s.assistant.handle('Crea', context, 'thread');
      await expect(s.assistant.handle('Crea', context, 'thread')).rejects.toMatchObject({ code: 'INBOUND_RECONCILIATION_REQUIRED' });
      await first;
    });
    expect(s.execute).toHaveBeenCalledTimes(1);
    expect(s.send).toHaveBeenCalledTimes(1);
    expect(s.provider.requests).toHaveLength(1);
  });

  it.each([1, 2])('blocks dispatch when checkpoint %s fails', async at => {
    const s = setup();
    s.fail(at);
    await expect(s.run()).rejects.toThrow('storage unavailable');
    expect(s.execute).not.toHaveBeenCalled();
    expect(s.send).not.toHaveBeenCalled();
  });

  it('retains the pending operation when the write commits but its outcome checkpoint fails', async () => {
    const s = setup();
    s.fail(3);
    await expect(s.run()).rejects.toThrow('storage unavailable');
    expect(s.execute).toHaveBeenCalledTimes(1);
    expect(s.send).not.toHaveBeenCalled();
    expect(journal(s.snapshot())).toMatchObject({ effects: [{ call: { id: 'message:call' }, item: null }] });
    const restartedLease = { ...s.lease, inboundTurn: { ...s.lease.inboundTurn, response: s.snapshot() } };
    await expect(withTurnLease(restartedLease, () => s.assistant.handle('Crea', context, 'thread')))
      .rejects.toMatchObject({ code: 'INBOUND_RECONCILIATION_REQUIRED' });
    expect(s.execute).toHaveBeenCalledTimes(1);
    expect(s.provider.requests).toHaveLength(1);
  });

  it('persists an unknown effect, sends an honest warning and requests queue quarantine', async () => {
    const s = setup();
    s.execute.mockRejectedValueOnce(new Error('write receipt lost'));
    await expect(s.run()).rejects.toMatchObject({ code: 'EFFECT_RECONCILIATION_REQUIRED' });
    expect(journal(s.snapshot())).toMatchObject({ phase: 'reconciliation_required',
      effects: [{ item: { status: 'indeterminate' } }], deliveries: [{ status: 'accepted' }] });
    expect(s.send.mock.calls[0]?.[0].text).toContain('Resultado sin confirmar');
    expect(s.execute).toHaveBeenCalledTimes(1);
    expect(s.send).toHaveBeenCalledTimes(1);
  });

  it.each([4, 5])('never sends when final-result or delivery-intent checkpoint %s fails', async at => {
    const s = setup();
    s.fail(at);
    await expect(s.run()).rejects.toThrow('storage unavailable');
    expect(s.execute).toHaveBeenCalledTimes(1);
    expect(s.send).not.toHaveBeenCalled();
  });

  it('never retries a send whose accepted receipt could not be persisted', async () => {
    const s = setup();
    s.fail(6);
    await expect(s.run()).rejects.toThrow('storage unavailable');
    expect(journal(s.snapshot())).toMatchObject({ phase: 'delivering', deliveries: [{ status: 'attempted', messageId: null }] });
    await expect(s.run()).rejects.toMatchObject({ code: 'INBOUND_RECONCILIATION_REQUIRED' });
    expect(s.send).toHaveBeenCalledTimes(1);
  });

  it('records each card/CTA delivery separately and stops after an uncertain CTA send', async () => {
    const s = setup();
    s.execute.mockResolvedValueOnce({ success: false, action: 'pro_tier_required', errorCode: 'PRO_TIER_REQUIRED',
      ctaUrl: 'https://example.test/pro', ctaHeader: 'Pro', ctaButtonText: 'Ver Pro' });
    s.send.mockResolvedValueOnce({ messageId: 'text-accepted' }).mockRejectedValueOnce(new Error('CTA response lost'));
    await expect(s.run()).rejects.toMatchObject({ code: 'DELIVERY_OUTCOME_UNKNOWN' });
    expect(journal(s.snapshot())).toMatchObject({ deliveries: [
      { message: { id: 'message:reply:0', kind: 'text' }, status: 'accepted', messageId: 'text-accepted' },
      { message: { id: 'message:reply:1', kind: 'cta', cta: { url: 'https://example.test/pro' } }, status: 'unknown' },
    ] });
    expect(s.send).toHaveBeenCalledTimes(2);
  });

  it.each(['exception', 'missing receipt'])('quarantines %s from transport without retrying', async mode => {
    const s = setup();
    if (mode === 'exception') s.send.mockRejectedValueOnce(new Error('private provider details'));
    else s.send.mockResolvedValueOnce({ messageId: '' });
    await expect(s.run()).rejects.toMatchObject({ code: 'DELIVERY_OUTCOME_UNKNOWN' });
    expect(journal(s.snapshot())).toMatchObject({ deliveries: [{ status: 'unknown', messageId: null }] });
    expect(JSON.stringify(s.snapshot())).not.toContain('private provider details');
    expect(s.send).toHaveBeenCalledTimes(1);
  });

  it('blocks a send if ownership is lost after its attempted checkpoint', async () => {
    const s = setup();
    vi.mocked(s.lease.checkpoint).mockImplementation(async patch => {
      const state = journal(patch);
      if (state.phase === 'delivering') s.controller.abort(new Error('lease lost'));
    });
    await expect(s.run()).rejects.toThrow('lease lost');
    expect(s.send).not.toHaveBeenCalled();
  });

  it('propagates lease cancellation to provider/tools even with a separate host signal', async () => {
    const s = setup();
    vi.mocked(s.lease.assertActive).mockImplementation(async () => {
      s.controller.abort(new Error('lease lost'));
      throw new Error('lease lost');
    });
    await expect(s.run()).rejects.toThrow('lease lost');
    expect(s.provider.requests).toHaveLength(0);
    expect(s.execute).not.toHaveBeenCalled();
    expect(s.send).not.toHaveBeenCalled();
  });
});
