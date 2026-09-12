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
  const persistedWorkingMemory = latestState.workingMemory || null;
  const persistedItems = Array.isArray(persistedWorkingMemory?.items)
    ? persistedWorkingMemory.items
    : [];
  if (persistedItems.length === 0 && !persistedWorkingMemory?.activeEntity) return;
  const persistedTimestamp = Number(persistedWorkingMemory?.timestamp);

  saveWorkingMemory(userOrPhone, {
    source: persistedWorkingMemory?.source || 'reminder',
    scope: persistedWorkingMemory?.scope || 'current',
    semanticQuery: persistedWorkingMemory?.semanticQuery || null,
    entityType: persistedWorkingMemory?.entityType || 'reminder',
    activeEntity: persistedWorkingMemory?.activeEntity || null,
    activeEntityId: persistedWorkingMemory?.activeEntityId || null,
    lastAction: persistedWorkingMemory?.lastAction || 'restored',
    items: persistedItems,
  }, {
    restoredTimestamp: Number.isFinite(persistedTimestamp) ? persistedTimestamp : null,
  });
}

export function getClarificationStateSnapshot(userOrPhone) {
  const memory = getWorkingMemory(userOrPhone);
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
  const hasState = items.length > 0 || Boolean(memory?.activeEntity);
  return {
    version: 3,
    pendingIntent: null,
    pendingClarifications: [],
    workingMemory: hasState
      ? {
        source: memory?.source || 'unified',
        scope: memory?.scope || 'current',
        semanticQuery: memory?.semanticQuery || null,
        entityType: memory?.entityType || 'all',
        activeEntity: memory?.activeEntity || null,
        activeEntityId: memory?.activeEntityId || null,
        lastAction: memory?.lastAction || 'list',
        timestamp: memory?.timestamp || null,
        items,
      }
      : null,
    expiresAt: hasState
      ? Number(Number(memory?.timestamp || Date.now()) + 15 * 60 * 1000)
      : null,
  };
}
