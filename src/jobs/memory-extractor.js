import { extractAndSaveMemories, getMemoryEligibleText } from '../features/memory/service.js';

/**
 * Trigger memory extraction out of band. Learning is independent from tool
 * execution: operational clauses are removed first, while durable residual
 * user facts remain eligible even in a mixed actionable turn.
 */
let extractionQueue = Promise.resolve();

function splitClauses(value) {
  return String(value || '')
    .split(/(?<=[.!?])\s+|\n+/u)
    .map((part) => part.trim())
    .filter(Boolean);
}

function isQuestionClause(value) {
  const normalized = String(value || '')
    .replace(/^\[Respondiendo a:[\s\S]*?\]\s*/i, '')
    .trim();
  if (!normalized) return true;
  return normalized.endsWith('?') || (normalized.startsWith('¿') && normalized.includes('?'));
}

export function isPureQuestionTurn(userText) {
  const trusted = String(userText || '')
    .replace(/<untrusted_attachment_content>[\s\S]*?<\/untrusted_attachment_content>/gi, '')
    .trim();
  if (!trusted) return true;

  const clauses = splitClauses(trusted);
  if (clauses.length === 0) return true;

  // A turn such as "Vivo en Barranquilla. ¿Lo recuerdas?" contains a durable
  // assertion plus a question and must remain eligible for learning.
  return clauses.every(isQuestionClause);
}

export function extractMemoryInBackground({
  userId,
  userText,
  assistantReply,
  executionFacts = [],
  memoryDisposition = 'extract',
}) {
  if (!userId || !userText) return;

  if (isPureQuestionTurn(userText)) {
    console.log('[memoryExtractor] SKIPPED extraction: question-only turn contains no new durable fact.');
    return;
  }

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
        // Kept for call compatibility/telemetry only. Eligibility is now
        // clause-based instead of classifying the whole turn as operational.
        memoryDisposition,
      }))
      .catch((err) => console.error('[memoryExtractor] background extraction failed:', err));
  });
}
