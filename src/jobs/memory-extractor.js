import { extractAndSaveMemories } from '../features/memory/service.js';

/**
 * Trigger memory extraction in the background (fire-and-forget out of band).
 *
 * Learning and recall are separate paths:
 * - statements may contain new durable facts and go through extraction;
 * - pure questions/recall requests do not teach Hermes anything new, so they
 *   should never spend another model call after the response was delivered.
 */
let extractionQueue = Promise.resolve();

export function isPureQuestionTurn(userText) {
  const trusted = String(userText || '')
    .replace(/<untrusted_attachment_content>[\s\S]*?<\/untrusted_attachment_content>/gi, '')
    .trim();
  if (!trusted) return true;

  const lines = trusted.split(/\n+/).map((line) => line.trim()).filter(Boolean);
  if (lines.length === 0) return true;

  // Be deliberately conservative: only skip when every independent line is
  // visibly a question. A mixed "fact + question" still reaches extraction.
  return lines.every((line) => {
    const normalized = line.replace(/^\[Respondiendo a:[\s\S]*?\]\s*/i, '').trim();
    return normalized.endsWith('?') || (normalized.startsWith('¿') && normalized.includes('?'));
  });
}

export function extractMemoryInBackground({
  userId,
  userText,
  assistantReply,
  executionFacts = [],
  memoryDisposition = 'extract',
}) {
  if (!userId || !userText) return;

  if (memoryDisposition !== 'extract') {
    console.log(`[memoryExtractor] SKIPPED extraction: disposition=${memoryDisposition}.`);
    return;
  }

  if (isPureQuestionTurn(userText)) {
    console.log('[memoryExtractor] SKIPPED extraction: recall/question-only turn contains no new durable fact.');
    return;
  }

  setImmediate(async () => {
    extractionQueue = extractionQueue
      .catch(() => {})
      .then(() => extractAndSaveMemories({
        userId, userText, assistantReply, executionFacts, memoryDisposition,
      }))
      .catch((err) => console.error('[memoryExtractor] background extraction failed:', err));
  });
}
