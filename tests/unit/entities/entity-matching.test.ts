import { describe, expect, it } from 'vitest';
import {
  partitionLinkedTasksForEntityDeletion,
  selectEntityCandidate,
  selectEntitiesForDeletion,
} from '../../../src/infrastructure/database/entities.js';

const entities = [
  { id: 'meeting', name: 'Reunión del trabajo', category: 'project' },
  { id: 'work', name: 'trabajo', category: 'project' },
  { id: 'reminder', name: 'Reminder Pro', category: 'project' },
  { id: 'company', name: 'Trabajo Creativo', category: 'company' },
];

describe('entity candidate selection', () => {
  it('prefers an exact canonical project regardless of database row order', () => {
    const result = selectEntityCandidate(entities, 'Trabajo');

    expect(result).toMatchObject({ status: 'RESOLVED', entity: { id: 'work' }, score: 1 });
  });

  it('does not guess when two fuzzy candidates are similarly plausible', () => {
    const result = selectEntityCandidate([
      { id: 'north', name: 'Trabajo Norte', category: 'project' },
      { id: 'south', name: 'Trabajo Sur', category: 'project' },
    ], 'Trabajo Central', { threshold: 0.3 });

    expect(result.status).toBe('AMBIGUOUS');
  });

  it('selects all projects except exact preserved names without touching companies', () => {
    const result = selectEntitiesForDeletion(entities, {
      scope: 'all', category: 'project', preserveNames: ['Reminder Pro'],
    });

    expect(result.status).toBe('RESOLVED');
    expect(result.entities.map((entity) => entity.id)).toEqual(['meeting', 'work']);
  });

  it('deletes unfinished project work but preserves completed history', () => {
    const result = partitionLinkedTasksForEntityDeletion([
      { id: 'pending', status: 'pending' },
      { id: 'active', status: 'in_progress' },
      { id: 'done', status: 'completed' },
      { id: 'cancelled', status: 'cancelled' },
    ]);

    expect(result).toEqual({
      unfinishedTaskIds: ['pending', 'active'],
      preservedCompletedTaskCount: 1,
    });
  });

  it('resolves multiple targetNames for deletion as a single batch', () => {
    const result = selectEntitiesForDeletion(entities, {
      targetNames: ['trabajo', 'Reminder Pro'],
    });

    expect(result.status).toBe('RESOLVED');
    expect(result.entities.map((entity) => entity.id)).toEqual(['work', 'reminder']);
  });
});
