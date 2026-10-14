import { describe, expect, it, vi } from 'vitest';
import { MockAIProvider } from '@templelabs/ai';
import { ReminderTurnRunner } from '@templelabs/agent-core';
import { ToolRegistry } from '@templelabs/tools';
import { productivityCheckpointSchema } from '@templelabs/contracts';
import { withTurnLease } from '../../../src/agent/core/turn-lease.js';
import { DurableProductivityAssistant } from '../../../src/adapters/agent-core/durable-productivity-assistant.js';
import { DurableReminderAssistant } from '../../../src/adapters/agent-core/durable-reminder-assistant.js';
import { setup, context, taskCreate, response, calendarRead } from './productivity-fixtures.js';

describe('durable mixed effects and transport acceptance', () => {
  it('persists multihop outcomes before continuation and journals text/flow sends separately', async () => {
    const s = setup();
    const result = await s.run();
    const state = productivityCheckpointSchema.parse(s.snapshot().agentCoreProductivity);
    expect(state.phase).toBe('completed'); expect(state.version).toBe(1);
    expect(state.effects.map(effect => effect.item?.domain)).toEqual(['calendar', 'tasks', 'reminders']);
    expect(state.deliveries.map(entry => [entry.message.kind, entry.status])).toEqual([['text', 'accepted'], ['flow', 'accepted']]);
    expect(state.completed?.requiresReconciliation).toBe(false);
    expect(result.messageIds).toHaveLength(2);
    expect(s.events.slice(0, 7)).toEqual(['checkpoint-1', 'checkpoint-2', 'execute', 'checkpoint-3', 'checkpoint-4', 'execute', 'checkpoint-5']);
    expect(s.events.lastIndexOf('execute')).toBeLessThan(s.events.indexOf('send'));
    expect(s.snapshot()).not.toHaveProperty('agentCore');
  });
  it.each([1, 2])('blocks effects and sends when checkpoint %s fails', async at => {
    const s = setup([response([taskCreate]), response()]); s.fail(at);
    await expect(s.run()).rejects.toThrow('storage unavailable');
    expect(s.execute).not.toHaveBeenCalled(); expect(s.send).not.toHaveBeenCalled();
  });
  it('keeps a pending effect after its committed outcome cannot be saved and rejects restart', async () => {
    const s = setup([response([taskCreate]), response()]); s.fail(3);
    await expect(s.run()).rejects.toThrow('storage unavailable');
    expect(productivityCheckpointSchema.parse(s.snapshot().agentCoreProductivity).effects[0]?.item).toBeNull();
    const restarted = { ...s.lease, inboundTurn: { ...s.lease.inboundTurn, response: s.snapshot() } };
    await expect(withTurnLease(restarted, () => s.assistant.handle('Crea', context, 'thread'))).rejects.toMatchObject({ code: 'INBOUND_RECONCILIATION_REQUIRED' });
    expect(s.execute).toHaveBeenCalledTimes(1); expect(s.send).not.toHaveBeenCalled();
  });
  it('quarantines an unverified companion even though the principal task is confirmed', async () => {
    const call = { ...taskCreate, arguments: { title: 'Propuesta', dueDateIso: '2026-10-11T21:00:00Z' } };
    const s = setup([response([call]), response()]);
    await expect(s.run()).rejects.toMatchObject({ code: 'EFFECT_RECONCILIATION_REQUIRED' });
    const state = productivityCheckpointSchema.parse(s.snapshot().agentCoreProductivity);
    expect(state.phase).toBe('reconciliation_required');
    expect(state.completed?.requiresReconciliation).toBe(true);
    expect(state.effects[0]?.item).toMatchObject({ status: 'partial' });
    expect(s.send.mock.calls[0]?.[0].text).toContain('Propuesta');
    expect(s.send.mock.calls[0]?.[0].text).toContain('Completado parcialmente');
    expect(s.provider.requests).toHaveLength(1);
  });
  it('sends a warning for uncertain writes and blocks another tool write in the same batch', async () => {
    const s = setup([response([taskCreate, { ...taskCreate, id: 'second', arguments: { title: 'Otra', scheduleReminder: false } }])]);
    s.execute.mockRejectedValueOnce(new Error('receipt lost'));
    await expect(s.run()).rejects.toMatchObject({ code: 'EFFECT_RECONCILIATION_REQUIRED' });
    expect(s.execute).toHaveBeenCalledTimes(1);
    expect(s.send.mock.calls[0]?.[0].text).toContain('Resultado sin confirmar');
  });
  it('retains accepted text and quarantines an uncertain flow without retry', async () => {
    const s = setup([response([taskCreate]), response()]);
    s.send.mockResolvedValueOnce({ messageId: 'text-accepted' }).mockRejectedValueOnce(new Error('flow receipt lost'));
    await expect(s.run()).rejects.toMatchObject({ code: 'DELIVERY_OUTCOME_UNKNOWN' });
    expect(productivityCheckpointSchema.parse(s.snapshot().agentCoreProductivity).deliveries.map(entry => entry.status)).toEqual(['accepted', 'unknown']);
    await expect(s.run()).rejects.toMatchObject({ code: 'INBOUND_RECONCILIATION_REQUIRED' });
    expect(s.send).toHaveBeenCalledTimes(2);
  });
  it('keeps attempted delivery after provider acceptance cannot be checkpointed', async () => {
    const s = setup([response([calendarRead]), response()]); s.fail(6);
    await expect(s.run()).rejects.toThrow('storage unavailable');
    expect(productivityCheckpointSchema.parse(s.snapshot().agentCoreProductivity).deliveries[0]?.status).toBe('attempted');
    expect(s.send).toHaveBeenCalledTimes(1);
  });
  it('requires a lease, matching thread identity and host-owned recovery state', async () => {
    const s = setup();
    await expect(s.assistant.handle('Crea', context, 'thread')).rejects.toMatchObject({ code: 'INBOUND_LEASE_REQUIRED' });
    await expect(withTurnLease(s.lease, () => s.assistant.handle('Crea', context, 'foreign'))).rejects.toMatchObject({ code: 'INBOUND_IDENTITY_MISMATCH' });
    const recovery = { load: vi.fn(async () => undefined) };
    const assistant = new DurableProductivityAssistant(s.runner, { send: s.send }, undefined, recovery);
    await expect(withTurnLease(s.lease, () => assistant.handle('Crea', context, 'thread', {
      userId: 'owner', history: [], reminders: [], tasks: [], events: [], handledRequestIds: [],
    }))).rejects.toMatchObject({ code: 'RECOVERY_CHECKPOINT_OVERRIDE_FORBIDDEN' });
    expect(s.provider.requests).toHaveLength(0);
  });
  it('shares synchronous admission with the reminder-only engine on the same lease', async () => {
    const s = setup();
    const reminder = new DurableReminderAssistant(new ReminderTurnRunner(new MockAIProvider([{ response: response() }], () => 100),
      new ToolRegistry([]), { now: () => 100 }), { send: vi.fn() });
    await withTurnLease(s.lease, async () => {
      const first = s.assistant.handle('Crea', context, 'thread');
      await expect(reminder.handle('Otra', context, 'thread')).rejects.toMatchObject({ code: 'INBOUND_RECONCILIATION_REQUIRED' });
      await first;
    });
  });
  it('honors lease cancellation before transport dispatch', async () => {
    const s = setup([response([calendarRead]), response()]);
    vi.mocked(s.lease.checkpoint).mockImplementation(async patch => {
      const state = productivityCheckpointSchema.parse(patch.agentCoreProductivity);
      if (state.phase === 'delivering') s.controller.abort(new Error('lease lost'));
    });
    await expect(s.run()).rejects.toThrow('lease lost'); expect(s.send).not.toHaveBeenCalled();
  });
  it('delivers one deduplicated authorization CTA after its text and preserves its acceptance', async () => {
    const call = { id: 'oauth', name: 'calendar_connect', arguments: {} };
    const s = setup([response([call]), response()]);
    const result = await s.run();
    expect(result.reply.text).toContain('Conecta Google Calendar');
    expect(productivityCheckpointSchema.parse(s.snapshot().agentCoreProductivity).deliveries.map(entry => entry.message.kind)).toEqual(['text', 'cta']);
  });
  it('rejects a final checkpoint claiming unverified companions or changed delivery content are complete', async () => {
    const s = setup(); await s.run();
    const state = productivityCheckpointSchema.parse(s.snapshot().agentCoreProductivity);
    state.deliveries[0]!.message.text = 'Altered';
    expect(productivityCheckpointSchema.safeParse(state).success).toBe(false);
  });
});
