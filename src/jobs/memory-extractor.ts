import { extractAndSaveMemories, getMemoryEligibleText } from '../features/memory/service.js';
import { captureQueryEmbeddingScope } from '../integrations/ai/embeddings.js';
import { createBackgroundMemoryExtraction } from './memory-extraction-queue.js';

const worker = createBackgroundMemoryExtraction({ extractAndSaveMemories: ((...args: Parameters<typeof extractAndSaveMemories>) => extractAndSaveMemories(...args)) as unknown as Parameters<typeof createBackgroundMemoryExtraction>[0]['extractAndSaveMemories'], getMemoryEligibleText: ((...args: Parameters<typeof getMemoryEligibleText>) => getMemoryEligibleText(...args)) as unknown as Parameters<typeof createBackgroundMemoryExtraction>[0]['getMemoryEligibleText'], captureQueryEmbeddingScope: ((...args: Parameters<typeof captureQueryEmbeddingScope>) => captureQueryEmbeddingScope(...args)) as unknown as Parameters<typeof createBackgroundMemoryExtraction>[0]['captureQueryEmbeddingScope'], setImmediate: ((...args: Parameters<typeof setImmediate>) => setImmediate(...args)) as unknown as Parameters<typeof createBackgroundMemoryExtraction>[0]['setImmediate'], logger: console});
export function extractMemoryInBackground(...args: Parameters<typeof worker.extractMemoryInBackground>) { return worker.extractMemoryInBackground(...args); }


