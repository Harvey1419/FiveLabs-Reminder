import { TOOL_NAMES } from '../contracts/tool-names.js';
import { getWorkingMemory, saveWorkingMemory, clearWorkingMemory } from './working-memory-store.js';

function extractWorkingItems(data) {
  if (!data) return [];
  if (Array.isArray(data)) return data;
  if (Array.isArray(data.items)) return data.items;
  if (Array.isArray(data.events)) return data.events;
  if (Array.isArray(data.reminders)) return data.reminders;
  if (Array.isArray(data.tasks)) return data.tasks;
  if (data.id && (data.title || data.content || data.name || data.summary)) return [data];
  return [];
}

function inferItemType(toolName) {
  if (toolName === TOOL_NAMES.MANAGE_TASK) return 'task';
  if (toolName === TOOL_NAMES.MANAGE_PROJECT) return 'project';
  if (toolName === TOOL_NAMES.MANAGE_REMINDER) return 'reminder';
  if (toolName === TOOL_NAMES.MANAGE_GOOGLE_CALENDAR) return 'calendar_event';
  if (toolName === TOOL_NAMES.MANAGE_ENTITY) return 'entity';
  return 'all';
}

export function updateWorkingMemoryFromExecution({ user, toolName, params, result }) {
  const existingMemory = getWorkingMemory(user);

  if (
    toolName === TOOL_NAMES.MANAGE_REMINDER
    && params.action === 'acknowledge'
    && result.success
  ) {
    if (!existingMemory) return;
    const acknowledgedId = String(result.data?.id || params.reminderId || '').trim();
    const remainingItems = (existingMemory.items || []).filter((item) => (
      !acknowledgedId || String(item?.internalId || '').trim() !== acknowledgedId
    ));
    if (remainingItems.length === 0 && !existingMemory.activeEntity) {
      clearWorkingMemory(user);
      return;
    }
    saveWorkingMemory(user, {
      ...existingMemory,
      lastAction: 'reminder_acknowledged',
      notificationReminderId: null,
      notificationContent: null,
      items: remainingItems,
    });
    return;
  }

  const mutation = {
    [TOOL_NAMES.MANAGE_TASK]: ['update', 'complete', 'delete'],
    [TOOL_NAMES.MANAGE_REMINDER]: ['update', 'cancel'],
    [TOOL_NAMES.MANAGE_GOOGLE_CALENDAR]: ['update_event', 'delete_event'],
  }[toolName]?.includes(params.action);
  if (mutation && result.success && existingMemory?.items?.length) {
    const targetId = String(params.reminderId || params.eventId || params.target || '').trim();
    const matchingIndex = existingMemory.items.findIndex(item => item.internalId === targetId && item.type === inferItemType(toolName));
    if (matchingIndex >= 0) {
      const returned = result.data && typeof result.data === 'object' && !Array.isArray(result.data)
        ? (result.data.data && typeof result.data.data === 'object' ? result.data.data : result.data) : {};
      const removed = ['delete', 'delete_event', 'cancel'].includes(params.action);
      const items = existingMemory.items.map((item, index) => {
        if (index !== matchingIndex) return item;
        const raw = { ...(item.raw || {}), ...returned, id: item.internalId };
        // Tool DTOs and persisted snapshots use different field names. An
        // explicit null must also clear the old alias instead of reviving it.
        for (const [camel, snake] of [['recurrenceRule', 'recurrence_rule'], ['sendAt', 'send_at'], ['dueDate', 'due_date']]) {
          if (Object.hasOwn(returned, camel)) raw[snake] = returned[camel];
          else if (Object.hasOwn(returned, snake)) raw[camel] = returned[snake];
        }
        if (removed) raw.status = params.action === 'cancel' ? 'cancelled' : 'deleted';
        if (params.action === 'complete') raw.status = 'completed';
        const clearedDeadline = (Object.hasOwn(returned, 'due_date') && returned.due_date === null)
          || (Object.hasOwn(returned, 'dueDate') && returned.dueDate === null);
        return {
          ...item,
          title: removed ? item.title : String(returned.title || returned.content || returned.summary || item.title),
          summary: removed ? item.summary : String(returned.title || returned.content || returned.summary || item.summary),
          time: clearedDeadline ? null : (returned.formattedTime || returned.localStartTime || returned.localTime || returned.sendAt || returned.start || item.time),
          raw,
        };
      });
      // Preserve positions and tombstones across all domains, including mixed agendas.
      saveWorkingMemory(user, { ...existingMemory, lastAction: result.action || params.action, items });
      return;
    }
  }

  const items = extractWorkingItems(result.data);
  if (items.length === 0) return;
  const firstType = items[0]?.type || inferItemType(toolName);
  const uniform = items.every((item) => (item.type || firstType) === firstType);
  const source = toolName === TOOL_NAMES.GET_UNIFIED_AGENDA
    ? 'unified'
    : toolName === TOOL_NAMES.MANAGE_GOOGLE_CALENDAR
      ? 'calendar'
      : toolName === TOOL_NAMES.MANAGE_REMINDER
        ? 'reminder'
        : toolName === TOOL_NAMES.MANAGE_PROJECT
          ? 'project'
          : toolName === TOOL_NAMES.MANAGE_ENTITY ? 'entity' : 'task';

  const uniformEntityName = items.length > 0
    && items.every((item) => item?.entityName && item.entityName === items[0]?.entityName)
    ? items[0].entityName
    : null;
  const uniformEntityId = items.length > 0
    ? items
      .map((item) => item?.entityId || item?.raw?.entity_id || item?.raw?.entityId || item?.raw?.entities?.id || null)
      .filter(Boolean)
      .find((id, _index, ids) => ids.every((candidate) => candidate === id)) || null
    : null;
  const activeEntity = result.data?.entityName
    || params.entityName
    || ((toolName === TOOL_NAMES.MANAGE_PROJECT || toolName === TOOL_NAMES.MANAGE_ENTITY) ? result.data?.name : null)
    || uniformEntityName;
  const activeEntityId = result.data?.entityId
    || ((toolName === TOOL_NAMES.MANAGE_PROJECT || toolName === TOOL_NAMES.MANAGE_ENTITY) ? result.data?.id : null)
    || uniformEntityId;

  let workingItems = items;
  const sameContainer = Boolean(
    existingMemory
    && toolName === TOOL_NAMES.MANAGE_TASK
    && params.action === 'create'
    && (
      (activeEntityId && existingMemory.activeEntityId === activeEntityId)
      || (activeEntity && existingMemory.activeEntity === activeEntity)
    )
  );
  if (sameContainer) {
    const byId = new Map();
    for (const item of [...(existingMemory.items || []), ...items]) {
      const id = String(item?.internalId || item?.id || '').trim();
      if (id) byId.set(id, item);
    }
    workingItems = [...byId.values()].slice(-10);
  }

  saveWorkingMemory(user, {
    source,
    scope: params.scope || 'current',
    semanticQuery: params.query || null,
    entityType: uniform ? firstType : 'all',
    activeEntity,
    activeEntityId,
    lastAction: result?.action === 'partially_created_reminders' ? 'partially_created' : toolName,
    items: workingItems,
  });
}

/** Apply observed pending outcomes through the same reference rules as fresh turns. */
export function updateWorkingMemoryFromFacts(user, facts, { creationsOnly = false } = {}) {
  const observed = facts.filter(fact => fact.success && fact.outcome !== 'unknown');
  const first = observed[0];
  if (!first) return;
  const sameCreation = observed.every(fact => fact.tool === first.tool
    && fact.requestedAction === 'create'
    && fact.presentationParams?.entityName === first.presentationParams?.entityName);
  if (creationsOnly && !sameCreation) return;
  if (sameCreation) {
    const items = observed.flatMap(fact => extractWorkingItems(fact.presentationData));
    updateWorkingMemoryFromExecution({ user, toolName: first.tool, params: first.presentationParams,
      result: { success: true, action: first.action, data: { ...first.presentationData, items } } });
    return;
  }
  for (const fact of observed) {
    updateWorkingMemoryFromExecution({ user, toolName: fact.tool, params: fact.presentationParams,
      result: { success: true, action: fact.action, data: fact.presentationData } });
  }
}
