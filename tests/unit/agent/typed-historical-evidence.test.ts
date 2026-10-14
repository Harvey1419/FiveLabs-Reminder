import { describe, it, expect, vi } from 'vitest';
import { createHistoricalEvidence, type HistoricalEvidenceFact, type HistoricalEvidenceDependencies } from '../../../src/agent/orchestration/historical-evidence.js';
import { formatCanonicalTaskCreate, formatCanonicalTaskUpdate, formatCanonicalTaskComplete } from '../../../src/shared/task-presentation.js';
import { formatCanonicalTaskList } from '../../../src/shared/agenda-presentation.js';
import { formatCanonicalReminderCreate, formatCanonicalReminderList } from '../../../src/shared/reminder-presentation.js';
import { sanitizeResponseText } from '../../../src/agent/core/working-memory-cache.js';
function fixture() {
  let counter = 0;
  const deps: HistoricalEvidenceDependencies = { randomUUID: vi.fn(() => `11111111-1111-4111-8111-${String(++counter).padStart(12, '0')}`), formatCanonicalTaskCreate, formatCanonicalTaskUpdate, formatCanonicalTaskComplete, formatCanonicalTaskList, formatCanonicalReminderCreate, formatCanonicalReminderList };
  return { deps, ...createHistoricalEvidence(deps) };
}
const owner = 'owner';
const row = { id: 'private-id', user_id: owner, title: 'Observed task', status: 'pending' };
const context = { language: 'en', timezone: 'UTC' };
function taskFact(action = 'list', rows: unknown[] = [row]): HistoricalEvidenceFact {
  const data = { tasks: rows, scope: 'today' };
  const formatter = action === 'create' ? formatCanonicalTaskCreate : action === 'complete' ? formatCanonicalTaskComplete : action === 'update' ? formatCanonicalTaskUpdate : formatCanonicalTaskList;
  return { tool: 'manage_task', requestedAction: action, success: true, complete: true, outcome: 'success', callId: 'observed-call', presentationData: data, presentationContext: context, card: sanitizeResponseText(formatter(data, context)) };
}
const turn = (carry: unknown, role = 'assistant') => ({ role, entities: { _turnMetadata: { operationalEvidence: carry } } });
describe('typed owner-scoped historical observations', () => {
  it('carries without reminting, excludes user metadata and rejects another owner', () => {
    const f = fixture(); const first = f.carryOperationalEvidence([], [taskFact()], owner);
    expect(first.owner).not.toBe(owner); expect(first.events).toHaveLength(1);
    const carried = f.carryOperationalEvidence([turn(first)], [], owner);
    expect(carried).toEqual(first); expect(f.deps.randomUUID).toHaveBeenCalledTimes(1);
    expect(f.operationalEvidenceFromHistory([turn(first, 'user')], owner)).toEqual([]);
    expect(f.operationalEvidenceFromHistory([turn(first)], 'another')).toEqual([]);
    const read = f.operationalEvidenceFromHistory([turn(first)], owner); read[0]!.summary = 'Changed copy';
    expect(first.events[0]?.summary).not.toBe('Changed copy');
  });
  it('replaces successful reads but keeps genuine failure and unknown observations', () => {
    const f = fixture(); const first = f.carryOperationalEvidence([], [taskFact(), { ...taskFact(), success: false, outcome: 'unknown' }], owner);
    const next = f.carryOperationalEvidence([turn(first)], [taskFact()], owner);
    expect(next.events).toHaveLength(2); expect(next.events.map(e => e.outcome)).toEqual(['unknown', 'success']);
  });
  it.each(['complete', 'update'])('requires complete owned rows, a call identity and canonical card for task.%s', action => {
    const f = fixture(); const valid = taskFact(action);
    expect(f.carryOperationalEvidence([], [valid], owner).events).toHaveLength(1);
    for (const patch of [{ complete: false }, { outcome: 'unknown' }, { callId: '' }, { card: 'Model says done' }, { presentationData: { tasks: [{ ...row, user_id: 'another' }] } }]) {
      expect(f.carryOperationalEvidence([], [{ ...valid, ...patch }], owner).events).toEqual([]);
    }
  });
  it('bounds Unicode by UTF-8 bytes and reports clipping without splitting characters', () => {
    const f = fixture(); const fact = taskFact('create', [{ ...row, title: '🙂'.repeat(500) }]);
    const carry = f.carryOperationalEvidence([], [fact], owner);
    expect(carry.events[0]?.clipped).toBe(true); expect(Buffer.byteLength(carry.events[0]!.summary)).toBeLessThanOrEqual(600);
    expect(carry.events[0]?.summary).not.toContain('�'); expect(Buffer.byteLength(JSON.stringify(carry))).toBeLessThanOrEqual(4096);
    expect(f.renderHistoricalEvidence([turn(carry)], undefined, owner, 'en')).toContain('Partial/clipped evidence');
  });
  it('bounds total snapshots and history, rejects duplicate refs and extra metadata', () => {
    const f = fixture(); const facts = Array.from({ length: 12 }, () => taskFact('create', [{ ...row, title: 'x'.repeat(800) }]));
    const carry = f.carryOperationalEvidence([], facts, owner);
    expect(carry.events.length).toBeLessThanOrEqual(8); expect(Buffer.byteLength(JSON.stringify(carry))).toBeLessThanOrEqual(4096);
    expect(f.operationalEvidenceFromHistory([turn({ ...carry, extra: true })], owner)).toEqual([]);
    expect(f.operationalEvidenceFromHistory([turn({ ...carry, events: [carry.events[0], carry.events[0]] })], owner)).toEqual([]);
    expect(f.operationalEvidenceFromHistory([turn(carry), ...Array.from({ length: 30 }, () => ({ role: 'user' }))], owner)).toEqual([]);
  });
  it('requires observed null capability fields for subscription info instead of interpreting payment prose', () => {
    const f = fixture(); const billing = { tool: 'manage_subscription', requestedAction: 'info', success: true, outcome: 'success' };
    expect(f.carryOperationalEvidence([], [{ ...billing, card: 'Payment failed' }], owner).events).toEqual([]);
    const data = Object.fromEntries(['price', 'discounts', 'paymentMethods', 'checkoutConfirmation', 'chargeOutcome', 'paymentOutcome', 'subscriptionStatus'].map(key => [key, null]));
    expect(f.carryOperationalEvidence([], [{ ...billing, presentationData: data }], owner).events[0]?.summary).toContain('No reintentar pagos');
  });
  it('stores fixed interpretation diagnostics separately from genuine tool failure', () => {
    const f = fixture(); const carry = f.carryOperationalEvidence([], [taskFact()], owner, 'reference_unresolved');
    expect(carry.events.map(e => [e.operation, e.outcome])).toEqual([['task.list', 'success'], ['interpretation.read', 'partial_success']]);
    const rejected = f.carryOperationalEvidence([], [taskFact()], owner, 'rejected');
    expect(rejected.events[1]?.summary).toContain('Las consultas exitosas conservaron sus resultados');
    expect(rejected.events[1]?.summary).not.toContain('observed-call');
  });
  it('defaults omitted historical selectors to available refs and fails closed on explicit empty or invalid selectors', () => {
    const f = fixture(); const carry = f.carryOperationalEvidence([], [taskFact()], owner); const history = [turn(carry)];
    expect(f.renderHistoricalEvidence(history, undefined, owner, 'en')).toContain('Observed task');
    for (const refs of [[], ['missing'], [carry.events[0]!.ref, carry.events[0]!.ref]]) expect(f.renderHistoricalEvidence(history, refs, owner, 'en')).toContain('unavailable');
  });
});
describe('typed historical creation quotes', () => {
  it('requires the canonical card before redaction and preserves distinct identical creations without replay', () => {
    const f = fixture(); const fact = taskFact('create'); const receipts = f.mutationReceiptsFromFacts([fact, fact]);
    expect(receipts).toHaveLength(2); expect(f.mutationReceiptsFromFacts([{ ...fact, card: 'tampered' }])).toEqual([]);
    const events = f.carryCreationReceiptEvents([], receipts); expect(events[0]?.eventId).not.toBe(events[1]?.eventId);
    const history = [{ role: 'assistant', entities: { _turnMetadata: { creationReceiptEvents: events } } }];
    expect(f.carryCreationReceiptEvents(history, [])).toEqual(events); expect(f.historicalMutationReceipts(history)).toEqual(receipts);
    expect(f.historicalRecap(history, 'en', 'Generated success claim')).not.toContain('Generated success claim');
  });
  it('clips at six receipts and quotes line breaks without treating them as current verification', () => {
    const f = fixture(); const receipt = { operation: 'task.create', summary: 'Created\nSecond line' };
    const events = f.carryCreationReceiptEvents([], Array.from({ length: 10 }, () => receipt)); expect(events).toHaveLength(6);
    expect(f.receiptBlock([receipt], 'en', true)).toContain('> task.create: Created\n> Second line');
    expect(f.receiptBlock([receipt], 'en', true)).toContain('unverified');
  });
});
