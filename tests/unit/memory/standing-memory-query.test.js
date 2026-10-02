import { beforeEach, describe, expect, it, vi } from 'vitest';

const queryState = vi.hoisted(() => ({ calls: [], result: null, rows: [], filters: '', limit: 30 }));

vi.mock('../../../src/infrastructure/database/index.js', () => {
  const query = {
    select: vi.fn(() => query),
    eq: vi.fn((...args) => { queryState.calls.push(['eq', ...args]); return query; }),
    or: vi.fn((...args) => { queryState.calls.push(['or', ...args]); queryState.filters = args[0]; return query; }),
    order: vi.fn(() => query),
    limit: vi.fn((...args) => { queryState.calls.push(['limit', ...args]); queryState.limit = args[0]; return query; }),
    then: (resolve) => {
      if (queryState.result) return resolve(queryState.result);
      const legacyAspects = [...queryState.filters.matchAll(/topic_key\.like\.%\/([a-z0-9_-]+)/gi)].map((match) => match[1]);
      const filtered = queryState.rows.filter((row) => (
        row.category === 'preference'
        || row.topic_key?.startsWith('profile/')
        || row.topic_key?.startsWith('preference/')
        || (row.category === 'fact' && legacyAspects.some((aspect) => row.topic_key?.endsWith(`/${aspect}`)))
      )).sort((left, right) => new Date(right.created_at) - new Date(left.created_at)).slice(0, queryState.limit);
      return resolve({ data: filtered, error: null });
    },
  };
  return {
    supabase: { from: vi.fn(() => query) },
  };
});

const { getStandingMemories } = await import('../../../src/infrastructure/database/memories.js');

describe('standing memory database retrieval', () => {
  beforeEach(() => {
    queryState.calls = [];
    queryState.result = null;
    queryState.rows = [];
    queryState.filters = '';
    queryState.limit = 30;
  });

  it('filters standing preference/profile topics before applying the result limit', async () => {
    queryState.rows = [
      ...Array.from({ length: 31 }, (_, index) => ({
        id: `recent-unrelated-${index}`,
        topic_key: `project/notes/milestone-${index}`,
        category: 'episode',
        created_at: new Date(Date.UTC(2026, 9, 1, 12, index)).toISOString(),
      })),
      {
        id: 'legacy-profile-fact', topic_key: 'place/barranquilla/residence', category: 'fact',
        content: 'The user lives in Barranquilla.', created_at: '2024-01-01T00:00:00.000Z',
      },
    ];

    const result = await getStandingMemories({ userId: 'user-1', limit: 30, legacyFactAspects: new Set(['residence', 'work']) });

    expect(result.data).toHaveLength(1);
    expect(result.data[0].id).toBe('legacy-profile-fact');
    expect(queryState.calls.findIndex(([name]) => name === 'or'))
      .toBeLessThan(queryState.calls.findIndex(([name]) => name === 'limit'));
    expect(queryState.calls).toContainEqual(['or', 'category.eq.preference,topic_key.like.profile/%,topic_key.like.preference/%,and(category.eq.fact,topic_key.like.%/residence),and(category.eq.fact,topic_key.like.%/work)']);
  });

  it('retains storage errors separately from a confirmed empty result', async () => {
    queryState.result = { data: null, error: new Error('database unavailable') };

    const result = await getStandingMemories({ userId: 'user-1' });

    expect(result.data).toBeNull();
    expect(result.error.message).toBe('database unavailable');
  });
});
