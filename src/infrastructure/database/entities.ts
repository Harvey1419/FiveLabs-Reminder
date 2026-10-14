import { supabase } from './index.js';
import { normalizeEntityName, levenshteinDistance, levenshteinSimilarity, jaccardSimilarity, entityMatchScore, selectEntityCandidate, selectEntitiesForDeletion, inspectEntityReferenceSnapshot, partitionLinkedTasksForEntityDeletion, mergeMetadata } from './entity-resolution.js';
import { createEntityPersistence } from './entity-persistence.js';
export { normalizeEntityName, levenshteinDistance, levenshteinSimilarity, jaccardSimilarity, entityMatchScore, selectEntityCandidate, selectEntitiesForDeletion, inspectEntityReferenceSnapshot, partitionLinkedTasksForEntityDeletion, mergeMetadata };
export const { inspectOwnedEntityReferences, findOrCreateEntityFuzzy, getOrCreateEntity, findEntities, getEntitiesByUser, getEntityById } = createEntityPersistence(() => supabase as unknown as ReturnType<Parameters<typeof createEntityPersistence>[0]>);

import { createEntityMutationPersistence } from './entity-mutation-persistence.js';
export const { deleteEntities, renameEntity, mergeEntities, deduplicateEntities, renameEntityCascade } = createEntityMutationPersistence(() => supabase as unknown as ReturnType<Parameters<typeof createEntityMutationPersistence>[0]>,input => findOrCreateEntityFuzzy(input));


