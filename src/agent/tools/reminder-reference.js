import {
  isStrictUUID,
  calculateMatchScore,
} from '../../shared/entity-resolution.js';

/**
 * Resolve only explicit technical identifiers. This helper never interprets
 * natural language and never decides which reminders are eligible candidates.
 */
export function findReminderByExactReference(reference, reminders = []) {
  const target = String(reference || '').trim();
  if (!target) return null;

  if (isStrictUUID(target)) {
    return reminders.find((reminder) => reminder?.id === target) || null;
  }

  if (target.length >= 8) {
    return reminders.find((reminder) => reminder?.id?.startsWith(target)) || null;
  }

  return null;
}

/**
 * Convert reminder rows to the canonical entity-resolution candidate shape.
 * Candidate eligibility remains the caller's responsibility.
 */
export function buildReminderReferenceCandidates(reminders = []) {
  return reminders.map((reminder) => ({
    id: reminder.id,
    internalId: reminder.id,
    type: 'reminder',
    content: reminder.content,
    summary: reminder.content,
    time: reminder.send_at,
    raw: reminder,
  }));
}

/**
 * Deterministic score resolver shared by reminder operations.
 * This contains no operation policy: callers decide which rows are eligible
 * before invoking it and how AMBIGUOUS/NOT_FOUND should be presented.
 */
export function resolveReminderByScore(reference, reminders = []) {
  const scored = reminders
    .map((reminder) => ({
      reminder,
      score: calculateMatchScore(reference, reminder?.content || ''),
    }))
    .filter(({ score }) => score >= 0.5)
    .sort((a, b) => b.score - a.score);

  if (scored.length === 0) return { status: 'NOT_FOUND' };
  if (scored.length === 1) {
    return { status: 'RESOLVED', reminder: scored[0].reminder, score: scored[0].score };
  }

  const [top, runnerUp] = scored;
  if (top.score >= 0.75 && (top.score - runnerUp.score) >= 0.20) {
    return { status: 'RESOLVED', reminder: top.reminder, score: top.score };
  }

  return {
    status: 'AMBIGUOUS',
    reminders: scored.map(({ reminder }) => reminder),
  };
}
