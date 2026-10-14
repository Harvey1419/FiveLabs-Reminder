import { describe, expect, it, vi } from 'vitest';
import { productivityCheckpointSchema, type TurnContext } from '@templelabs/contracts';
import { createProductivityStateRecovery, inspectProductivityTurn } from '../../../src/adapters/agent-core/productivity-state-recovery.js';
import { createReminderStateRecovery } from '../../../src/adapters/agent-core/reminder-state-recovery.js';
import type { InboundCheckpointClient } from '../../../src/adapters/agent-core/inbound-checkpoint-reader.js';
import { DurableProductivityAssistant } from '../../../src/adapters/agent-core/durable-productivity-assistant.js';
import { withTurnLease } from '../../../src/agent/core/turn-lease.js';
import { context, setup, taskId, response } from './productivity-fixtures.js';

const next: TurnContext = { ...context, runId: 'next-run', requestId: 'next-message' };
const anchor = { id: next.runId, message_id: next.requestId, thread_id: 'thread', sequence_id: 100, status: 'running' };
function row(response: unknown, status = 'completed') {
  return { id: 'run', message_id: 'request', thread_id: 'thread', sequence_id: 90, status, response };
}
function recoverySetup(prior: unknown, unknown: unknown = null) {
  const answers: { data: unknown; error: unknown }[] = [{ data: anchor, error: null }, { data: unknown, error: null }, { data: prior, error: null }];
  const queries: [string, unknown[]][][] = [];
  const client: InboundCheckpointClient = { from(table) {
    const calls: [string, unknown[]][] = [['from', [table]]]; queries.push(calls);
    const query = {
      eq: (column: string, value: string) => { calls.push(['eq', [column, value]]); return query; },
      lt: (column: string, value: number) => { calls.push(['lt', [column, value]]); return query; },
      in: (column: string, values: string[]) => { calls.push(['in', [column, values]]); return query; },
      order: (column: string, options: { ascending: boolean }) => { calls.push(['order', [column, options]]); return query; },
      limit: (count: number) => { calls.push(['limit', [count]]); return query; },
      abortSignal: (signal: AbortSignal) => { calls.push(['abortSignal', [signal]]); return query; },
      maybeSingle: async () => { const result = answers.shift(); if (!result) throw new Error('Unexpected query'); return result; },
    };
    return { select(columns) { calls.push(['select', [columns]]); return query; } };
  } };
  const s = setup();
  const lease = { ...s.lease, inboundTurn: { ...s.lease.inboundTurn, id: next.runId, messageId: next.requestId } };
  const recovery = createProductivityStateRecovery(client);
  return { client, lease, recovery, queries, answers, run: () => withTurnLease(lease, () => recovery.load(next, 'thread')) };
}
async function saved() {
  const first = setup(); await first.run(); return first.snapshot();
}
describe('owned mixed checkpoint continuity', () => {
  it('restores all verified domains and scopes every queue read to the leased thread', async () => {
    const snapshot = await saved(); const s = recoverySetup(row(snapshot));
    const state = await s.run();
    expect(state?.tasks[0]?.id).toBe(taskId);
    expect(state?.reminders).toHaveLength(1); expect(state?.events).toHaveLength(1);
    expect(state?.handledRequestIds).toEqual(['request']);
    for (const query of s.queries) {
      expect(query).toContainEqual(['eq', ['thread_id', 'thread']]); expect(query).toContainEqual(['limit', [1]]);
      expect(query).toContainEqual(['abortSignal', [expect.any(AbortSignal)]]);
    }
    expect(s.queries[1]).toContainEqual(['order', ['sequence_id', { ascending: false }]]);
    expect(s.queries[2]).toContainEqual(['lt', ['sequence_id', 100]]);
  });
  it('continues with the previously verified task ID without replaying old effects or deliveries', async () => {
    const snapshot = await saved(); const recovery = recoverySetup(row(snapshot));
    const second = setup([response([{ id: 'complete', name: 'task_complete', arguments: { taskId } }]), response()]);
    const assistant = new DurableProductivityAssistant(second.runner, { send: second.send }, undefined, recovery.recovery);
    const result = await withTurnLease(recovery.lease, () => assistant.handle('Completa esa tarea', next, 'thread'));
    expect(result.conversation.tasks[0]?.status).toBe('completed');
    expect(result.conversation.handledRequestIds).toEqual(['request', 'next-message']);
    expect(second.execute).toHaveBeenCalledTimes(1);
    expect(second.execute.mock.calls[0]?.[0].params).toMatchObject({ action: 'complete', target: taskId });
    expect(second.send).toHaveBeenCalledTimes(2);
  });
  it('starts empty only when no prior turn exists', async () => {
    expect(await recoverySetup(null).run()).toBeUndefined();
  });
  it('blocks an older uncertain delivery despite a more recent completed mixed checkpoint', async () => {
    const snapshot = await saved();
    const state = productivityCheckpointSchema.parse(snapshot.agentCoreProductivity);
    state.phase = 'delivering'; state.deliveries[0]!.status = 'unknown'; state.deliveries[0]!.messageId = null;
    const s = recoverySetup(row(snapshot), { ...row({ agentCoreProductivity: state }, 'unknown'), sequence_id: 1 });
    await expect(s.run()).rejects.toMatchObject({ code: 'PRIOR_TURN_RECONCILIATION_REQUIRED', report: { pendingDeliveryIds: ['request:reply:0'] } });
    expect(s.queries).toHaveLength(2);
  });
  it.each(['owner', 'version', 'reply', 'receipt', 'order'] as const)('blocks corrupted mixed checkpoint %s', async kind => {
    const snapshot = await saved(); const state = productivityCheckpointSchema.parse(snapshot.agentCoreProductivity);
    const raw: Record<string, unknown> = structuredClone(state);
    if (kind === 'owner') raw.userId = 'foreign';
    if (kind === 'version') raw.version = 2;
    if (kind === 'reply') state.deliveries[0]!.message.text = 'Changed';
    if (kind === 'receipt') state.deliveries[0]!.messageId = null;
    if (kind === 'order') state.effects.reverse();
    await expect(recoverySetup(row({ agentCoreProductivity: kind === 'owner' || kind === 'version' ? raw : state })).run())
      .rejects.toMatchObject({ code: 'PRIOR_TURN_RECONCILIATION_REQUIRED', report: { reason: 'invalid_checkpoint' } });
  });
  it('requires explicit handoff for reminder-only/legacy state rather than dropping its continuity', async () => {
    await expect(recoverySetup(row({ agentCore: { version: 2 } })).run()).rejects.toMatchObject({
      code: 'PRIOR_TURN_RECONCILIATION_REQUIRED', report: { reason: 'engine_handoff_required' },
    });
  });
  it.each(['agentCoreResolution','agentCoreActiveRun','agentCoreActiveResolution','agentCoreDeliveryManifest','agentCoreBaseline','agentCoreActiveCompletion'])('rejects %s evidence attached to a mixed checkpoint', async key => {
    const snapshot = await saved();
    await expect(recoverySetup(row({ ...snapshot, [key]: { kind: 'reconciliation' } })).run())
      .rejects.toMatchObject({ code: 'PRIOR_TURN_RECONCILIATION_REQUIRED' });
    const s = recoverySetup(row(snapshot));
    await expect(withTurnLease(s.lease, () => createReminderStateRecovery(s.client).load(next, 'thread')))
      .rejects.toMatchObject({ code: 'PRIOR_TURN_RECONCILIATION_REQUIRED' });
  });
  it('reports unconfirmed companion operation IDs as pending verification', async () => {
    const s = setup([response([{ id: 'task', name: 'task_create', arguments: { title: 'Propuesta', dueDateIso: '2026-10-11T21:00:00Z' } }])]);
    await expect(s.run()).rejects.toMatchObject({ code: 'EFFECT_RECONCILIATION_REQUIRED' });
    expect(inspectProductivityTurn(row(s.snapshot(), 'unknown'), 'owner').pendingEffectIds).toEqual(['request:task']);
  });
  it('rechecks ownership and storage errors before returning prior state', async () => {
    const s = recoverySetup(row(await saved()));
    vi.mocked(s.lease.assertActive).mockResolvedValueOnce().mockRejectedValueOnce(new Error('lease lost'));
    await expect(s.run()).rejects.toThrow('lease lost');
    const other = recoverySetup(null);
    other.answers[0]!.error = new Error('storage unavailable');
    await expect(other.run()).rejects.toMatchObject({ code: 'CHECKPOINT_STORAGE_UNAVAILABLE' });
  });
});
