import type { ExtractMemoryOptions } from '../features/memory/memory-service.js';
export interface BackgroundMemoryInput extends Omit<ExtractMemoryOptions, 'userId' | 'userText'> {
  userId: string | null | undefined;
  userText: string | null | undefined;
}
export interface BackgroundMemoryDependencies {
  extractAndSaveMemories(input: ExtractMemoryOptions): Promise<unknown>;
  getMemoryEligibleText(userText: string, executionFacts: unknown[]): string;
  captureQueryEmbeddingScope<R>(work: () => R): () => R;
  setImmediate(callback: () => void | Promise<void>): unknown;
  logger: Pick<Console, 'log' | 'error'>;
}
/** Capture each job's embedding context at enqueue time, independently of the shared queue. */
export function createBackgroundMemoryExtraction({ extractAndSaveMemories, getMemoryEligibleText, captureQueryEmbeddingScope, setImmediate, logger }: BackgroundMemoryDependencies) {
  let extractionQueue: Promise<unknown> = Promise.resolve();
  function extractMemoryInBackground({ userId, userText, assistantReply, executionFacts = [], memoryDisposition = 'extract', learningCandidates, learningCandidatesProvided = false }: BackgroundMemoryInput): void {
    if (!userId || !userText) return;
    const trusted = String(userText || '').replace(/<untrusted_attachment_content>[\s\S]*?<\/untrusted_attachment_content>/gi, '').trim();
    const eligibleText = getMemoryEligibleText(trusted, executionFacts);
    if (!eligibleText) {
      logger.log('[memoryExtractor] SKIPPED extraction: no durable residual text after operational filtering.');
      return;
    }
    const extractInScope = captureQueryEmbeddingScope(() => extractAndSaveMemories({
      userId, userText, assistantReply, executionFacts, memoryDisposition, learningCandidates, learningCandidatesProvided,
    } as ExtractMemoryOptions));
    setImmediate(captureQueryEmbeddingScope(async () => {
      extractionQueue = extractionQueue.catch(() => {}).then(extractInScope).catch(error => logger.error('[memoryExtractor] background extraction failed:', error));
    }));
  }
  return { extractMemoryInBackground };
}
