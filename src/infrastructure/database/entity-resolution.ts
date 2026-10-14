import type { JsonObject } from '@templelabs/contracts';
import type { TaskContainerRow,TaskRow } from './domain-persistence-client.js';
export type EntitySelection<T> = { status: 'RESOLVED'; entity: T; score: number }
  | { status: 'AMBIGUOUS' | 'NOT_FOUND'; candidates: T[]; score?: number };
export interface EntityDeletionOptions { targetName?: string | null; targetNames?: readonly string[] | null;
  category?: string | null; scope?: string; preserveNames?: readonly string[] }
export type EntityDeletionSelection<T> = { status: 'RESOLVED'; entities: T[] }
  | { status: 'AMBIGUOUS' | 'NOT_FOUND'; entities: T[]; candidates: T[] };
export interface EntityReference { readonly name?: string; readonly category?: string | null; readonly threshold?: number }
function jsonObject(value: JsonObject[string] | undefined): JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {};
}
export function normalizeEntityName(name: unknown) {
  if (!name || typeof name !== 'string') return '';
  let s = name
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();

  // Strip periods in abbreviations/acronyms (e.g. S.A. -> SA)
  s = s.replace(/\./g, '');

  // Replace punctuation/symbols with spaces
  s = s.replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();

  // Remove common noise prefixes
  const noisePrefixes = /^(el\s+proyecto|proyecto|la\s+empresa|empresa|la\s+compania|compania|el|la|los|las|un|una|mi|mis|de|del)\s+/i;
  while (noisePrefixes.test(s)) {
    s = s.replace(noisePrefixes, '').trim();
  }

  return s;
}

/**
 * Levenshtein distance between two strings.
 */
export function levenshteinDistance(s1: string, s2: string) {
  const m = s1.length;
  const n = s2.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i]![0] = i;
  for (let j = 0; j <= n; j++) dp[0]![j] = j;

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = s1[i - 1] === s2[j - 1] ? 0 : 1;
      dp[i]![j] = Math.min(
        dp[i - 1]![j]! + 1,
        dp[i]![j - 1]! + 1,
        dp[i - 1]![j - 1]! + cost
      );
    }
  }
  return dp[m]![n]!;
}

/**
 * Levenshtein similarity ratio between 0.0 and 1.0.
 */
export function levenshteinSimilarity(s1: string, s2: string) {
  if (s1 === s2) return 1.0;
  const maxLen = Math.max(s1.length, s2.length);
  if (maxLen === 0) return 1.0;
  const dist = levenshteinDistance(s1, s2);
  return 1.0 - dist / maxLen;
}

/**
 * Jaccard token overlap similarity between 0.0 and 1.0.
 */
export function jaccardSimilarity(s1: string, s2: string) {
  const tokens1 = new Set(s1.split(/\s+/).filter(Boolean));
  const tokens2 = new Set(s2.split(/\s+/).filter(Boolean));
  if (tokens1.size === 0 && tokens2.size === 0) return 1.0;
  if (tokens1.size === 0 || tokens2.size === 0) return 0.0;

  let intersection = 0;
  for (const t of tokens1) {
    if (tokens2.has(t)) intersection++;
  }
  const union = new Set([...tokens1, ...tokens2]).size;
  return intersection / union;
}

/**
 * Composite fuzzy match score combining Levenshtein and Jaccard token similarity with strict length ratio guards.
 */
