/**
 * Deterministic entity reference primitives.
 *
 * This module intentionally contains no conversational intent interpretation.
 * Hermes/Orchestration owns language understanding; backend domains only use
 * normalization, strict identifiers and deterministic text matching.
 */

export const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Strict RFC 4122 UUID validator. */
export function isStrictUUID(val) {
  if (!val || typeof val !== 'string') return false;
  return UUID_REGEX.test(val.trim());
}

/**
 * Normalize text for deterministic, diacritic-insensitive matching.
 */
export function normalizeTextForMatching(str) {
  if (!str || typeof str !== 'string') return '';
  return str
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[«»“”"'`~*#_~(){}\[\]]/g, '')
    .replace(/[.,;:!?¡¿\-_/\\]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Tokenize normalized text for deterministic overlap scoring. */
export function tokenizeText(str) {
  const norm = normalizeTextForMatching(str);
  if (!norm) return [];

  const STOPWORDS = new Set([
    'para', 'los', 'las', 'con', 'que', 'por', 'del', 'una', 'uno', 'este',
    'esta', 'ese', 'esa', 'mis', 'tus', 'les', 'nos', 'favor', 'como', 'sobre',
    'tarea', 'recordatorio', 'recordatorios', 'tareas',
  ]);

  return norm
    .split(/\s+/)
    .filter((word) => word.length > 2 && !STOPWORDS.has(word));
}

/**
 * Calculate a deterministic match score between a structured query and a
 * candidate label. Returns a value between 0 and 1.
 */
export function calculateMatchScore(query, candidate) {
  const normQ = normalizeTextForMatching(query);
  const normC = normalizeTextForMatching(candidate);

  if (!normQ || !normC) return 0;
  if (normQ === normC) return 1.0;
  if (normC.includes(normQ)) return 0.95;
  if (normQ.includes(normC)) return 0.90;

  const qTokens = tokenizeText(normQ);
  const cTokens = tokenizeText(normC);
  if (qTokens.length === 0 || cTokens.length === 0) return 0;

  const matches = qTokens.filter((queryToken) => (
    cTokens.some((candidateToken) => (
      candidateToken.includes(queryToken) || queryToken.includes(candidateToken)
    ))
  ));
  const matchCount = matches.length;
  if (matchCount === 0) return 0;

  const coverage = matchCount / qTokens.length;
  const precision = matchCount / cTokens.length;
  const f1 = (2 * coverage * precision) / (coverage + precision);

  return Math.max(coverage * 0.8, f1);
}
