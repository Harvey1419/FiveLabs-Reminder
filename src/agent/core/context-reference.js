import { getWorkingMemory } from './working-memory.js';
import {
  normalizeTextForMatching,
  calculateMatchScore,
} from '../../shared/entity-resolution.js';

const ORDINALS = new Map([
  ['1', 1], ['#1', 1], ['primero', 1], ['primera', 1], ['primer', 1], ['el primero', 1], ['la primera', 1], ['first', 1], ['the first', 1],
  ['2', 2], ['#2', 2], ['segundo', 2], ['segunda', 2], ['el segundo', 2], ['la segunda', 2], ['second', 2], ['the second', 2],
  ['3', 3], ['#3', 3], ['tercero', 3], ['tercera', 3], ['tercer', 3], ['el tercero', 3], ['la tercera', 3], ['third', 3], ['the third', 3],
  ['4', 4], ['#4', 4], ['cuarto', 4], ['cuarta', 4], ['el cuarto', 4], ['la cuarta', 4], ['fourth', 4], ['the fourth', 4],
  ['5', 5], ['#5', 5], ['quinto', 5], ['quinta', 5], ['el quinto', 5], ['la quinta', 5], ['fifth', 5], ['the fifth', 5],
  ['6', 6], ['#6', 6], ['sexto', 6], ['sexta', 6], ['el sexto', 6], ['la sexta', 6], ['sixth', 6], ['the sixth', 6],
  ['7', 7], ['#7', 7], ['septimo', 7], ['septima', 7], ['el septimo', 7], ['la septima', 7], ['seventh', 7], ['the seventh', 7],
  ['8', 8], ['#8', 8], ['octavo', 8], ['octava', 8], ['el octavo', 8], ['la octava', 8], ['eighth', 8], ['the eighth', 8],
  ['9', 9], ['#9', 9], ['noveno', 9], ['novena', 9], ['el noveno', 9], ['la novena', 9], ['ninth', 9], ['the ninth', 9],
  ['10', 10], ['#10', 10], ['decimo', 10], ['decima', 10], ['el decimo', 10], ['la decima', 10], ['tenth', 10], ['the tenth', 10],
  ['ultimo', -1], ['ultima', -1], ['el ultimo', -1], ['la ultima', -1], ['last', -1], ['the last', -1],
]);

function parseStructuredOrdinal(reference) {
  const raw = String(reference || '').trim().toLowerCase();
  if (!raw) return null;
  const normalized = normalizeTextForMatching(raw);
  if (ORDINALS.has(raw)) return ORDINALS.get(raw);
  if (ORDINALS.has(normalized)) return ORDINALS.get(normalized);
  return null;
}

function shapeCandidate(candidate, index) {
  const raw = candidate?.raw || candidate || {};
  const type = candidate?.type
    || (candidate?.due_date ? 'task' : ((candidate?.content || candidate?.title) ? 'reminder' : 'calendar_event'));
  const internalId = String(candidate?.internalId || candidate?.id || '').trim();
  return {
    position: index + 1,
    type,
    internalId,
    summary: String(candidate?.summary || candidate?.content || candidate?.title || '').trim(),
    title: String(candidate?.title || candidate?.summary || candidate?.content || '').trim(),
    time: candidate?.localTime || candidate?.time || candidate?.send_at || candidate?.start || null,
    source: candidate?.source || (type === 'task' ? 'task' : (type === 'calendar_event' ? 'calendar' : 'reminder')),
    entityName: candidate?.entityName || raw?.entityName || raw?.entities?.name || null,
    raw,
  };
}

function buildPool({ userOrPhone, candidates, preferredType }) {
  let pool = [];

  // Explicit candidates are authoritative for mutation/read scope. Working
  // memory is only used when the caller does not provide a current candidate set.
  if (Array.isArray(candidates) && candidates.length > 0) {
    pool = candidates.map(shapeCandidate).filter((item) => Boolean(item.internalId));
  } else {
    const memory = getWorkingMemory(userOrPhone);
    pool = Array.isArray(memory?.items) ? memory.items.slice() : [];
  }

  if (preferredType) pool = pool.filter((item) => item.type === preferredType);
  return pool;
}

/**
 * Resolve an already-structured reference against current candidates or working
 * memory. This module deliberately does not interpret conversational intent.
 */
export function resolveContextReference({
  userOrPhone,
  reference,
  candidates = null,
  preferredType = null,
} = {}) {
  if (reference === null || reference === undefined) {
    return { status: 'NOT_FOUND', reason: 'EMPTY_REFERENCE' };
  }

  const rawReference = String(reference).trim();
  if (!rawReference) return { status: 'NOT_FOUND', reason: 'EMPTY_REFERENCE' };

  const pool = buildPool({ userOrPhone, candidates, preferredType });
  if (pool.length === 0) return { status: 'NOT_FOUND', reason: 'NO_CANDIDATES_AVAILABLE' };

  const ordinal = parseStructuredOrdinal(rawReference);
  if (ordinal !== null) {
    const item = ordinal === -1
      ? pool[pool.length - 1]
      : (pool.find((candidate) => candidate.position === ordinal) || pool[ordinal - 1]);
    if (item) return { status: 'RESOLVED', item };
  }

  const directIdMatch = pool.find((item) => (
    item.internalId === rawReference
    || (rawReference.length >= 8 && item.internalId.startsWith(rawReference))
  ));
  if (directIdMatch) return { status: 'RESOLVED', item: directIdMatch };

  const scored = pool
    .map((item) => ({ item, score: calculateMatchScore(rawReference, item.summary || item.title || '') }))
    .filter(({ score }) => score >= 0.5)
    .sort((a, b) => b.score - a.score);

  if (scored.length === 0) return { status: 'NOT_FOUND', reason: 'NO_MATCHING_ENTITY' };
  if (scored.length === 1) return { status: 'RESOLVED', item: scored[0].item };

  const [top, runnerUp] = scored;
  if (top.score >= 0.75 && (top.score - runnerUp.score) >= 0.20) {
    return { status: 'RESOLVED', item: top.item };
  }

  return {
    status: 'AMBIGUOUS',
    candidates: scored.map(({ item }) => item),
    reason: 'MULTIPLE_CANDIDATES',
  };
}
