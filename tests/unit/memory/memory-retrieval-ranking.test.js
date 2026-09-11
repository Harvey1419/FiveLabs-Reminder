import { describe, expect, it } from 'vitest';

import {
  buildMemoryEmbeddingDocument,
  selectMemorySearchResults,
} from '../../../src/infrastructure/database/memories.js';

function memory(id, topicKey, similarity, content = `Memory ${id}`) {
  return {
    id,
    topic_key: topicKey,
    category: 'fact',
    content,
    similarity,
  };
}

describe('durable memory retrieval ranking', () => {
  it('indexes stable topic identity together with content', () => {
    expect(buildMemoryEmbeddingDocument('Profile/Occupation', 'Trabaja en comercio exterior.'))
      .toBe('profile/occupation\nTrabaja en comercio exterior.');
    expect(buildMemoryEmbeddingDocument(null, 'Vive en Barranquilla.'))
      .toBe('Vive en Barranquilla.');
  });

  it('lets an older highly relevant memory beat a recent weak match', () => {
    const result = selectMemorySearchResults({
      vectorResults: [
        { ...memory('recent', 'profile/hobby', 0.28), created_at: '2026-09-10T12:00:00Z' },
        { ...memory('old', 'profile/occupation', 0.74), created_at: '2025-01-01T12:00:00Z' },
      ],
      limit: 2,
    });

    expect(result.map((item) => item.id)).toEqual(['old']);
  });

  it('uses a small relative score window for dynamic specific-versus-broad top-K', () => {
    const specific = selectMemorySearchResults({
      vectorResults: [
        memory('correct', 'person/juli/birthday', 0.79),
        memory('marginal', 'profile/birthday', 0.55),
      ],
      limit: 3,
    });
    const broad = selectMemorySearchResults({
      vectorResults: [
        memory('project-a', 'project/archive/status', 0.61),
        memory('project-b', 'project/archive/context', 0.59),
        memory('project-c', 'project/archive/design', 0.58),
        memory('unrelated', 'profile/hobby', 0.42),
      ],
      limit: 3,
    });

    expect(specific.map((item) => item.id)).toEqual(['correct']);
    expect(broad.map((item) => item.id)).toEqual(['project-a', 'project-b', 'project-c']);
  });

  it('does not inject duplicate active identities or exact duplicate content', () => {
    const result = selectMemorySearchResults({
      vectorResults: [
        memory('best', 'profile/residence', 0.72, 'Vive en Barranquilla.'),
        memory('same-topic', 'profile/residence', 0.70, 'Ahora vive en Barranquilla.'),
        memory('same-content', 'legacy/location', 0.69, 'Vive en Barranquilla.'),
        memory('other', 'profile/occupation', 0.68, 'Trabaja en logística.'),
      ],
      limit: 4,
    });

    expect(result.map((item) => item.id)).toEqual(['best', 'other']);
  });

  it('excludes explicitly inactive versions defensively', () => {
    const result = selectMemorySearchResults({
      vectorResults: [
        { ...memory('superseded', 'profile/residence', 0.90), is_active: false },
        memory('current', 'profile/residence', 0.70),
      ],
      limit: 3,
    });

    expect(result.map((item) => item.id)).toEqual(['current']);
  });

  it('keeps prompt growth bounded with 50+ candidates', () => {
    const candidates = Array.from({ length: 55 }, (_, index) => (
      memory(`m-${index}`, `project/p-${index}/status`, 0.90 - index / 100)
    ));

    const result = selectMemorySearchResults({ vectorResults: candidates.reverse(), limit: 3 });

    expect(result).toHaveLength(3);
    expect(result.map((item) => item.id)).toEqual(['m-0', 'm-1', 'm-2']);
  });
});
