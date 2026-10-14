import { describe, expect, it, vi } from 'vitest';
import { jsonObjectSchema, reminderResolutionSchema, reminderCheckpointSchema, type ReminderRecord, type TurnContext } from '@templelabs/contracts';
import { withTurnLease, type InboundTurnLease } from '../../../src/agent/core/turn-lease.js';
import { reconcileReminderTurn, handoffLegacyReminderTurn, type LegacyReminderHandoffSource, type ReminderResolutionEvidencePort } from '../../../src/adapters/agent-core/reminder-turn-resolution.js';
import { checkpointFingerprint } from '../../../src/adapters/agent-core/checkpoint-fingerprint.js';

const id = '11111111-1111-4111-8111-111111111111';
const context: TurnContext = { userId: 'owner', runId: 'current', requestId: 'current-message', language: 'es',
  timezone: 'America/Bogota', referenceTimeIso: '2026-10-11T18:00:00Z', signal: new AbortController().signal,
  capabilities: new Set(['agent_core.reconcile', 'agent_core.handoff']) };
const record: ReminderRecord = { id, content: 'Llamar a Ana', sendAt: '2026-10-11T21:00:00Z', recurrence: null,
  isAdvanceNotice: false, parentReminderId: null, requiresConfirmation: true, acknowledgedAt: null };
const call = { id: 'previous-message:create', name: 'reminder_create', arguments: { content: record.content, targetTimeIso: record.sendAt } };
const item = { callId: call.id, toolName: 'reminder_create', status: 'success', code: null, readFilter: null, readQuery: null,
  result: { operation: 'create', records: [record], complete: true, coverage: 'operation', rejections: [],
    presentation: { canonicalCard: null, questions: [], cta: null } } };
function pending() {
  const state = reminderCheckpointSchema.parse({ version: 2, userId: 'owner', runId: 'previous', requestId: 'previous-message', phase: 'running',
    start: { text: 'Recuérdame llamar a Ana', conversation: { userId: 'owner', history: [], references: [], handledRequestIds: [] } },
    effects: [{ call, item: null, observation: null }], completed: null, deliveries: [] });
  return { id: 'previous', message_id: 'previous-message', thread_id: 'thread', sequence_id: 1, status: 'unknown', response: { agentCore: state } };
}
function setup() {
  const resolvePrior = vi.fn<NonNullable<InboundTurnLease['resolvePrior']>>(async () => {});
  const lease: InboundTurnLease = { inboundTurn: { id: 'current', messageId: 'current-message', threadId: 'thread', response: {} },
    signal: new AbortController().signal, assertActive: vi.fn(async () => {}), checkpoint: vi.fn(async () => {}), resolvePrior };
  const proof = { userId: 'owner', operationId: call.id, argumentsFingerprint: checkpointFingerprint(call.arguments), evidenceId: 'audit:create:1', item: structuredClone(item) };
  const evidence = { effect: vi.fn<ReminderResolutionEvidencePort['effect']>(async () => structuredClone(proof)), delivery: vi.fn<ReminderResolutionEvidencePort['delivery']>(async () => ({
    userId: 'owner', deliveryId: 'previous-message:reply:0', evidenceId: 'provider:receipt:1', outcome: 'accepted', messageId: 'wamid-verified',
  })) };
  return { lease, resolvePrior, proof, evidence,
    run: (row: unknown = pending(), ctx = context) => withTurnLease(lease, () => reconcileReminderTurn(row, ctx, evidence)) };
}
function legacy() { return { ...pending(), status: 'completed', response: {
  delivery: { status: 'accepted', messageId: 'legacy-accepted' }, confirmation: 'Untrusted card text; ID never parsed from here.',
  executionFacts: [{ tool: 'manage_reminder', success: true, outcome: 'success', presentationData: [{ id }] }],
} }; }
function source(): LegacyReminderHandoffSource { return { ownsThread: vi.fn(async () => true), hasActiveRun: vi.fn(async () => false),
  readOwnedReminder: vi.fn(async () => ({ userId: 'owner', record: { ...record, content: 'Fresh title from owned database' } })) }; }

