import { extractAndSaveMemories, getMemoryEligibleText } from '../features/memory/service.js';

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

  setImmediate(async () => {
    extractionQueue = extractionQueue
      .catch(() => {})
      .then(() => extractAndSaveMemories({
        userId,
        userText,
        assistantReply,
        executionFacts,
        // The semantic classifier handles questions and mixed turns.
        memoryDisposition,
      }))
      .catch((err) => console.error('[memoryExtractor] background extraction failed:', err));
  });
}
