import { describe, expect, it } from 'vitest';
import { resolveContextReference, parseStructuredOrdinal, extractMultipleOrdinals } from '../../../src/agent/core/context-reference-resolver.js';
import type { ContextItem } from '../../../src/agent/core/context-reference-resolver.js';
import { pinReminderTargets, pinTaskMutationTargets, findOutOfRangeTaskOrdinalTargets } from '../../../src/agent/orchestration/context-target-pinning.js';
import { normalizeTextForMatching, calculateMatchScore } from '../../../src/shared/entity-matching.js';
const item = (id: string, type = 'task', position = 1, summary = 'Enviar informe'): ContextItem => ({ internalId: id, type, position, summary });

describe('typed contextual identity boundary', () => {
  it('uses the current candidate set without mutating its raw host record', () => {
    const raw = { entities: { name: 'Trabajo' }, opaque: { retained: true } };
    const candidates = [{ id: 'current-id', title: 'Enviar informe', type: 'task', raw }];
    const result = resolveContextReference({ reference: '1', candidates, workingMemory: { items: [item('stale-id')] } });
    expect(result.status).toBe('RESOLVED');
    if (result.status !== 'RESOLVED') throw new Error('Expected current item');
    expect(result.item.internalId).toBe('current-id');
    expect(result.item.raw).toBe(raw);
    expect(result.item.entityName).toBe('Trabajo');
    expect(candidates).toEqual([{ id: 'current-id', title: 'Enviar informe', type: 'task', raw }]);
  });
  it('retains mixed-list positions and falls back to the preferred-type order', () => {
    const memory = { items: [item('rem', 'reminder', 1), item('task-a', 'task', 2), item('task-b', 'task', 3)] };
    const byPosition = resolveContextReference({ reference: '2', preferredType: 'task', workingMemory: memory });
    const byTypeOrder = resolveContextReference({ reference: '1', preferredType: 'task', workingMemory: memory });
    expect(byPosition.status === 'RESOLVED' && byPosition.item).toBe(memory.items[1]);
    expect(byTypeOrder.status === 'RESOLVED' && byTypeOrder.item).toBe(memory.items[1]);
  });
  it('freezes task IDs before removal shifts the displayed order', () => {
    const memory = { items: [item('a', 'task', 1), item('b', 'task', 2)] };
    const pins = pinTaskMutationTargets([{ domain: 'task', action: 'delete', target: '1' }, { domain: 'task', action: 'complete', target: '2' }], memory);
    memory.items.shift();
    expect([...pins]).toEqual([[0, 'a'], [1, 'b']]);
  });
  it('marks an out-of-range task ordinal and leaves it unpinned', () => {
    const memory = { items: [item('task-a', 'task', 3)] };
    const actions = [{ domain: 'task', action: 'complete', target: '3' }];
    expect([...findOutOfRangeTaskOrdinalTargets(actions, memory)]).toEqual([0]);
    expect(pinTaskMutationTargets(actions, memory).size).toBe(0);
  });
  it('refuses partial or duplicate-identity ambiguous reminder pairing', () => {
    const actions = [{ domain: 'reminder', action: 'cancel', target: 'Enviar informe' }];
    const items = [item('a', 'reminder', 1), item('b', 'reminder', 2)];
    expect(pinReminderTargets(actions, { items }).size).toBe(0);
    expect(pinReminderTargets([...actions, ...actions], { items: [items[0]!, { ...items[1]!, internalId: 'a' }] }).size).toBe(0);
  });
  it('pairs equivalent references only for exact full coverage and skips mass scope', () => {
    const memory = { items: [item('a', 'reminder', 2), item('b', 'reminder', 1)] };
    const actions = [{ domain: 'reminder', action: 'cancel', target: 'Enviar informe', scope: 'all' }, { domain: 'reminder', action: 'update', target: 'informe' }, { domain: 'reminder', action: 'cancel', target: 'Enviar informe' }];
    expect([...pinReminderTargets(actions, memory)]).toEqual([[1, 'b'], [2, 'a']]);
  });
  it('keeps bilingual ordinal bounds and last-item expansion compatible', () => {
    expect(parseStructuredOrdinal('la última')).toBe(-1);
    expect(parseStructuredOrdinal('the third')).toBe(3);
    expect(parseStructuredOrdinal('tarea 100')).toBe(100);
    expect(parseStructuredOrdinal('101')).toBeNull();
    expect(extractMultipleOrdinals('primera y última')).toEqual(['1', 'ultimo']);
    expect(extractMultipleOrdinals('first and enviar informe')).toEqual([]);
  });
  it('handles non-text matching input and accents without conversational inference', () => {
    expect(normalizeTextForMatching({ title: 'Informe' })).toBe('');
    expect(calculateMatchScore('PAGAR ADMINISTRACIÓN', 'Pagar administracion')).toBe(1);
    expect(resolveContextReference({ reference: 'listo', candidates: [{ id: 'a', title: 'Enviar informe' }] }).status).toBe('NOT_FOUND');
  });
});