export function entityMatchScore(nameA: unknown, nameB: unknown) {
  const normA = normalizeEntityName(nameA);
  const normB = normalizeEntityName(nameB);

  if (!normA || !normB) return 0.0;
  if (normA === normB) return 1.0;

  const minLen = Math.min(normA.length, normB.length);
  const maxLen = Math.max(normA.length, normB.length);
  const lengthRatio = minLen / maxLen;

  // Plural/singular inflection check (e.g. "recordatorio" vs "recordatorios", "reminder" vs "reminders")
  if (
    (normA + 's' === normB || normB + 's' === normA || normA + 'es' === normB || normB + 'es' === normA) &&
    minLen >= 4
  ) {
    return 0.95;
  }

  const lev = levenshteinSimilarity(normA, normB);
  const jac = jaccardSimilarity(normA, normB);

  // For very short single-word entities (length <= 4), do not allow substring boosts and require strict similarity
  if (maxLen <= 4 || minLen <= 3) {
    // For short words like "pan" (3) vs "panadería" (9) or "sol" (3) vs "soluciones" (10),
    // lengthRatio is <= 0.4. Never allow substring containment to boost these!
    if (lengthRatio < 0.70) {
      return lev;
    }
    return lev >= 0.85 ? lev : 0.0;
  }

  // For multi-word phrases or longer words with high length ratio (>= 0.70)
  // E.g. "remindersim" (11) vs "reminder" (8) -> ratio 0.727 -> returns 0.78
  // "pan" (3) vs "panadería" (9) -> ratio 0.33 -> rejected (returns ~0.33)
  // "sol" (3) vs "soluciones" (10) -> ratio 0.30 -> rejected (returns ~0.30)
  if (lengthRatio >= 0.70 && (normA.startsWith(normB) || normB.startsWith(normA))) {
    return Math.max(lev, 0.78);
  }

  // Composite calculation
  const tokensA = normA.split(/\s+/).filter(Boolean);
  const tokensB = normB.split(/\s+/).filter(Boolean);

  if (tokensA.length > 1 || tokensB.length > 1) {
    return Math.max(jac, lev * 0.5 + jac * 0.5);
  }

  return lev;
}

/**
 * Select one user-visible entity without depending on database row order.
 * Exact canonical names always win. Fuzzy candidates must have both a strong
 * score and a clear margin over the runner-up; otherwise callers must clarify.
 */
export function selectEntityCandidate<T extends TaskContainerRow>(entities: readonly T[], name: unknown, {
  category = null,
  threshold = 0.70,
  ambiguityMargin = 0.12,
}: { category?: string | null; threshold?: number; ambiguityMargin?: number } = {}): EntitySelection<T> {
  const candidates = Array.isArray(entities) ? entities.filter((entity) => entity?.name) : [];
  const normalizedName = normalizeEntityName(name);
  if (!normalizedName || candidates.length === 0) return { status: 'NOT_FOUND', candidates: [] };

  const exact = candidates.filter((entity) => normalizeEntityName(entity.name) === normalizedName);
  if (exact.length > 0) {
    const categoryExact = category ? exact.filter((entity) => entity.category === category) : [];
    const eligible = categoryExact.length > 0 ? categoryExact : exact;
    if (eligible.length === 1) return { status: 'RESOLVED', entity: eligible[0]!, score: 1 };
    return { status: 'AMBIGUOUS', candidates: eligible, score: 1 };
  }

  const scored = candidates
    .map((entity) => ({ entity, score: entityMatchScore(name, entity.name) }))
    .filter((candidate) => candidate.score >= threshold)
    .sort((left, right) => right.score - left.score);
  if (scored.length === 0) return { status: 'NOT_FOUND', candidates: [] };

  const top = scored[0]!;
  const runnerUp = scored[1];
  if (runnerUp && top.score - runnerUp.score < ambiguityMargin) {
    return { status: 'AMBIGUOUS', candidates: scored.map((candidate) => candidate.entity), score: top.score };
  }
  return { status: 'RESOLVED', entity: top.entity, score: top.score };
}

