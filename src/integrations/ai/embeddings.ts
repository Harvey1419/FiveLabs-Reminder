// Legacy HTTP/configuration wiring; provider and query reuse execute from TypeScript.
import { createEmbeddingService } from './embedding-service.js';
import { createOpenRouterEmbeddingProvider } from './openrouter-embedding-provider.js';
export { MEMORY_EMBEDDING_MODEL } from './openrouter-embedding-provider.js';
const provider = createOpenRouterEmbeddingProvider({
  getApiKey: () => process.env.OPENROUTER_API_KEY?.replace(/"/g,'').trim() || (process.env.AI_API_KEY?.startsWith('sk-or-') ? process.env.AI_API_KEY.trim() : null),
  fetch: (...args) => fetch(...args),
});
export const { withQueryEmbeddingScope,captureQueryEmbeddingScope,generateEmbeddings,generateEmbedding } = createEmbeddingService(provider);


