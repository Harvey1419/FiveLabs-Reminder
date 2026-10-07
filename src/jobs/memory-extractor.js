import { extractAndSaveMemories, getMemoryEligibleText } from '../features/memory/service.js';
import { captureQueryEmbeddingScope } from '../integrations/ai/embeddings.js';

/**
 * Trigger memory extraction out of band. Learning is independent from tool
 * execution: semantic admission validates individual facts, preserving mixed turns.
 */
let extractionQueue = Promise.resolve();

export function extractMemoryInBackground({
  userId,
  userText,
  assistantReply,
  executionFacts = [],
  memoryDisposition = 'extract',
  learningCandidates,
  learningCandidatesProvided = false,
}) {
  if (!userId || !userText) return;

  const trusted = String(userText || '')
    .replace(/<untrusted_attachment_content>[\s\S]*?<\/untrusted_attachment_content>/gi, '')
    .trim();
  const eligibleText = getMemoryEligibleText(trusted, executionFacts);
  if (!eligibleText) {
    console.log('[memoryExtractor] SKIPPED extraction: no durable residual text after operational filtering.');
    return;
  }

  // Bind at enqueue time: a shared promise queue must not select a job's owner.
  const extractInScope = captureQueryEmbeddingScope(() => extractAndSaveMemories({
    userId,
    userText,
    assistantReply,
    executionFacts,
    // The semantic classifier handles questions and mixed turns.
    memoryDisposition,
    learningCandidates,
    learningCandidatesProvided,
  }));
  setImmediate(captureQueryEmbeddingScope(async () => {
    extractionQueue = extractionQueue
      .catch(() => {})
      .then(extractInScope)
      .catch((err) => console.error('[memoryExtractor] background extraction failed:', err));
  }));
}
