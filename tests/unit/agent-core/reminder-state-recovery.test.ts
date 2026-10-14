import { describe, expect, it, vi } from 'vitest';
import { reminderCheckpointSchema, type JsonObject, type ReminderCheckpoint, type TurnContext } from '@templelabs/contracts';
import { withTurnLease, type InboundTurnLease } from '../../../src/agent/core/turn-lease.js';
import { createReminderStateRecovery, inspectReminderTurn, type ReminderCheckpointClient } from '../../../src/adapters/agent-core/reminder-state-recovery.js';
import { checkpointFingerprint } from '../../../src/adapters/agent-core/checkpoint-fingerprint.js';

const context: TurnContext = { userId: 'owner', runId: 'current', requestId: 'current-message', language: 'es',
  timezone: 'America/Bogota', referenceTimeIso: '2026-10-11T17:49:00Z', capabilities: new Set(), signal: new AbortController().signal };
function checkpoint(): ReminderCheckpoint {
  return reminderCheckpointSchema.parse({ version: 2, userId: 'owner', runId: 'previous', requestId: 'previous-message', phase: 'completed',
    effects: [], completed: { conversation: { userId: 'owner', history: [{ role: 'user', content: 'Anterior' }, { role: 'assistant', content: '', toolCalls: [] }],
      references: [], handledRequestIds: ['previous-message'] }, uiPayload: { language: 'es', timezone: context.timezone, items: [], notices: [] },
      reply: { text: 'Anterior', ctas: [] } }, deliveries: [{ message: { id: 'reply-0', kind: 'text', text: 'Anterior' }, status: 'accepted', messageId: 'accepted-0' }] });
}
const anchor = { id: 'current', message_id: 'current-message', thread_id: 'thread', sequence_id: 100, status: 'running' };
function previous(state: unknown = checkpoint()) {
  return { id: 'previous', message_id: 'previous-message', thread_id: 'thread', sequence_id: 90,
    status: 'completed', response: { agentCore: state } };
}
function setup(results: { data: unknown; error?: unknown }[] = [{ data: anchor }, { data: null }, { data: previous() }]) {
  const queries: [string, unknown[]][][] = [];
  const client: ReminderCheckpointClient = { from(table) {
    const calls: [string, unknown[]][] = [['from', [table]]];
    queries.push(calls);
    const query = {
      eq: (column: string, value: string) => { calls.push(['eq', [column, value]]); return query; },
      lt: (column: string, value: number) => { calls.push(['lt', [column, value]]); return query; },
      in: (column: string, values: string[]) => { calls.push(['in', [column, values]]); return query; },
      order: (column: string, options: { ascending: boolean }) => { calls.push(['order', [column, options]]); return query; },
      limit: (count: number) => { calls.push(['limit', [count]]); return query; },
      abortSignal: (signal: AbortSignal) => { calls.push(['abortSignal', [signal]]); return query; },
      maybeSingle: async () => { calls.push(['maybeSingle', []]); const next = results.shift();
        if (!next) throw new Error('Unexpected query'); return { data: next.data, error: next.error ?? null }; },
    };
    return { select(columns) { calls.push(['select', [columns]]); return query; } };
  } };
  const controller = new AbortController();
  const lease: InboundTurnLease = { inboundTurn: { id: 'current', messageId: 'current-message', threadId: 'thread', response: {} },
    signal: controller.signal, assertActive: vi.fn(async () => {}), checkpoint: vi.fn(async () => {}) };
  const recovery = createReminderStateRecovery(client);
  return { recovery, lease, controller, queries, run: () => withTurnLease(lease, () => recovery.load(context, 'thread')) };
}

