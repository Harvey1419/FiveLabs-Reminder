import { beforeEach, describe, expect, it, vi } from 'vitest';

const searchMemories = vi.fn();
const getActiveMemories = vi.fn();

vi.mock('../../../src/infrastructure/database/index.js', () => ({
  saveMemory: vi.fn(),
  searchMemories,
  findOrCreateEntityFuzzy: vi.fn(),
}));

vi.mock('../../../src/infrastructure/database/memories.js', () => ({
  getActiveMemories,
}));

vi.mock('../../../src/agent/providers/client.js', () => ({
  callMemoryExtraction: vi.fn(),
}));

const { retrieveRelevantMemories } = await import('../../../src/features/memory/service.js');

describe('semantic memory retrieval budget', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    searchMemories.mockResolvedValue([
      { id: '1', content: 'Uno', category: 'fact' },
      { id: '2', content: 'Dos', category: 'fact' },
      { id: '3', content: 'Tres', category: 'fact' },
      { id: '4', content: 'Cuatro', category: 'fact' },
      { id: '5', content: 'Cinco', category: 'fact' },
    ]);
    getActiveMemories.mockResolvedValue(Array.from({ length: 10 }, (_, index) => ({
      id: `profile-${index}`,
      topic_key: `profile/fact_${index}`,
      category: 'fact',
      content: `Perfil ${index}`,
    })));
  });

  it('treats limit as a real total prompt budget instead of adding an always-on profile behind it', async () => {
    const result = await retrieveRelevantMemories({ userId: 'u1', queryText: '¿Qué recuerdas de mi proyecto?', limit: 3 });

    expect(searchMemories).toHaveBeenCalledWith({ userId: 'u1', query: '¿Qué recuerdas de mi proyecto?', limit: 3, throwOnError: true, withStatus: true });
    expect(result).toHaveLength(3);
    expect(getActiveMemories).not.toHaveBeenCalled();
  });

  it('lets semantic retrieval decide relevance even for ordinary short conversation instead of a phrase-list bypass', async () => {
    searchMemories.mockResolvedValue([]);

    const result = await retrieveRelevantMemories({ userId: 'u1', queryText: 'hola', limit: 3 });

    expect(result).toEqual([]);
    expect(searchMemories).toHaveBeenCalledTimes(1);
    expect(getActiveMemories).not.toHaveBeenCalled();
  });
});
