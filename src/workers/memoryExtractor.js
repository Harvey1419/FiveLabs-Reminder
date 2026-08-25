import { extractAndSaveMemories } from '../services/memoryService.js';

/**
 * Trigger memory extraction in the background (fire-and-forget out of band).
 *
 * @param {object} params
 * @param {string} params.userId
 * @param {string} params.userText
 * @param {string} params.assistantReply
 */
export function extractMemoryInBackground({ userId, userText, assistantReply }) {
  if (!userId || !userText) return;

  // Use setImmediate or promise to run out-of-band after webhook dispatch
  setImmediate(async () => {
    try {
      await extractAndSaveMemories({ userId, userText, assistantReply });
    } catch (err) {
      console.error('[memoryExtractor] background extraction failed:', err);
    }
  });
}
