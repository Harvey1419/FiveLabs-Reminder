// Legacy semantic/database wiring; the service executes from emitted TypeScript.
import { validateMemoryCandidates } from './validate-candidates.js';
import { validLearningCandidates } from '../../agent/contracts/intent-contracts.js';
import { ENTITY_WRITE_CATEGORIES } from '../../shared/entity-categories.js';
import { saveMemory,searchMemories,getActiveMemories,getStandingMemories,findOrCreateEntityFuzzy } from '../../infrastructure/database/index.js';
import { callMemoryExtraction } from '../../agent/providers/client.js';
import { createMemoryService } from './memory-service.js';
export const { canonicalizeTopicKey,extractAndSaveMemories,CORE_PROFILE_ASPECTS,selectCoreProfileMemories,retrieveStandingPreferences,retrieveStandingPreferencesResult,selectProactiveAnchors,getProactiveAnchors,retrieveRelevantMemories,retrieveRelevantMemoriesResult,buildMemoryExtractionInput,getMemoryEligibleText,extractGroundedSpan } = createMemoryService({
  validLearningCandidates: ((...args: Parameters<typeof validLearningCandidates>) => validLearningCandidates(...args)) as unknown as Parameters<typeof createMemoryService>[0]['validLearningCandidates'],
  entityWriteCategories: ENTITY_WRITE_CATEGORIES as unknown as Parameters<typeof createMemoryService>[0]['entityWriteCategories'],
  validateMemoryCandidates: ((...args: Parameters<typeof validateMemoryCandidates>) => validateMemoryCandidates(...args)) as unknown as Parameters<typeof createMemoryService>[0]['validateMemoryCandidates'],
  callMemoryExtraction: ((...args: Parameters<typeof callMemoryExtraction>) => callMemoryExtraction(...args)) as unknown as Parameters<typeof createMemoryService>[0]['callMemoryExtraction'],
  saveMemory: ((...args: Parameters<typeof saveMemory>) => saveMemory(...args)) as unknown as Parameters<typeof createMemoryService>[0]['saveMemory'],
  searchMemories: ((...args: Parameters<typeof searchMemories>) => searchMemories(...args)) as unknown as Parameters<typeof createMemoryService>[0]['searchMemories'],
  getActiveMemories: ((...args: Parameters<typeof getActiveMemories>) => getActiveMemories(...args)) as unknown as Parameters<typeof createMemoryService>[0]['getActiveMemories'],
  getStandingMemories: ((...args: Parameters<typeof getStandingMemories>) => getStandingMemories(...args)) as unknown as Parameters<typeof createMemoryService>[0]['getStandingMemories'],
  findOrCreateEntityFuzzy: ((...args: Parameters<typeof findOrCreateEntityFuzzy>) => findOrCreateEntityFuzzy(...args)) as unknown as Parameters<typeof createMemoryService>[0]['findOrCreateEntityFuzzy'],
});


