import {
  findOrCreateEntityFuzzy,
  renameEntityCascade,
  mergeEntities,
  deduplicateEntities,
  getEntitiesByUser,
  deleteEntities,
  inspectOwnedEntityReferences,
} from '../../infrastructure/database/index.js';
import { createEntityTool } from './entity-tool.js';
const service = createEntityTool({
  findOrCreateEntityFuzzy: ((...args: Parameters<typeof findOrCreateEntityFuzzy>) => findOrCreateEntityFuzzy(...args)) as unknown as Parameters<typeof createEntityTool>[0]['findOrCreateEntityFuzzy'],
  renameEntityCascade: ((...args: Parameters<typeof renameEntityCascade>) => renameEntityCascade(...args)) as unknown as Parameters<typeof createEntityTool>[0]['renameEntityCascade'],
  mergeEntities: ((...args: Parameters<typeof mergeEntities>) => mergeEntities(...args)) as unknown as Parameters<typeof createEntityTool>[0]['mergeEntities'],
  deduplicateEntities: ((...args: Parameters<typeof deduplicateEntities>) => deduplicateEntities(...args)) as unknown as Parameters<typeof createEntityTool>[0]['deduplicateEntities'],
  getEntitiesByUser: ((...args: Parameters<typeof getEntitiesByUser>) => getEntitiesByUser(...args)) as unknown as Parameters<typeof createEntityTool>[0]['getEntitiesByUser'],
  deleteEntities: ((...args: Parameters<typeof deleteEntities>) => deleteEntities(...args)) as unknown as Parameters<typeof createEntityTool>[0]['deleteEntities'],
  inspectOwnedEntityReferences: ((...args: Parameters<typeof inspectOwnedEntityReferences>) => inspectOwnedEntityReferences(...args)) as unknown as Parameters<typeof createEntityTool>[0]['inspectOwnedEntityReferences'],
  logger: console,
});
export function executeEntityTool(...args: Parameters<typeof service.executeEntityTool>) { return service.executeEntityTool(...args); }