export function selectEntitiesForDeletion<T extends TaskContainerRow>(entities: readonly T[], {
  targetName = null,
  targetNames = null,
  category = null,
  scope = 'single',
  preserveNames = [],
}: EntityDeletionOptions = {}): EntityDeletionSelection<T> {
  const candidates = (Array.isArray(entities) ? entities : [])
    .filter((entity) => entity?.id && (!category || entity.category === category));
  const preserved = new Set((preserveNames || []).map(normalizeEntityName).filter(Boolean));

  if (scope === 'all') {
    return {
      status: 'RESOLVED',
      entities: candidates.filter((entity) => !preserved.has(normalizeEntityName(entity.name))),
    };
  }

  const namesToMatch = Array.isArray(targetNames) && targetNames.length > 0
    ? targetNames
    : (targetName ? [targetName] : []);

  if (namesToMatch.length === 0) {
    return { status: 'NOT_FOUND', entities: [], candidates: [] };
  }

  const resolvedEntities: T[] = [];
  const ambiguousCandidates: T[] = [];

  for (const name of namesToMatch) {
    const selected = selectEntityCandidate(candidates, name, { category });
    if (selected.status === 'AMBIGUOUS') {
      ambiguousCandidates.push(...(selected.candidates || []));
    } else if (selected.status === 'RESOLVED') {
      if (!preserved.has(normalizeEntityName(selected.entity.name))) {
        if (!resolvedEntities.some((e) => e.id === selected.entity.id)) {
          resolvedEntities.push(selected.entity);
        }
      }
    }
  }

  if (ambiguousCandidates.length > 0 && resolvedEntities.length === 0) {
    return { status: 'AMBIGUOUS', candidates: ambiguousCandidates, entities: [] };
  }

  if (resolvedEntities.length === 0) {
    return { status: 'NOT_FOUND', entities: [], candidates: [] };
  }

  return { status: 'RESOLVED', entities: resolvedEntities };
}

/**
 * Resolve already-structured entity references against one tenant-owned
 * snapshot. This is a read-only deterministic preflight: callers decide the
 * semantic meaning before reaching this boundary.
 */
export function inspectEntityReferenceSnapshot<T extends TaskContainerRow>(entities: readonly T[], references: readonly EntityReference[] = []) {
  const requested = (Array.isArray(references) ? references : [])
    .map((reference) => ({
      name: String(reference?.name || '').trim(),
      category: reference?.category ? String(reference.category).trim() : null,
      threshold: Number.isFinite(Number(reference?.threshold)) ? Number(reference.threshold) : 0.75,
    }))
    .filter((reference) => reference.name);
  if (requested.length === 0) return [];

  const candidates = Array.isArray(entities) ? entities : [];
  return requested.map((reference) => ({
    reference,
    ...selectEntityCandidate(candidates, reference.name, {
      category: reference.category,
      threshold: reference.threshold,
    }),
  }));
}

export function partitionLinkedTasksForEntityDeletion(tasks: readonly Pick<TaskRow,'id' | 'status'>[]) {
  const safeTasks = Array.isArray(tasks) ? tasks : [];
  return {
    unfinishedTaskIds: safeTasks
      .filter((task) => task?.id && (task.status === 'pending' || task.status === 'in_progress'))
      .map((task) => task.id),
    preservedCompletedTaskCount: safeTasks.filter((task) => task?.status === 'completed').length,
  };
}

/**
 * Non-aggressive JSONB merge helper: preserves existing values unless new values are non-empty.
 */
export function mergeMetadata(existingMeta: JsonObject | null = {}, newMeta: JsonObject | null = {}): JsonObject {
  const result = { ...(existingMeta || {}) };
  if (!newMeta || typeof newMeta !== 'object') return result;

  for (const [key, value] of Object.entries(newMeta)) {
    if (value !== undefined && value !== null && value !== '') {
      if (
        typeof value === 'object' &&
        !Array.isArray(value) &&
        typeof result[key] === 'object' &&
        !Array.isArray(result[key]) &&
        result[key] !== null
      ) {
        result[key] = mergeMetadata(jsonObject(result[key]),jsonObject(value));
      } else {
        result[key] = value;
      }
    }
  }
  return result;
}

