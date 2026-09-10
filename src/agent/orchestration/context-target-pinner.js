import { resolveContextReference } from '../core/context-reference.js';

function isSingleReminderCancellation(action) {
  return action?.domain === 'reminder'
    && action?.action === 'cancel'
    && !['all', 'elapsed'].includes(action?.scope)
    && typeof action?.target === 'string'
    && action.target.trim().length > 0;
}

function candidateSignature(candidates = []) {
  return candidates
    .map((item) => String(item?.internalId || '').trim())
    .filter(Boolean)
    .sort()
    .join('|');
}

/**
 * Freeze contextual reminder identities before the first mutation in a turn.
 * Working Memory identifies what the user was referring to; domain tools still
 * re-read owner-scoped database state and remain authoritative for execution.
 *
 * If Hermes emits the same human target once per duplicated listed reminder,
 * an otherwise ambiguous set can be paired one-to-one only when the number and
 * candidate set match exactly. Partial ambiguous selections stay unresolved.
 */
export function pinReminderCancellationTargets(actions = [], workingMemory = null) {
  const pinned = new Map();
  if (!Array.isArray(actions) || !Array.isArray(workingMemory?.items)) return pinned;

  const ambiguousGroups = new Map();

  actions.forEach((action, index) => {
    if (!isSingleReminderCancellation(action)) return;

    const reference = action.target.trim();
    const resolved = resolveContextReference({
      reference,
      preferredType: 'reminder',
      workingMemory,
    });

    if (resolved.status === 'RESOLVED' && resolved.item?.internalId) {
      pinned.set(index, resolved.item.internalId);
      return;
    }

    if (resolved.status !== 'AMBIGUOUS' || !Array.isArray(resolved.candidates)) return;
    const candidates = resolved.candidates.filter((item) => item?.internalId);
    if (candidates.length < 2) return;

    const key = reference;
    const group = ambiguousGroups.get(key) || [];
    group.push({ index, candidates });
    ambiguousGroups.set(key, group);
  });

  for (const group of ambiguousGroups.values()) {
    if (group.length < 2) continue;

    const firstSignature = candidateSignature(group[0].candidates);
    if (!firstSignature || !group.every((entry) => candidateSignature(entry.candidates) === firstSignature)) continue;

    const candidates = [...group[0].candidates]
      .sort((a, b) => Number(a.position || 0) - Number(b.position || 0));
    const uniqueIds = new Set(candidates.map((item) => item.internalId));
    if (uniqueIds.size !== candidates.length || group.length !== candidates.length) continue;

    group
      .sort((a, b) => a.index - b.index)
      .forEach((entry, offset) => pinned.set(entry.index, candidates[offset].internalId));
  }

  return pinned;
}
