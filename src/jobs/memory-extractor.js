import { extractAndSaveMemories } from '../features/memory/service.js';

/**
 * Trigger memory extraction in the background (fire-and-forget out of band).
 *
 * @param {object} params
 * @param {string} params.userId
 * @param {string} params.userText
 * @param {string} params.assistantReply
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

  // Use setImmediate or promise to run out-of-band after webhook dispatch
  setImmediate(async () => {
    extractionQueue = extractionQueue
      .catch(() => {})
      .then(() => extractAndSaveMemories({
        userId, userText, assistantReply, executionFacts, memoryDisposition,
      }))
      .catch((err) => console.error('[memoryExtractor] background extraction failed:', err));
  });
}
