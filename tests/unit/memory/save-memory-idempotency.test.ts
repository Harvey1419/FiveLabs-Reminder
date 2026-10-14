import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const from = vi.fn();
const generateEmbedding = vi.fn();

vi.mock('../../../src/infrastructure/database/index.js', () => ({
  supabase: { from },
}));

vi.mock('../../../src/integrations/ai/embeddings.js', () => ({
  generateEmbedding,
}));

const { saveMemory } = await import('../../../src/infrastructure/database/memories.js');

function query(result: { data: unknown; error: null | { message: string } }) {
  const chain = {
    select: vi.fn(() => chain),
    eq: vi.fn(() => chain),
    order: vi.fn(() => chain),
    limit: vi.fn(() => chain),
    insert: vi.fn(() => chain),
    update: vi.fn(() => chain),
    delete: vi.fn(() => chain),
    in: vi.fn(() => chain),
    single: vi.fn(async () => result),
    then: (resolve: (value: typeof result) => unknown, reject?: (reason: unknown) => unknown) => Promise.resolve(result).then(resolve, reject),
  };
  return chain;
}

describe('saveMemory structured identity persistence', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(generateEmbedding, { partial: true }).mockResolvedValue([0.1, 0.2]);
  });

  afterEach(() => vi.restoreAllMocks());

  it('returns the active row without embedding or insert when identity and content are unchanged', async () => {
    const existing = {
      id: 'memory-current',
      content: 'El usuario vive en Barranquilla.',
      created_at: '2026-09-10T10:00:00Z',
      is_active: true,
    };
    vi.mocked(from, { partial: true }).mockReturnValueOnce(query({ data: [existing], error: null }));

    const saved = await saveMemory({
      userId: 'user-1',
      topicKey: 'profile/residence',
      category: 'fact',
      content: 'El usuario vive en Barranquilla.',
    });

    expect(saved).toBe(existing);
    expect(from).toHaveBeenCalledTimes(1);
    expect(generateEmbedding).not.toHaveBeenCalled();
  });

  it('reconciles duplicate active rows when one already has the exact current content', async () => {
    const lookup = query({ data: [
      { id: 'keep-newest', content: 'Prefiere respuestas breves.', created_at: '2026-09-10T11:00:00Z' },
      { id: 'duplicate-old', content: 'Prefiere respuestas breves.', created_at: '2026-09-10T10:00:00Z' },
    ], error: null });
    const reconcile = query({ data: null, error: null });
    vi.mocked(from, { partial: true }).mockReturnValueOnce(lookup).mockReturnValueOnce(reconcile);

    const saved = await saveMemory({
      userId: 'user-1', topicKey: 'preference/communication', category: 'preference', content: 'Prefiere respuestas breves.',
    });

    expect(saved!.id).toBe('keep-newest');
    expect(reconcile.update).toHaveBeenCalledWith({ is_active: false, superseded_by: 'keep-newest' });
    expect(reconcile.in).toHaveBeenCalledWith('id', ['duplicate-old']);
    expect(generateEmbedding).not.toHaveBeenCalled();
  });

  it('creates one new version and supersedes every active row for a material update', async () => {
    const lookup = query({ data: [
      { id: 'old-a', content: 'El usuario trabaja en Bucaramanga.', created_at: '2026-09-10T10:00:00Z' },
      { id: 'old-b', content: 'Trabaja actualmente en Bucaramanga.', created_at: '2026-09-09T10:00:00Z' },
    ], error: null });
    const inserted = { id: 'new-current', content: 'El usuario ahora trabaja en Barranquilla.', is_active: true };
    const insert = query({ data: inserted, error: null });
    const supersede = query({ data: null, error: null });
    vi.mocked(from, { partial: true }).mockReturnValueOnce(lookup).mockReturnValueOnce(insert).mockReturnValueOnce(supersede);

    const saved = await saveMemory({
      userId: 'user-1',
      topicKey: 'profile/work_location',
      category: 'fact',
      content: 'El usuario ahora trabaja en Barranquilla.',
    });

    expect(saved).toBe(inserted);
    expect(generateEmbedding).toHaveBeenCalledWith('profile/work_location\nEl usuario ahora trabaja en Barranquilla.');
    expect(insert.insert).toHaveBeenCalledWith(expect.objectContaining({
      user_id: 'user-1', topic_key: 'profile/work_location', content: inserted.content, is_active: true,
    }));
    expect(supersede.update).toHaveBeenCalledWith({ is_active: false, superseded_by: 'new-current' });
    expect(supersede.eq).toHaveBeenCalledWith('user_id', 'user-1');
    expect(supersede.eq).toHaveBeenCalledWith('topic_key', 'profile/work_location');
    expect(supersede.in).toHaveBeenCalledWith('id', ['old-a', 'old-b']);
  });

  it('rolls back a new version when previous active versions cannot be superseded', async () => {
    const lookup = query({ data: [
      { id: 'old-current', content: 'El usuario trabaja en Bucaramanga.', created_at: '2026-09-10T10:00:00Z' },
    ], error: null });
    const insert = query({ data: { id: 'new-version' }, error: null });
    const supersede = query({ data: null, error: { message: 'update unavailable' } });
    const rollback = query({ data: null, error: null });
    vi.mocked(from, { partial: true }).mockReturnValueOnce(lookup).mockReturnValueOnce(insert).mockReturnValueOnce(supersede).mockReturnValueOnce(rollback);

    const saved = await saveMemory({
      userId: 'user-1', topicKey: 'profile/work_location', content: 'El usuario trabaja en Barranquilla.',
    });

    expect(saved).toBeNull();
    expect(rollback.delete).toHaveBeenCalledTimes(1);
    expect(rollback.eq).toHaveBeenCalledWith('user_id', 'user-1');
    expect(rollback.eq).toHaveBeenCalledWith('id', 'new-version');
  });
});
