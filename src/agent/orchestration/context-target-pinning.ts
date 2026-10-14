import { parseStructuredOrdinal, resolveContextReference } from '../core/context-reference-resolver.js';

import type { ContextItem, ContextMemory } from '../core/context-reference-resolver.js';
export interface TargetAction extends Record<string, unknown> {
  domain?: string;
  action?: string;
  scope?: string;
  target?: string | null;
}
type TargetedAction = TargetAction & { target: string };
/** Host memory is a trusted projection, not model input or execution authority. */
function isContextMemory(value: unknown): value is ContextMemory {
  return !!value && typeof value === 'object' && 'items' in value && Array.isArray(value.items);
}

function isSingleReminderTargetAction(action: TargetAction | null | undefined): action is TargetedAction {
  return action?.domain === 'reminder'
    && ['cancel', 'update'].includes(action?.action || '')
    && !['all', 'elapsed'].includes(action?.scope || '')
    && typeof action?.target === 'string'
    && action.target.trim().length > 0;
}

function isSingleTaskMutationAction(action: TargetAction | null | undefined): action is TargetedAction {
  return action?.domain === 'task'
    && ['update', 'complete', 'delete'].includes(action?.action || '')
    && typeof action?.target === 'string'
    && action.target.trim().length > 0;
}

function candidateSignature(candidates: ContextItem[] = []): string {
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
 * Ambiguous structured references may use different human wording while still
 * resolving to the same exact Working Memory candidate set. Pair those actions
 * one-to-one only when the action count exactly covers that candidate set.
 * Partial ambiguous selections remain unresolved instead of guessing.
 */
export function pinReminderCancellationTargets(actions: TargetAction[] = [], workingMemory: unknown = null): Map<number, string> {
  const pinned = new Map<number, string>();
  if (!Array.isArray(actions) || !isContextMemory(workingMemory)) return pinned;

  const ambiguousGroups = new Map<string, { index: number; candidates: ContextItem[] }[]>();

  actions.forEach((action, index) => {
    if (!isSingleReminderTargetAction(action)) return;

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

    const signature = candidateSignature(candidates);
    if (!signature) return;
    const group = ambiguousGroups.get(signature) || [];
    group.push({ index, candidates });
    ambiguousGroups.set(signature, group);
  });

  for (const group of ambiguousGroups.values()) {
    if (group.length < 2) continue;

    const firstSignature = candidateSignature(group[0]!.candidates);
    if (!firstSignature || !group.every((entry) => candidateSignature(entry.candidates) === firstSignature)) continue;

    const candidates = [...group[0]!.candidates]
      .sort((a, b) => Number(a.position || 0) - Number(b.position || 0));
    const uniqueIds = new Set(candidates.map((item) => item.internalId));
    if (uniqueIds.size !== candidates.length || group.length !== candidates.length) continue;

    group
      .sort((a, b) => a.index - b.index)
      .forEach((entry, offset) => pinned.set(entry.index, candidates[offset]!.internalId));
  }

  return pinned;
}

/** Freeze task mutation references against the pre-mutation ordered snapshot. */
export function pinTaskMutationTargets(actions: TargetAction[] = [], workingMemory: unknown = null): Map<number, string> {
  const pinned = new Map<number, string>();
  if (!Array.isArray(actions) || !isContextMemory(workingMemory)) return pinned;
  const taskCount = workingMemory.items.filter((item) => item?.type === 'task').length;

  actions.forEach((action, index) => {
    if (!isSingleTaskMutationAction(action)) return;
    const ordinal = parseStructuredOrdinal(action.target);
    if (taskCount > 0 && ordinal !== null && ordinal > taskCount) return;
    const resolved = resolveContextReference({
      reference: action.target.trim(),
      preferredType: 'task',
      workingMemory,
    });
    if (resolved.status === 'RESOLVED' && resolved.item?.internalId) {
      pinned.set(index, resolved.item.internalId);
    }
  });

  return pinned;
}

export function findOutOfRangeTaskOrdinalTargets(actions: TargetAction[] = [], workingMemory: unknown = null): Set<number> {
  const invalid = new Set<number>();
  if (!Array.isArray(actions) || !isContextMemory(workingMemory)) return invalid;
  const taskCount = workingMemory.items.filter((item) => item?.type === 'task').length;
  if (taskCount === 0) return invalid;

  actions.forEach((action, index) => {
    if (!isSingleTaskMutationAction(action)) return;
    const ordinal = parseStructuredOrdinal(action.target);
    if (ordinal !== null && ordinal > taskCount) invalid.add(index);
  });
  return invalid;
}

export const pinReminderTargets = pinReminderCancellationTargets;
