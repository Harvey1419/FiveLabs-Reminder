import { expectInvalid } from '../../support/unit/contract-boundary.js';
import { expectValid } from '../../support/unit/contract-boundary.js';
import { describe, it, expect, vi } from 'vitest';
vi.mock('../../../src/agent/providers/client.js', () => ({ callChatCompletion: vi.fn() }));
import { validateTurnIntent } from '../../../src/agent/contracts/intent-contracts.js';
import { createExecutionFact } from '../../../src/agent/core/execution-facts.js';
import { TOOL_NAMES } from '../../../src/agent/contracts/tool-names.js';
import { carryOperationalEvidence, renderHistoricalEvidence } from '../../../src/agent/orchestration/observed-answer.js';
const ref = '12345678-1234-1234-1234-123456789abc';
const selection = { domain: 'conversation', action: 'recap', recapMode: 'current', evidenceRefs: [ref] };
const wrap = (carry: ReturnType<typeof carryOperationalEvidence>) => [{ role: 'assistant', content: 'RAW FICTION', entities: { _turnMetadata: { operationalEvidence: carry } } }];
const mutation = (action: string, title = 'Alfa') => createExecutionFact({ callId: 'owned-call', toolName: TOOL_NAMES.MANAGE_TASK, params: { action }, result: { success: true, data: { id: 'private-id', user_id: 'owner', title, description: 'Actual notes', status: action === 'complete' ? 'completed' : 'pending' } } });
describe('source authority normalization', () => {
  it('rejects captured Zoom preference entity without remapping; defaults remain valid', () => {
    const result = validateTurnIntent({ actions: [{ domain: 'entity', action: 'upsert', category: 'preference', title: 'Zoom' }] });
    expectInvalid(result);
    expect(result).toMatchObject({ valid: false, errorCode: 'INVALID_ENTITY_CATEGORY' });
    expect(result.error).toContain('memory.save');
    for (const category of ['person', 'company', 'project', 'place', 'asset', 'other', undefined]) expect(validateTurnIntent({ actions: [{ domain: 'entity', action: 'create', title: 'Zoom', category }] }).valid).toBe(true);
  });
  it.each(['create', 'upsert'])('rejects unsupported physical pet category for entity.%s', action => {
    expect(validateTurnIntent({ actions: [{ domain: 'entity', action, title: 'Borona', category: 'pet' }] })).toMatchObject({ valid: false, errorCode: 'INVALID_ENTITY_CATEGORY' });
  });
  it.each([undefined, 'Useful contextual prose'])('normalizes captured current+refs with unused prose %s', content => {
    const result = validateTurnIntent({ actions: [{ ...selection, content }] });
    expectValid(result);
    expect(result.intent.actions[0]!.recapMode).toBe('historical');
    expect(result.intent.actions[0]!.content).toBeUndefined();
  });
  it('keeps incompatible actions, billing, interpretation, bare current and bad selectors invalid', () => {
    for (const intent of [
      { actions: [selection, { domain: 'task', action: 'list', status: 'all' }] },
      { actions: [selection, { domain: 'task', action: 'complete', target: 'Alfa' }] },
      { actions: [selection], answerFromResults: true },
      { actions: [selection], responseCapability: 'billing_info' },
      { actions: [{ ...selection, evidenceRefs: undefined }] },
      { actions: [{ ...selection, evidenceRefs: ['unknown'] }] },
      { actions: [{ ...selection, content: 'x'.repeat(1601) }] },
    ]) expect(validateTurnIntent(intent).valid).toBe(false);
  });
  it('carries actual canonical owned changes and completion as distinct historical events', () => {
    const facts = [mutation('update'), mutation('update', 'Beta'), mutation('complete')];
    const carry = carryOperationalEvidence([], facts, 'owner');
    expect(carry.events.map(e => e.operation)).toEqual(['task.update', 'task.update', 'task.complete']);
    for (let i = 0; i < facts.length; i++) expect(carry.events[i]!.summary).toBe(facts[i]!.card);
    const text = renderHistoricalEvidence(wrap(carry), undefined, 'owner', 'en');
    expect(text).toContain('Actual notes');
    expect(text).toContain('No new verification');
    expect(text).not.toMatch(/RAW FICTION|private-id|task\.update|task\.complete/);
    for (const refs of [['unknown'], [ref]]) expect(renderHistoricalEvidence(wrap(carry), refs, 'owner', 'en')).not.toContain('Actual notes');
    expect(renderHistoricalEvidence(wrap(carry), undefined, 'foreign', 'en')).not.toContain('Actual notes');
  });
  it('rejects unconfirmed, foreign, missing-call and tampered mutation evidence', () => {
    const fact = mutation('update');
    for (const bad of [{ ...fact, complete: false }, { ...fact, success: false, outcome: 'unknown' }, { ...fact, callId: null }, { ...fact, presentationData: { ...fact.presentationData as Record<string, unknown>, user_id: 'foreign' } }, { ...fact, card: fact.card + ' FICTION' }]) expect(carryOperationalEvidence([], [bad], 'owner').events).toEqual([]);
  });
  it('keeps existing UTF-8 and event bounds with explicit clipped history', () => {
    const carry = carryOperationalEvidence([], Array.from({ length: 12 }, () => mutation('update', 'é'.repeat(800))), 'owner');
    expect(carry.events.length).toBeGreaterThan(0);
    expect(carry.events.length).toBeLessThanOrEqual(8);
    expect(Buffer.byteLength(JSON.stringify(carry))).toBeLessThanOrEqual(4096);
    expect(carry.events.every(e => e.clipped && Buffer.byteLength(e.summary) <= 600)).toBe(true);
    expect(renderHistoricalEvidence(wrap(carry), undefined, 'owner', 'en')).toContain('Partial');
  });
});
