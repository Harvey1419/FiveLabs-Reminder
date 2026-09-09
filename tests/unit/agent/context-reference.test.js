import { afterEach, describe, expect, it } from 'vitest';
import {
  saveWorkingMemory,
  getWorkingMemory,
  clearWorkingMemory,
} from '../../../src/agent/core/working-memory.js';
import { resolveContextReference } from '../../../src/agent/core/context-reference.js';

const user = { id: 'context-reference-user', phone_number: '+573001112233' };

const candidates = [
  { id: '11111111-1111-4111-8111-111111111111', type: 'task', title: 'Comprar alimento para peces' },
  { id: '22222222-2222-4222-8222-222222222222', type: 'task', title: 'Pagar administración' },
  { id: '33333333-3333-4333-8333-333333333333', type: 'task', title: 'Enviar informe mensual' },
];

afterEach(() => clearWorkingMemory(user));

describe('resolveContextReference', () => {
  it('resolves exact structured ordinals against the provided candidate order', () => {
    expect(resolveContextReference({ reference: '2', candidates, preferredType: 'task' }).item?.internalId)
      .toBe(candidates[1].id);
    expect(resolveContextReference({ reference: 'el tercero', candidates, preferredType: 'task' }).item?.internalId)
      .toBe(candidates[2].id);
    expect(resolveContextReference({ reference: 'last', candidates, preferredType: 'task' }).item?.internalId)
      .toBe(candidates[2].id);
  });

  it('resolves direct ids, prefixes, and deterministic names', () => {
    expect(resolveContextReference({ reference: candidates[0].id, candidates, preferredType: 'task' }).item?.internalId)
      .toBe(candidates[0].id);
    expect(resolveContextReference({ reference: '22222222', candidates, preferredType: 'task' }).item?.internalId)
      .toBe(candidates[1].id);
    expect(resolveContextReference({ reference: 'pagar administracion', candidates, preferredType: 'task' }).item?.internalId)
      .toBe(candidates[1].id);
  });

  it('does not reinterpret standalone conversational affirmations', () => {
    const one = [candidates[0]];
    expect(resolveContextReference({ reference: 'ya lo hice', candidates: one, preferredType: 'task' }).status)
      .toBe('NOT_FOUND');
    expect(resolveContextReference({ reference: 'listo', candidates: one, preferredType: 'task' }).status)
      .toBe('NOT_FOUND');
  });

  it('does not reinterpret temporal superlatives or collective anaphora', () => {
    const timed = [
      { ...candidates[0], time: '2026-09-09T08:00:00-05:00' },
      { ...candidates[1], time: '2026-09-09T18:00:00-05:00' },
    ];
    expect(resolveContextReference({ reference: 'mas temprano', candidates: timed, preferredType: 'task' }).status)
      .toBe('NOT_FOUND');
    expect(resolveContextReference({ reference: 'la lista', candidates: timed, preferredType: 'task' }).status)
      .toBe('NOT_FOUND');
  });

  it('uses explicit candidates as authoritative instead of stale working memory', () => {
    saveWorkingMemory(user, {
      source: 'task',
      entityType: 'task',
      items: [{ id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', title: 'Elemento viejo' }],
    });

    const resolved = resolveContextReference({
      reference: '1',
      candidates,
      preferredType: 'task',
      workingMemory: getWorkingMemory(user),
    });

    expect(resolved.status).toBe('RESOLVED');
    expect(resolved.item?.internalId).toBe(candidates[0].id);
  });

  it('uses supplied working memory only when no current candidate set is supplied', () => {
    saveWorkingMemory(user, {
      source: 'task',
      entityType: 'task',
      items: [
        { id: candidates[0].id, title: candidates[0].title },
        { id: candidates[1].id, title: candidates[1].title },
      ],
    });

    const resolved = resolveContextReference({
      reference: 'la segunda',
      preferredType: 'task',
      workingMemory: getWorkingMemory(user),
    });

    expect(resolved.status).toBe('RESOLVED');
    expect(resolved.item?.internalId).toBe(candidates[1].id);
  });
});