describe('owned durable reminder checkpoint recovery', () => {
  it('restores a resolved turn while leaving its original interrupted checkpoint unchanged', async () => {
    const state = checkpoint();
    state.phase = 'delivering';
    state.deliveries[0]!.status = 'unknown';
    state.deliveries[0]!.messageId = null;
    const row = previous(state);
    const source: JsonObject = JSON.parse(JSON.stringify(row.response));
    const resolution = { version: 1, kind: 'reconciliation', userId: 'owner', runId: 'previous', requestId: 'previous-message',
      threadId: 'thread', sourceFingerprint: checkpointFingerprint(source), decidedAtIso: context.referenceTimeIso,
      conversation: state.completed!.conversation, effectEvidence: [], deliveryEvidence: [{ userId: 'owner', deliveryId: 'reply-0',
        evidenceId: 'provider:verified', outcome: 'accepted', messageId: 'recovered-provider-id' }] };
    const resolved = { ...row, response: { ...source, agentCoreResolution: resolution } };
    expect(await setup([{ data: anchor }, { data: null }, { data: resolved }]).run()).toEqual(state.completed!.conversation);
    expect(state.phase).toBe('delivering');
    expect(state.deliveries[0]?.status).toBe('unknown');
    await expect(setup([{ data: anchor }, { data: null }, { data: { ...resolved, response: {
      ...source, agentCoreResolution: { ...resolution, deliveryEvidence: [] },
    } } }]).run()).rejects.toMatchObject({ code: 'PRIOR_TURN_RECONCILIATION_REQUIRED' });
  });

  it('rejects a resolution detached from the original source fingerprint', async () => {
    const state = checkpoint(); const row = previous(state);
    const resolution = { version: 1, kind: 'legacy_handoff', userId: 'owner', runId: 'previous', requestId: 'previous-message',
      threadId: 'thread', sourceFingerprint: '0'.repeat(64), decidedAtIso: context.referenceTimeIso,
      conversation: state.completed!.conversation, effectEvidence: [], deliveryEvidence: [] };
    await expect(setup([{ data: anchor }, { data: null }, { data: { ...row, response: { ...row.response, agentCoreResolution: resolution } } }]).run())
      .rejects.toMatchObject({ code: 'PRIOR_TURN_RECONCILIATION_REQUIRED' });
  });
  it('restores the latest complete conversation and scopes every read to the leased thread/order', async () => {
    const s = setup();
    expect(await s.run()).toEqual(checkpoint().completed!.conversation);
    expect(s.queries).toHaveLength(3);
    expect(s.queries[0]).toContainEqual(['eq', ['id', 'current']]);
    expect(s.queries[0]).toContainEqual(['eq', ['message_id', 'current-message']]);
    for (const query of s.queries) {
      expect(query).toContainEqual(['eq', ['thread_id', 'thread']]);
      expect(query).toContainEqual(['limit', [1]]);
      expect(query.findIndex(call => call[0] === 'abortSignal')).toBeLessThan(query.findIndex(call => call[0] === 'maybeSingle'));
      expect(query.find(call => call[0] === 'select')?.[1][0]).not.toContain('request');
    }
    expect(s.queries[1]).toContainEqual(['eq', ['status', 'unknown']]);
    expect(s.queries[1]).toContainEqual(['order', ['sequence_id', { ascending: false }]]);
    expect(s.queries[2]).toContainEqual(['lt', ['sequence_id', 100]]);
    expect(s.queries[2]).toContainEqual(['order', ['sequence_id', { ascending: false }]]);
  });

  it('starts empty only when history is actually absent', async () => {
    expect(await setup([{ data: anchor }, { data: null }, { data: null }]).run()).toBeUndefined();
  });

  it('blocks an older unknown turn even if a more recent complete checkpoint exists', async () => {
    const state = { ...checkpoint(), phase: 'delivering', deliveries: [{ ...checkpoint().deliveries[0]!, status: 'attempted', messageId: null }] };
    const s = setup([{ data: anchor }, { data: { ...previous(state), status: 'unknown', sequence_id: 1 } }, { data: previous() }]);
    await expect(s.run()).rejects.toMatchObject({ code: 'PRIOR_TURN_RECONCILIATION_REQUIRED',
      report: { runId: 'previous', pendingDeliveryIds: ['reply-0'], hasCompletedConversation: true } });
    expect(s.queries).toHaveLength(2);
  });

  it.each(['version', 'owner', 'receipt', 'transcript', 'final ui'] as const)('blocks a corrupt %s checkpoint instead of silently starting over', async kind => {
    const state: Record<string, unknown> = structuredClone(checkpoint());
    if (kind === 'version') state.version = 3;
    if (kind === 'owner') state.userId = 'foreign';
    if (kind === 'receipt') state.deliveries = [{ ...checkpoint().deliveries[0]!, messageId: null }];
    if (kind === 'transcript') state.completed = { ...checkpoint().completed!, conversation: { ...checkpoint().completed!.conversation,
      history: [{ role: 'assistant', content: '', toolCalls: [{ id: 'pending', name: 'reminder_create', arguments: {} }] }] } };
    if (kind === 'final ui') state.completed = { ...checkpoint().completed!, uiPayload: { ...checkpoint().completed!.uiPayload,
      items: [{ callId: 'ghost', toolName: 'reminder_create', status: 'failed', code: 'FAIL', result: null, readFilter: null, readQuery: null }] } };
    await expect(setup([{ data: anchor }, { data: null }, { data: previous(state) }]).run()).rejects.toMatchObject({
      code: 'PRIOR_TURN_RECONCILIATION_REQUIRED', report: { reason: 'invalid_checkpoint' },
    });
  });

  it('requires explicit legacy handoff when the latest prior turn has no V2 state', async () => {
    await expect(setup([{ data: anchor }, { data: null }, { data: { ...previous(), response: { confirmation: 'Legacy' } } }]).run())
      .rejects.toMatchObject({ code: 'PRIOR_TURN_RECONCILIATION_REQUIRED', report: { reason: 'legacy_handoff_required' } });
  });

  it.each([0, 1, 2])('fails closed when storage read %s fails', async index => {
    const results: { data: unknown; error?: unknown }[] = [{ data: anchor }, { data: null }, { data: previous() }];
    results[index] = { data: null, error: new Error('private database details') };
    await expect(setup(results).run()).rejects.toMatchObject({ code: 'CHECKPOINT_STORAGE_UNAVAILABLE' });
  });

  it.each(['thread', 'sequence', 'run'] as const)('rejects a returned row with invalid %s', async kind => {
    const row = previous();
    if (kind === 'thread') row.thread_id = 'foreign';
    if (kind === 'sequence') row.sequence_id = 101;
    if (kind === 'run') row.id = 'current';
    await expect(setup([{ data: anchor }, { data: null }, { data: row }]).run()).rejects.toThrow('Invalid prior turn');
  });

  it('rechecks ownership after history reads before returning state', async () => {
    const s = setup();
    vi.mocked(s.lease.assertActive).mockResolvedValueOnce().mockRejectedValueOnce(new Error('lease lost'));
    await expect(s.run()).rejects.toThrow('lease lost');
    expect(s.queries).toHaveLength(2);
  });

  it('inspects pending effects without treating matching content as a verified receipt', () => {
    const state = { ...checkpoint(), phase: 'running', completed: null, deliveries: [], effects: [{
      call: { id: 'pending-create', name: 'reminder_create', arguments: { content: 'Same title' } }, item: null, observation: null,
    }] };
    expect(inspectReminderTurn({ ...previous(state), status: 'unknown' }, 'owner')).toEqual({ runId: 'previous',
      reason: 'unknown_turn', pendingEffectIds: ['pending-create'], pendingDeliveryIds: [], hasCompletedConversation: false });
  });
});
