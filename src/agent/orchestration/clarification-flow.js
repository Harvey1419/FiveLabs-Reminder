import { getWorkingMemory, saveWorkingMemory } from '../core/working-memory.js';

/**
 * Restore bounded typed conversational state after a process restart from the
 * latest assistant turn. Internal IDs remain backend-only; the prompt formatter
 * exposes only human labels and ordinal context references.
 */
export function hydrateClarificationStateFromHistory(userOrPhone, history = []) {
  if (getWorkingMemory(userOrPhone)) return;

  const latestState = [...history].reverse().find((turn) => (
    turn?.role === 'assistant' && turn?.entities?._conversationState
  ))?.entities?._conversationState;
  if (!latestState) return;

  const expiresAt = Number(latestState.expiresAt || 0);
  if (expiresAt && expiresAt <= Date.now()) return;
  const pendingClarifications = Array.isArray(latestState.pendingClarifications)
    ? latestState.pendingClarifications
    : [];
  const pendingIntent = latestState.pendingIntent || null;
  const persistedWorkingMemory = latestState.workingMemory || null;
  const persistedItems = Array.isArray(persistedWorkingMemory?.items)
    ? persistedWorkingMemory.items
    : [];
  if (pendingClarifications.length === 0 && !pendingIntent && persistedItems.length === 0) return;
  const hasEntityProposal = pendingClarifications.some((item) => item?.proposedOperation?.kind === 'entity_delete');

  saveWorkingMemory(userOrPhone, {
    source: persistedWorkingMemory?.source || (hasEntityProposal ? 'entity' : 'reminder'),
    scope: persistedWorkingMemory?.scope || (pendingClarifications.length > 0 ? 'clarification' : 'current'),
    semanticQuery: persistedWorkingMemory?.semanticQuery || null,
    entityType: persistedWorkingMemory?.entityType || (hasEntityProposal ? 'entity' : 'reminder'),
    activeEntity: persistedWorkingMemory?.activeEntity || null,
    activeEntityId: persistedWorkingMemory?.activeEntityId || null,
    lastAction: persistedWorkingMemory?.lastAction || (pendingClarifications.length > 0 ? 'clarification_required' : 'restored'),
    pendingIntent,
    pendingClarifications,
    pendingExpiresAt: expiresAt || null,
    items: persistedItems,
  });
}

export function getClarificationStateSnapshot(userOrPhone) {
  const memory = getWorkingMemory(userOrPhone);
  const pendingClarifications = Array.isArray(memory?.pendingClarifications)
    ? memory.pendingClarifications
    : [];
  const pendingIntent = memory?.pendingIntent || null;
  const items = Array.isArray(memory?.items)
    ? memory.items.slice(0, 10).map((item) => ({
      id: item.internalId,
      type: item.type,
      summary: item.summary,
      title: item.title,
      time: item.time,
      source: item.source,
      entityName: item.entityName,
    }))
    : [];
  const hasState = pendingClarifications.length > 0 || Boolean(pendingIntent) || items.length > 0;
  return {
    version: 3,
    pendingIntent,
    pendingClarifications,
    workingMemory: hasState
      ? {
        source: memory?.source || 'unified',
        scope: memory?.scope || 'current',
        semanticQuery: memory?.semanticQuery || null,
        entityType: memory?.entityType || 'all',
        activeEntity: memory?.activeEntity || null,
        activeEntityId: memory?.activeEntityId || null,
        lastAction: memory?.lastAction || 'list',
        items,
      }
      : null,
    expiresAt: hasState
      ? Number(memory?.pendingExpiresAt || (Number(memory?.timestamp || Date.now()) + 15 * 60 * 1000))
      : null,
  };
}
