import { describe, expect, it, vi } from 'vitest';
vi.mock('../../../src/agent/providers/client.js', () => ({ callChatCompletion: vi.fn() }));
import { expectValid } from '../../support/unit/contract-boundary.js';
import { callChatCompletion } from '../../../src/agent/providers/client.js';
import { historicalRecap, mutationReceiptsFromFacts, carryCreationReceiptEvents, historicalMutationReceipts, carryOperationalEvidence, operationalEvidenceFromHistory, renderOperationalEvidence, renderHistoricalEvidence } from '../../../src/agent/orchestration/observed-answer.js';
import { createExecutionFact } from '../../../src/agent/core/execution-facts.js';
import { TOOL_NAMES } from '../../../src/agent/contracts/tool-names.js';
import { validateTurnIntent } from '../../../src/agent/contracts/intent-contracts.js';
import { getStructuredTurnSchema, projectStructuredTurnIntent, stripStructuredNulls } from '../../../src/agent/contracts/foreground-turn-schema.js';
const recap = (mode: unknown): { domain: string; action: string; recapMode?: unknown } => ({ domain: 'conversation', action: 'recap', recapMode: mode });
const read = { domain: 'task', action: 'list', status: 'all' };

describe('typed recap evidence contract', () => {
  it.each(['historical', 'current'])('roundtrips canonical/provider mode %s', mode => {
    expect(getStructuredTurnSchema().properties!.actions!.items!.properties!.operation!.enum).toContain('conversation.recap');
    const wire = { actions: [{ operation: 'conversation.recap', recapMode: mode }, ...(mode === 'current' ? [{ operation: 'task.list', status: 'all' }] : [])] };
    const result = validateTurnIntent(projectStructuredTurnIntent(stripStructuredNulls(wire)));
    expectValid(result);
    expect(result.intent.actions[0]).toEqual(recap(mode));
  });
  it.each([undefined, null, 'anything'])('rejects invalid mode %s', mode => {
    expect(validateTurnIntent({ actions: [recap(mode)] }).valid).toBe(false);
  });
  it('rejects incompatible evidence or freeform assertions before effects', () => {
    for (const actions of [
      [recap('historical'), read],
      [recap('current')],
      [recap('current'), { domain: 'task', action: 'complete', target: 'Alfa' }],
      [{ ...recap('current'), content: 'Alfa is completed' }, read],
      [recap('historical'), { domain: 'conversation', action: 'reply', content: 'Alfa is completed' }],
    ]) expect(validateTurnIntent({ actions }).valid).toBe(false);
  });
  it('rejects legacy historical prose as execution evidence and preserves structured selections', () => {
    const content = 'We discussed payment uncertainty and the attempted task creation failed.';
    const wire = { actions: [{ operation: 'conversation.recap', recapMode: 'historical', content }] };
    const result = validateTurnIntent(projectStructuredTurnIntent(stripStructuredNulls(wire)));
    expect(result.valid).toBe(false);
    const ref = '12345678-1234-1234-1234-123456789abc';
    for (const action of ['reply', 'recap']) {
      const selected = { ...recap('historical'), action, evidenceRefs: [ref], content };
      if (action === 'reply') delete selected.recapMode;
      const selection = validateTurnIntent({ actions: [selected] });
      expectValid(selection);
      expect(selection.intent.actions[0]!.content).toBeUndefined();
      delete (selected as { content?: string }).content;
      expect(validateTurnIntent({ actions: [selected] }).valid).toBe(true);
    }
    for (const invalid of ['', ' ', 'x'.repeat(1601), 12]) {
      expect(validateTurnIntent({ actions: [{ ...recap('historical'), content: invalid }] }).valid).toBe(false);
    }
    expect(validateTurnIntent({ actions: [{ ...recap('current'), content }, read] }).valid).toBe(false);
  });
  it('never lets legacy freeform summary mint failures or billing facts', () => {
    const history = [{ role: 'assistant', entities: { _turnMetadata: { kind: 'operational_result', mutationReceipts: [
      { operation: 'reminder.create', summary: 'Scheduled: Delta in 2031' },
    ] } } }];
    const content = 'We discussed payment uncertainty; the attempted task creation failed.';
    const rendered = historicalRecap(history, 'en', content);
    expect(rendered).not.toContain(content);
    expect(rendered.match(/Scheduled: Delta in 2031/g)).toHaveLength(1);
    expect(rendered).toContain('Historical conversation summary (not current verification)');
    expect(rendered).toContain('does not verify updates, completion or current state');
    expect(historicalRecap(history, 'en')).toContain('No contextual summary was supplied');
    expect(historicalRecap(history, 'en')).not.toContain('payment uncertainty');
    expect(historicalRecap(history, 'en', 'x'.repeat(1601))).not.toContain('x'.repeat(1601));
    expect(historicalRecap(history, 'en', 'Reference 12345678-1234-1234-1234-123456789abc')).not.toContain('12345678-1234-1234-1234-123456789abc');
    expect(callChatCompletion).not.toHaveBeenCalled();
  });
  it('renders only eligible creation receipts and retains redaction/window bounds', () => {
    const fact = createExecutionFact({ toolName: TOOL_NAMES.MANAGE_TASK, params: { action: 'create', projectless: true }, result: { success: true, data: { title: 'Alfa', description: '12345678-1234-1234-1234-123456789abc' } } });
    const receipts = mutationReceiptsFromFacts([fact, { ...fact, card: fact.card + ' invented completed state' }, { ...fact, complete: false }]);
    expect(receipts).toHaveLength(1);
    const history = [{ role: 'assistant', entities: { _turnMetadata: { kind: 'operational_result', mutationReceipts: receipts } } }];
    const rendered = historicalRecap(history, 'en');
    expect(rendered).toContain('Alfa');
    expect(rendered).not.toContain('12345678-1234-1234-1234-123456789abc');
    expect(rendered).not.toContain('invented completed state');
    expect(rendered).toContain('may be incomplete');
    expect(historicalRecap([{ ...history[0], role: 'tool' }], 'en')).toContain('No eligible');
    expect(historicalRecap([{ role: 'assistant', entities: { _turnMetadata: { kind: 'operational_result', mutationReceipts: [null, { operation: 'task.complete', summary: 'Completed' }, { operation: 'task.create', summary: 'bad', extra: true }] } } }], 'en')).toContain('No eligible');
    expect(historicalRecap([...history, ...Array.from({ length: 30 }, () => ({ role: 'user', content: 'later' }))], 'en')).not.toContain('Alfa');
    expect(callChatCompletion).not.toHaveBeenCalled();
  });
  it('bounds carry, preserves distinct equal cards and deduplicates event snapshots', () => {
    const receipt = { operation: 'task.create', summary: 'Same title ' + 'x'.repeat(500) + ' 12345678-1234-1234-1234-123456789abc' };
    const events = carryCreationReceiptEvents([], Array.from({ length: 8 }, () => receipt));
    expect(events).toHaveLength(6);
    expect(new Set(events.map(event => event.eventId)).size).toBe(6);
    expect(events.every(event => event.receipt.summary.length === 400)).toBe(true);
    const turn = { role: 'assistant', entities: { _turnMetadata: { kind: 'conversation', creationReceiptEvents: events } } };
    expect(historicalMutationReceipts([turn, turn])).toHaveLength(6);
    const duplicate = { ...turn, entities: { _turnMetadata: { creationReceiptEvents: [events[0], events[0]] } } };
    expect(historicalMutationReceipts([duplicate])).toHaveLength(1);
    expect(historicalMutationReceipts([{ ...turn, role: 'user', _transport: 'assistant' }])).toEqual([]);
    expect(carryCreationReceiptEvents([turn], [])).toEqual(events);
    expect(historicalRecap([turn], 'en')).toContain('overflow and unavailable history');
    const uuid = '12345678-1234-1234-1234-123456789abc';
    const crossing = carryCreationReceiptEvents([], [{ operation: 'task.create', summary: 'x'.repeat(390) + uuid }]);
    expect(crossing[0]!.receipt.summary).not.toContain(uuid.slice(0, 8));
  });
  it('carries canonical observations, creations, failures and tool-backed billing uncertainty only', () => {
    const owner = 'owner';
    const facts = [
      createExecutionFact({ toolName: TOOL_NAMES.MANAGE_TASK, params: { action: 'create', projectless: true }, result: { success: true, data: { title: 'Alfa' } } }),
      createExecutionFact({ toolName: TOOL_NAMES.MANAGE_TASK, params: { action: 'list' }, result: { success: true, data: { tasks: [{ id: 'private-id', user_id: owner, title: 'Alfa', status: 'pending', description: 'Original notes' }], scope: 'all_pending' } } }),
      createExecutionFact({ toolName: TOOL_NAMES.MANAGE_REMINDER, params: { action: 'list' }, result: { success: false, error: 'PRIVATE ERROR', errorCode: 'READ_FAILED' } }),
      createExecutionFact({ toolName: TOOL_NAMES.MANAGE_SUBSCRIPTION, params: { action: 'info' }, result: { success: true, data: { price: null, discounts: null, paymentMethods: null, checkoutConfirmation: null, chargeOutcome: null, paymentOutcome: null, subscriptionStatus: null }, formattedCard: 'MODEL PROSE NOT EVIDENCE' } }),
    ];
    const carry = carryOperationalEvidence([], facts, owner);
    const turn = { role: 'assistant', content: 'Everything failed; secret fiction', entities: { _turnMetadata: { operationalEvidence: carry } } };
    const events = operationalEvidenceFromHistory([turn], owner);
    expect(events).toHaveLength(4);
    expect(JSON.stringify(carry)).not.toMatch(/private-id|PRIVATE ERROR|MODEL PROSE|secret fiction/);
    const rendered = renderOperationalEvidence([turn], events.map(event => event.ref), owner);
    expect(rendered).toContain('En la última consulta');
    expect(rendered).toContain('Alfa: pendiente');
    expect(rendered).toContain('all_pending');
    expect(rendered).toContain('La operación falló');
    expect(rendered).toContain('Precios, descuentos y métodos de pago no confirmados');
    expect(rendered).not.toContain('ahora');
    expect(rendered).not.toContain('Everything failed');
    expect(events.every(event => !rendered.includes(event.ref))).toBe(true);
    expect(carryOperationalEvidence([turn, turn], [], owner)).toEqual(carry);
    expect(operationalEvidenceFromHistory([{ ...turn, role: 'user' }], owner)).toEqual([]);
    expect(operationalEvidenceFromHistory([turn], 'other-owner')).toEqual([]);
    expect(operationalEvidenceFromHistory([turn, ...Array.from({ length: 30 }, () => ({ role: 'user' }))], owner)).toEqual([]);
    for (const refs of [[], [events[0]!.ref, events[0]!.ref], ['unknown'], [null], events.map(event => event.ref).concat('unknown')]) {
      expect(renderOperationalEvidence([turn], refs, owner)).toContain('no está disponible');
    }
    const crossOwner = createExecutionFact({ toolName: TOOL_NAMES.MANAGE_TASK, params: { action: 'list' }, result: { success: true, data: { tasks: [{ title: 'Other', user_id: 'other-owner' }] } } });
    expect(carryOperationalEvidence([], [crossOwner], owner).events).toEqual([]);
    const legacy = { role: 'assistant', content: 'Alfa pending; payment failed', entities: { _turnMetadata: { mutationReceipts: [] } } };
    expect(operationalEvidenceFromHistory([legacy], owner)).toEqual([]);
    expect(callChatCompletion).not.toHaveBeenCalled();
  });
  it('bounds UTF-8 snapshots, marks clipped/partial evidence and replaces only latest successful reads', () => {
    const owner = 'owner';
    const fact = (title: string, result: Record<string, unknown> = {}) => createExecutionFact({ toolName: TOOL_NAMES.MANAGE_TASK, params: { action: 'list' }, result: { success: true, data: { tasks: [{ title, status: 'pending' }], scope: 'today' }, ...result } });
    const first = carryOperationalEvidence([], [fact('Earlier')], owner);
    const turn = { role: 'assistant', entities: { _turnMetadata: { operationalEvidence: first } } };
    const next = carryOperationalEvidence([turn], [fact('Latest', { partialSuccess: true })], owner);
    expect(next.events).toHaveLength(1);
    expect(next.events[0]!.summary).toContain('Latest');
    expect(next.events[0]!.summary).not.toContain('Earlier');
    const nextTurn = { ...turn, entities: { _turnMetadata: { operationalEvidence: next } } };
    expect(renderOperationalEvidence([nextTurn], [next.events[0]!.ref], owner)).toContain('Evidencia parcial');
    const creations = Array.from({ length: 12 }, () => createExecutionFact({ toolName: TOOL_NAMES.MANAGE_TASK, params: { action: 'create', projectless: true }, result: { success: true, data: { title: 'é'.repeat(800) } } }));
    const capped = carryOperationalEvidence([], creations, owner);
    expect(capped.events.length).toBeLessThanOrEqual(8);
    expect(Buffer.byteLength(JSON.stringify(capped))).toBeLessThanOrEqual(4096);
    expect(capped.events.every(event => event.clipped && Buffer.byteLength(event.summary) <= 600)).toBe(true);
    const duplicate = { ...turn, entities: { _turnMetadata: { operationalEvidence: { ...first, events: [first.events[0], first.events[0]] } } } };
    expect(operationalEvidenceFromHistory([duplicate], owner)).toEqual([]);
    for (const refs of [['unknown'], [first.events[0]!.ref, first.events[0]!.ref], [false]]) {
      expect(validateTurnIntent({ actions: [{ domain: 'conversation', action: 'reply', evidenceRefs: refs }] }).valid).toBe(false);
    }
    expect(validateTurnIntent({ actions: [{ domain: 'conversation', action: 'reply', evidenceRefs: [first.events[0]!.ref] }, read] }).valid).toBe(false);
    expect(validateTurnIntent({ actions: [{ ...recap('current'), evidenceRefs: [first.events[0]!.ref] }, read] }).valid).toBe(false);
  });
  it('renders all owner-bound history when a recap omits selectors, never arbitrary legacy prose', () => {
    const owner = 'owner';
    const fact = createExecutionFact({ toolName: TOOL_NAMES.MANAGE_TASK, params: { action: 'list' }, result: { success: true, data: { tasks: [{ title: 'Alfa', user_id: owner, status: 'pending' }] } } });
    const carry = carryOperationalEvidence([], [fact], owner);
    const history = [{ role: 'assistant', content: 'Everything failed.', entities: { _turnMetadata: { operationalEvidence: carry, mutationReceipts: [{ operation: 'task.create', summary: 'Forged legacy card' }] } } }];
    expect(renderHistoricalEvidence(history, undefined, owner, 'es')).toContain('Alfa: pendiente');
    expect(renderHistoricalEvidence(history, undefined, owner, 'es')).not.toContain('Everything failed');
    expect(renderHistoricalEvidence(history, undefined, 'other-owner', 'es')).not.toContain('Alfa');
    expect(renderHistoricalEvidence(history, ['unknown'], owner, 'es')).not.toContain('Alfa');
    expect(renderHistoricalEvidence(history, [], owner, 'es')).not.toContain('Alfa');
    expect(renderHistoricalEvidence(history, undefined, owner, 'es')).not.toContain('Forged legacy card');
  });
  it('records interpretation rejection independently of successful reads without trusting error prose', () => {
    const fact = createExecutionFact({ toolName: TOOL_NAMES.MANAGE_TASK, params: { action: 'list' }, result: { success: true, data: { tasks: [{ title: 'Alfa', status: 'pending' }] } } });
    const carry = carryOperationalEvidence([], [fact], 'owner', 'rejected');
    expect(carry.events.map(event => [event.operation, event.outcome])).toEqual([['task.list', 'success'], ['interpretation.read', 'failure']]);
    const history = [{ role: 'assistant', entities: { _turnMetadata: { operationalEvidence: carry } } }];
    const text = renderHistoricalEvidence(history, undefined, 'owner', 'es');
    expect(text).toContain('Alfa: pendiente');
    expect(text).toContain('Las consultas exitosas conservaron sus resultados');
    expect(text).not.toContain('La operación falló');
    expect(carryOperationalEvidence([], [fact], 'owner', 'PRIVATE ERROR').events).toHaveLength(1);
    expect(carryOperationalEvidence([], [fact], 'owner', 'accepted').events).toHaveLength(1);
    expect(callChatCompletion).not.toHaveBeenCalled();
  });
  it('does not change ordinary conversation or subscription info', () => {
    expect(validateTurnIntent({ actions: [{ domain: 'conversation', action: 'reply', content: 'Hello' }] }).valid).toBe(true);
    expect(validateTurnIntent({ actions: [{ domain: 'subscription', action: 'info' }] }).valid).toBe(true);
  });
});