describe('evidence-based reminder turn resolution', () => {
  it.each(['agentCoreProductivity','agentCoreActiveRun'])('rejects %s checkpoints before evidence reads or reminder-only resolution', async key => {
    const s = setup();
    await expect(s.run({ ...pending(), response: { ...pending().response, [key]: { version: 1 } } }))
      .rejects.toMatchObject({ code: 'RESOLUTION_ENGINE_MISMATCH' });
    expect(s.evidence.effect).not.toHaveBeenCalled();
    expect(s.resolvePrior).not.toHaveBeenCalled();
  });
  it.each(['agentCoreProductivity','agentCoreActiveRun'])('rejects %s checkpoints before legacy handoff owner/fact reads', async key => {
    const s = setup(); const facts = source();
    await expect(withTurnLease(s.lease, () => handoffLegacyReminderTurn({
      ...legacy(), response: { ...legacy().response, [key]: { version: 1 } },
    }, context, facts))).rejects.toMatchObject({ code: 'RESOLUTION_ENGINE_MISMATCH' });
    expect(facts.ownsThread).not.toHaveBeenCalled(); expect(s.resolvePrior).not.toHaveBeenCalled();
  });
  it('closes a committed write with an exact audit receipt, restores its ID and preserves original evidence', async () => {
    const s = setup();
    const row = pending();
    const original = structuredClone(row);
    const conversation = await s.run(row);
    expect(conversation.references).toEqual([record]);
    expect(conversation.handledRequestIds).toEqual(['previous-message']);
    expect(row).toEqual(original);
    expect(s.resolvePrior).toHaveBeenCalledTimes(1);
    const persisted = reminderResolutionSchema.parse(s.resolvePrior.mock.calls[0]![2]);
    expect(persisted).toMatchObject({ kind: 'reconciliation', sourceFingerprint: checkpointFingerprint(jsonObjectSchema.parse(row.response)),
      effectEvidence: [{ evidenceId: 'audit:create:1', operationId: call.id }] });
    expect(s.evidence.delivery).not.toHaveBeenCalled();
  });

  it.each(['user', 'operation', 'arguments', 'resource'] as const)('rejects mismatched %s evidence before closure', async kind => {
    const s = setup();
    if (kind === 'user') s.proof.userId = 'foreign';
    if (kind === 'operation') s.proof.operationId = 'other';
    if (kind === 'arguments') s.proof.argumentsFingerprint = '0'.repeat(64);
    if (kind === 'resource') s.proof.item.result.records = [];
    await expect(s.run()).rejects.toThrow();
    expect(s.resolvePrior).not.toHaveBeenCalled();
  });

  it('requires positive no-effect evidence and never repeats the write when it was rejected', async () => {
    const s = setup();
    s.evidence.effect.mockResolvedValueOnce({ ...s.proof, item: { ...item, status: 'failed', code: 'RECONCILED_NO_EFFECT', result: null } });
    const result = await s.run();
    expect(result.references).toEqual([]);
    expect(result.history.at(-1)).toMatchObject({ role: 'tool', isError: true, content: { status: 'failed' } });
    expect(s.resolvePrior).toHaveBeenCalledTimes(1);
  });

  it('refuses a generic failure/timeout as proof of no effect', async () => {
    const s = setup();
    s.evidence.effect.mockResolvedValueOnce({ ...s.proof, item: { ...item, status: 'failed', code: 'TIMEOUT', result: null } });
    await expect(s.run()).rejects.toMatchObject({ code: 'RESOLUTION_NO_EFFECT_PROOF_REQUIRED' });
    expect(s.resolvePrior).not.toHaveBeenCalled();
  });

  it('keeps closure blocked when no authoritative receipt is available', async () => {
    const s = setup();
    s.evidence.effect.mockResolvedValueOnce(null);
    await expect(s.run()).rejects.toThrow();
    expect(s.resolvePrior).not.toHaveBeenCalled();
  });

  it('requires a transport receipt for an uncertain send without resending it', async () => {
    const s = setup();
    const row = pending();
    row.response.agentCore.deliveries.push({ message: { id: 'previous-message:reply:0', kind: 'text', text: 'Reply' }, status: 'attempted', messageId: null });
    await s.run(row);
    const persisted = reminderResolutionSchema.parse(s.resolvePrior.mock.calls[0]![2]);
    expect(persisted.deliveryEvidence).toMatchObject([{ outcome: 'accepted', messageId: 'wamid-verified' }]);
    expect(s.evidence.delivery).toHaveBeenCalledTimes(1);
  });

  it('does not treat never-attempted delivery plans as ambiguous sends', async () => {
    const s = setup();
    const row = pending();
    row.response.agentCore.deliveries.push({ message: { id: 'planned-reply', kind: 'text', text: 'Reply' }, status: 'ready', messageId: null });
    await s.run(row);
    expect(s.evidence.delivery).not.toHaveBeenCalled();
  });

  it('fails closed for old interrupted checkpoints lacking a recoverable baseline', async () => {
    const s = setup();
    const row = pending();
    delete row.response.agentCore.start;
    await expect(s.run(row)).rejects.toMatchObject({ code: 'RESOLUTION_BASELINE_REQUIRED' });
    expect(s.evidence.effect).not.toHaveBeenCalled();
    expect(s.resolvePrior).not.toHaveBeenCalled();
  });

  it('requires a server-assigned capability and matching thread', async () => {
    const s = setup();
    await expect(s.run(undefined, { ...context, capabilities: new Set() })).rejects.toMatchObject({ code: 'RESOLUTION_ACCESS_DENIED' });
    await expect(s.run({ ...pending(), thread_id: 'foreign' })).rejects.toMatchObject({ code: 'RESOLUTION_IDENTITY_MISMATCH' });
    expect(s.resolvePrior).not.toHaveBeenCalled();
  });

  it('propagates stale-storage conflicts rather than reporting reconciliation as complete', async () => {
    const s = setup();
    s.resolvePrior.mockRejectedValueOnce(new Error('CAS conflict'));
    await expect(s.run()).rejects.toThrow('CAS conflict');
    expect(s.resolvePrior).toHaveBeenCalledTimes(1);
  });

  it('blocks closure after lease loss during evidence lookup', async () => {
    const s = setup();
    vi.mocked(s.lease.assertActive).mockResolvedValueOnce().mockRejectedValueOnce(new Error('lease lost'));
    await expect(s.run()).rejects.toThrow('lease lost');
    expect(s.resolvePrior).not.toHaveBeenCalled();
  });
});

