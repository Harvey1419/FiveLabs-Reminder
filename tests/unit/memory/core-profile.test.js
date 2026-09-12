import { beforeEach, describe, expect, it, vi } from 'vitest';

const getActiveMemories = vi.fn();

vi.mock('../../../src/infrastructure/database/index.js', () => ({
  saveMemory: vi.fn(),
  searchMemories: vi.fn(),
  getActiveMemories,
  findOrCreateEntityFuzzy: vi.fn(),
}));

const { selectCoreProfileMemories, retrieveStandingPreferences } = await import('../../../src/features/memory/service.js');

describe('second-brain core profile selection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('prioritizes stable self knowledge independently from the current query', () => {
    const selected = selectCoreProfileMemories([
      { id: 'episode', topic_key: 'project/reminder/milestone', category: 'episode', content: 'Se lanzó una prueba.' },
      { id: 'residence', topic_key: 'profile/residence', category: 'fact', content: 'El usuario vive en Barranquilla.' },
      { id: 'communication', topic_key: 'preference/communication', category: 'preference', content: 'Prefiere respuestas breves.' },
      { id: 'legacy-location', topic_key: 'place/barranquilla/location', category: 'fact', content: 'Barranquilla es la residencia del usuario.' },
    ], 10);

    expect(selected.map((memory) => memory.id)).toEqual(['residence', 'communication', 'legacy-location']);
    expect(selected.every((memory) => memory.category.startsWith('core_profile:'))).toBe(true);
  });

  it('does not promote arbitrary episodes or project facts into the always-on profile', () => {
    expect(selectCoreProfileMemories([
      { id: 'episode', topic_key: 'project/reminder/milestone', category: 'episode', content: 'Se lanzó una prueba.' },
      { id: 'decision', topic_key: 'project/reminder/architecture', category: 'decision', content: 'Se eligió Node.' },
    ])).toEqual([]);
  });

  it('caps the always-on profile to protect prompt size', () => {
    const memories = Array.from({ length: 20 }, (_, index) => ({
      id: `p-${index}`,
      topic_key: `profile/fact_${index}`,
      category: 'fact',
      content: `Fact ${index}`,
    }));

    expect(selectCoreProfileMemories(memories, 10)).toHaveLength(10);
    expect(selectCoreProfileMemories(memories, 100)).toHaveLength(15);
  });

  it('retrieves and ranks standing preferences for a user', async () => {
    getActiveMemories.mockResolvedValueOnce([
      { id: 'm1', topic_key: 'preference/reminders', category: 'preference', content: 'Sin avisos después de 10 min.' },
      { id: 'm2', topic_key: 'profile/residence', category: 'fact', content: 'Vive en Bogotá.' },
      { id: 'm3', topic_key: 'episode/trip', category: 'episode', content: 'Viaje a Cartagena.' },
    ]);

    const prefs = await retrieveStandingPreferences({ userId: 'user-123', limit: 5 });
    expect(getActiveMemories).toHaveBeenCalledWith({ userId: 'user-123', limit: 30 });
    expect(prefs).toHaveLength(2);
    expect(prefs[0].id).toBe('m2');
    expect(prefs[1].id).toBe('m1');
  });

  it('returns empty array when userId is missing', async () => {
    const prefs = await retrieveStandingPreferences({ userId: null });
    expect(prefs).toEqual([]);
    expect(getActiveMemories).not.toHaveBeenCalled();
  });
});
