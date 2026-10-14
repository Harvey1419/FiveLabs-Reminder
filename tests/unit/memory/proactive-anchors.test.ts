import { beforeEach, describe, expect, it, vi } from 'vitest';

const getActiveMemories = vi.fn();

vi.mock('../../../src/infrastructure/database/index.js', () => ({
  saveMemory: vi.fn(),
  searchMemories: vi.fn(),
  getActiveMemories,
  findOrCreateEntityFuzzy: vi.fn(),
}));

const { selectProactiveAnchors, getProactiveAnchors } = await import('../../../src/features/memory/service.js');

describe('proactive episodic memory anchors', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('selects recent episodes and personal anchors while omitting standing preferences', () => {
    const rawMemories = [
      { id: 'm-pref', topic_key: 'preference/communication', category: 'preference', content: 'Prefiere respuestas cortas.' },
      { id: 'm-prof', topic_key: 'profile/residence', category: 'fact', content: 'Vive en Medellín.' },
      { id: 'm-episode-1', topic_key: 'episode/veterinarian/visit', category: 'episode', content: 'Borona estuvo enferma del estómago y fuimos al veterinario.' },
      { id: 'm-pet', topic_key: 'pet/borona/identity', category: 'pet', content: 'Borona es una schnauzer mini de 3 años.' },
      { id: 'm-health', topic_key: 'health/cardiology/checkup', category: 'fact', content: 'Cita con cardiólogo el próximo mes.' },
      { id: 'm-person', topic_key: 'person/laura/relation', category: 'person', content: 'Laura es la esposa.' },
      { id: 'm-proj', topic_key: 'project/reminder/scope', category: 'project', content: 'Reminder es su producto estrella.' },
    ];

    const anchors = selectProactiveAnchors(rawMemories, { maxEntities: 2, maxRecentEpisodes: 1 });

    // Should include 1 episode and 2 top entities (pet, health)
    expect(anchors).toHaveLength(3);
    expect(anchors[0]!.id).toBe('m-episode-1');
    expect(anchors.map((a) => a.id)).toContain('m-pet');
    expect(anchors.map((a) => a.id)).toContain('m-health');
    expect(anchors.some((a) => a.id === 'm-pref')).toBe(false);
    expect(anchors.some((a) => a.id === 'm-prof')).toBe(false);
  });

  it('respects maxEntities and maxRecentEpisodes bounds', () => {
    const rawMemories = [
      { id: 'ep-1', topic_key: 'episode/trip/florencia', category: 'episode', content: 'Viaje a Florencia.' },
      { id: 'ep-2', topic_key: 'episode/doctor/checkup', category: 'episode', content: 'Examen de sangre.' },
      { id: 'ep-3', topic_key: 'episode/vet/borona', category: 'episode', content: 'Vacuna de Borona.' },
      { id: 'pet-1', topic_key: 'pet/borona/general', category: 'pet', content: 'Perrita Borona.' },
      { id: 'proj-1', topic_key: 'project/reminder/tech', category: 'project', content: 'Proyecto Reminder.' },
    ];

    const anchors = selectProactiveAnchors(rawMemories, { maxEntities: 1, maxRecentEpisodes: 2 });
    expect(anchors).toHaveLength(3); // 2 episodes + 1 entity
    expect(anchors.filter((a) => a.category === 'episode')).toHaveLength(2);
  });

  it('retrieves active memories from database when not preloaded', async () => {
    vi.mocked(getActiveMemories, { partial: true }).mockResolvedValueOnce([
      { id: 'ep-1', topic_key: 'episode/medical', category: 'episode', content: 'Consulta médica ayer.' },
      { id: 'pet-1', topic_key: 'pet/borona/care', category: 'pet', content: 'Borona come alimento especial.' },
    ]);

    const anchors = await getProactiveAnchors({ userId: 'user-456', maxEntities: 2, maxRecentEpisodes: 2 });
    expect(getActiveMemories).toHaveBeenCalledWith({ userId: 'user-456', limit: 30 });
    expect(anchors).toHaveLength(2);
    expect(anchors[0]!.id).toBe('ep-1');
    expect(anchors[1]!.id).toBe('pet-1');
  });

  it('reuses preloaded activeMemories to prevent redundant database queries', async () => {
    const preloaded = [
      { id: 'pet-1', topic_key: 'pet/borona/general', category: 'pet', content: 'Borona es su perra.' },
    ];

    const anchors = await getProactiveAnchors({ userId: 'user-456', activeMemories: preloaded });
    expect(getActiveMemories).not.toHaveBeenCalled();
    expect(anchors).toHaveLength(1);
    expect(anchors[0]!.id).toBe('pet-1');
  });

  it('returns empty array when userId is missing', async () => {
    const anchors = await Reflect.apply(getProactiveAnchors, undefined, [{ userId: null }]);
    expect(anchors).toEqual([]);
    expect(getActiveMemories).not.toHaveBeenCalled();
  });
});