describe('explicit legacy reminder handoff', () => {
  it('imports only backend fact IDs, refreshes their owned values and never uses legacy prose', async () => {
    const s = setup(); const own = source();
    const result = await withTurnLease(s.lease, () => handoffLegacyReminderTurn(legacy(), context, own));
    expect(result.references[0]?.content).toBe('Fresh title from owned database');
    expect(result.history).toEqual([]);
    expect(own.readOwnedReminder).toHaveBeenCalledWith(id, context);
    expect(JSON.stringify(result)).not.toContain('Untrusted card');
    expect(reminderResolutionSchema.parse(s.resolvePrior.mock.calls[0]![2]).kind).toBe('legacy_handoff');
  });

  it.each(['active', 'thread owner', 'record owner', 'record missing'] as const)('blocks handoff for %s', async kind => {
    const s = setup(); const own = source();
    if (kind === 'active') vi.mocked(own.hasActiveRun).mockResolvedValue(true);
    if (kind === 'thread owner') vi.mocked(own.ownsThread).mockResolvedValue(false);
    if (kind === 'record owner') vi.mocked(own.readOwnedReminder).mockResolvedValue({ userId: 'foreign', record });
    if (kind === 'record missing') vi.mocked(own.readOwnedReminder).mockResolvedValue(null);
    await expect(withTurnLease(s.lease, () => handoffLegacyReminderTurn(legacy(), context, own))).rejects.toThrow();
    expect(s.resolvePrior).not.toHaveBeenCalled();
  });

  it('refuses unconfirmed delivery and unknown legacy effects', async () => {
    const s = setup(); const own = source();
    const row = legacy(); row.response.delivery.status = 'attempted';
    await expect(withTurnLease(s.lease, () => handoffLegacyReminderTurn(row, context, own))).rejects.toThrow();
    row.response.delivery.status = 'accepted'; row.response.executionFacts[0]!.outcome = 'unknown';
    await expect(withTurnLease(s.lease, () => handoffLegacyReminderTurn(row, context, own))).rejects.toMatchObject({ code: 'HANDOFF_UNKNOWN_EFFECT' });
    expect(s.resolvePrior).not.toHaveBeenCalled();
  });

  it('deduplicates backend IDs before refreshing records', async () => {
    const s = setup(); const own = source(); const row = legacy();
    row.response.executionFacts[0]!.presentationData.push({ id });
    await withTurnLease(s.lease, () => handoffLegacyReminderTurn(row, context, own));
    expect(own.readOwnedReminder).toHaveBeenCalledTimes(1);
  });
});
