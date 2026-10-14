import { tokenizeText } from '../../shared/entity-matching.js';

export interface WorkingMemoryRaw extends Record<string, unknown> {
  entities?: { id?: unknown; name?: string | null } | null;
  entityName?: string | null;
}
export interface WorkingMemoryInputItem extends WorkingMemoryRaw {
  position?: number; type?: string; internalId?: unknown; id?: unknown;
  title?: unknown; content?: unknown; name?: unknown; summary?: unknown;
  time?: unknown; formattedTime?: unknown; localTime?: unknown; localStartTime?: unknown;
  source?: string; domain?: string; entityName?: string | null; raw?: WorkingMemoryRaw;
}
export interface WorkingMemoryInput extends Record<string, unknown> {
  items?: WorkingMemoryInputItem[]; source?: string; scope?: string; semanticQuery?: string | null;
  entityType?: string; activeEntity?: string | null; entityName?: string | null;
  activeEntityId?: unknown; entityId?: unknown; lastAction?: string;
  notificationReminderId?: string | null; notificationContent?: string | null;
  infraFault?: boolean; faultReason?: unknown;
}
export interface WorkingMemoryItem extends Record<string, unknown> {
  position: number; type: string; internalId: string; summary: string; title: string;
  time: unknown; source: string; entityName: string | null; raw: WorkingMemoryRaw;
}
export interface WorkingMemoryState extends Record<string, unknown> {
  source: string; scope: string; semanticQuery: string | null; entityType: string;
  activeEntity: string | null; activeEntityId: unknown; lastAction: string;
  notificationReminderId: string | null; notificationContent: string | null;
  timestamp: number; items: WorkingMemoryItem[]; infraFault?: boolean; faultReason?: unknown;
}
export interface WorkingMemoryDependencies { clearAgentRunsForUser(userOrPhone: unknown): unknown }
interface HistoryTurn { entities?: Record<string, unknown>; createdAt?: string | number | Date }
interface PersistedMemory extends WorkingMemoryInput { timestamp?: string | number | Date; persistedAt?: string }

/** Each host instance owns its short-lived reference cache; persistence remains an injected boundary. */
export function createWorkingMemoryStore({ clearAgentRunsForUser }: WorkingMemoryDependencies) {
  /**
   * Working Memory state store.
   *
   * Owns short-lived structured conversational state and prompt/sanitization
   * presentation only. Entity/reference interpretation lives in context-reference.
   */

  const workingMemoryStore = new Map<string, WorkingMemoryState>();
  const WORKING_MEMORY_TTL_MS = 2 * 60 * 60 * 1000;
  const PERSISTED_WORKING_MEMORY_MAX_AGE_MS = WORKING_MEMORY_TTL_MS;

  function getLookupKeys(userOrPhone: unknown): string[] {
    if (!userOrPhone) return [];
    const keys = new Set<string>();

    if (typeof userOrPhone === 'string') {
      const raw = userOrPhone.trim();
      if (raw && raw !== 'anonymous') {
        keys.add(raw);
        const digitsOnly = raw.replace(/[^\w]/g, '');
        if (digitsOnly) keys.add(digitsOnly);
      }
    } else if (typeof userOrPhone === 'object') {
      const identity = userOrPhone as { id?: unknown; phone_number?: unknown };
      if (identity.id && typeof identity.id === 'string') {
        const idStr = identity.id.trim();
        if (idStr) keys.add(idStr);
      }
      if (identity.phone_number && typeof identity.phone_number === 'string') {
        const pRaw = identity.phone_number.trim();
        if (pRaw) {
          keys.add(pRaw);
          const pDigits = pRaw.replace(/[^\w]/g, '');
          if (pDigits) keys.add(pDigits);
        }
      }
    }

    return Array.from(keys);
  }

  function saveWorkingMemory(userOrPhone: unknown, memoryData: WorkingMemoryInput = {}, { restoredTimestamp = null }: { restoredTimestamp?: unknown } = {}): void {
    const keys = getLookupKeys(userOrPhone);
    if (keys.length === 0) return;
    const existingEntry = keys.map((key) => workingMemoryStore.get(key)).find(Boolean) || null;

    const rawItems = Array.isArray(memoryData.items) ? memoryData.items : [];
    const normalizedItems = rawItems.map((it, idx) => {
      const rawTitle = it.title || it.content || it.name || it.summary || '';
      const rawType = (it.type && it.type !== 'unknown')
        ? it.type
        : (memoryData.entityType && memoryData.entityType !== 'all'
          ? memoryData.entityType
          : (memoryData.source === 'task'
            ? 'task'
            : (memoryData.source === 'reminder'
              ? 'reminder'
              : (memoryData.source === 'calendar' ? 'calendar_event' : 'unknown'))));

      return {
        position: Number.isInteger(it.position) && it.position! > 0 ? it.position! : idx + 1,
        type: rawType,
        internalId: String(it.internalId || it.id || '').trim(),
        summary: String(it.summary || rawTitle).trim(),
        title: String(it.title || rawTitle).trim(),
        time: it.time === null ? null : (it.time || it.formattedTime || it.localTime || it.localStartTime || it.raw?.formattedTime || it.raw?.localFormatted || it.raw?.time || null),
        source: it.source || it.domain || memoryData.source || 'unknown',
        entityName: it.entityName || it.raw?.entities?.name || it.raw?.entityName || null,
        raw: it.raw || it,
      };
    }).filter((it) => Boolean(it.internalId));

    const explicitEntity = memoryData.activeEntity || memoryData.entityName || null;
    const uniformEntity = (!explicitEntity
      && normalizedItems.length > 0
      && normalizedItems.every((it) => it.entityName && it.entityName.toLowerCase() === normalizedItems[0]!.entityName?.toLowerCase()))
      ? normalizedItems[0]!.entityName
      : null;
    const activeEntity = explicitEntity || uniformEntity || null;
    const explicitEntityId = memoryData.activeEntityId || memoryData.entityId || null;
    const uniformEntityId = (!explicitEntityId && normalizedItems.length > 0)
      ? normalizedItems
        .map((it) => it.raw?.entity_id || it.raw?.entityId || it.raw?.entities?.id || null)
        .filter(Boolean)
        .find((id, _index, ids) => ids.every((candidateId) => candidateId === id)) || null
      : null;

    const explicitNotifId = memoryData.notificationReminderId
      || ((memoryData.lastAction === 'nudge' || memoryData.lastAction === 'reminder_dispatched')
        ? normalizedItems[0]?.internalId
        : null)
      || null;

    if (memoryData.source === 'notification') {
      const isInteractiveActive = existingEntry
        && existingEntry.source !== 'notification'
        && (Date.now() - existingEntry.timestamp < 10 * 60 * 1000);

      if (isInteractiveActive) {
        const updated = {
          ...existingEntry,
          lastAction: memoryData.lastAction !== undefined ? memoryData.lastAction : existingEntry.lastAction,
          notificationReminderId: explicitNotifId || memoryData.notificationReminderId || existingEntry.notificationReminderId,
          notificationContent: memoryData.notificationContent !== undefined ? memoryData.notificationContent : existingEntry.notificationContent,
        };
        for (const key of keys) workingMemoryStore.set(key, updated);
        return;
      }
    }

    const validRestoredTimestamp = restoredTimestamp === null ? NaN : Number(restoredTimestamp);
    const payload: WorkingMemoryState = {
      source: memoryData.source || 'unified',
      scope: memoryData.scope || 'tomorrow',
      semanticQuery: memoryData.semanticQuery || null,
      entityType: memoryData.entityType || 'all',
      activeEntity,
      activeEntityId: explicitEntityId || uniformEntityId,
      lastAction: memoryData.lastAction || 'list',
      notificationReminderId: explicitNotifId,
      notificationContent: memoryData.notificationContent || null,
      timestamp: Number.isFinite(validRestoredTimestamp) ? validRestoredTimestamp : Date.now(),
      items: normalizedItems,
      ...(memoryData.infraFault === true ? { infraFault: true, faultReason: memoryData.faultReason || 'provider_unavailable' } : {}),
    };

    for (const key of keys) workingMemoryStore.set(key, payload);
  }

  function getWorkingMemory(userOrPhone: unknown): WorkingMemoryState | null {
    const keys = getLookupKeys(userOrPhone);
    if (keys.length === 0) return null;

    for (const key of keys) {
      const entry = workingMemoryStore.get(key);
      if (!entry) continue;
      if (!Number.isFinite(entry.timestamp) || entry.timestamp > Date.now() + 60_000 || Date.now() - entry.timestamp > WORKING_MEMORY_TTL_MS) {
        workingMemoryStore.delete(key);
        continue;
      }
      return entry;
    }

    return null;
  }

  function clearWorkingMemory(userOrPhone: unknown): void {
    const keys = getLookupKeys(userOrPhone);
    for (const key of keys) workingMemoryStore.delete(key);
    clearAgentRunsForUser(userOrPhone);
  }

  /**
   * Persistable typed snapshot. Internal IDs remain backend-only inside the
   * messages.entities JSON and are never rendered into the LLM prompt directly.
   */
  function getWorkingMemorySnapshot(userOrPhone: unknown): (WorkingMemoryState & { persistedAt: string }) | null {
    const memory = getWorkingMemory(userOrPhone);
    if (!memory) return null;
    try {
      return {
        ...(JSON.parse(JSON.stringify(memory)) as WorkingMemoryState),
        persistedAt: new Date().toISOString(),
      };
    } catch {
      return null;
    }
  }

  /**
   * Restore the latest typed state from persisted assistant message metadata.
   * Current in-memory state wins. Stale snapshots are deliberately ignored so a
   * later "el segundo" cannot bind to an old conversation indefinitely.
   */
  function hydrateWorkingMemoryFromHistory(userOrPhone: unknown, history: unknown = [], now: unknown = new Date()): WorkingMemoryState | null {
    if (getWorkingMemory(userOrPhone)) return getWorkingMemory(userOrPhone);
    const referenceMs = now instanceof Date ? now.getTime() : new Date((now || Date.now()) as string | number).getTime();
    const turns = Array.isArray(history) ? history : [];

    for (let index = turns.length - 1; index >= 0; index -= 1) {
      const turn = turns[index] as HistoryTurn | null | undefined;
      const entities = turn?.entities;
      if (!entities || typeof entities !== 'object' || !Object.hasOwn(entities, '_workingMemory')) continue;
      const candidate = entities._workingMemory;
      // An assistant turn that explicitly persisted no Working Memory is an
      // authoritative tombstone. Scanning farther back would resurrect state
      // that was deliberately discarded or cleared.
      if (!candidate || typeof candidate !== 'object') return null;
      const snapshot = candidate as PersistedMemory;

      const timestampCandidate = snapshot.timestamp || turn?.createdAt || snapshot.persistedAt || null;
      const timestampMs = timestampCandidate ? new Date(timestampCandidate).getTime() : NaN;
      if (!Number.isFinite(timestampMs) || referenceMs - timestampMs > PERSISTED_WORKING_MEMORY_MAX_AGE_MS || timestampMs > referenceMs + 60_000) {
        return null;
      }

      if (!(Array.isArray(snapshot.items) && snapshot.items.length > 0) && !snapshot.activeEntity) return null;

      saveWorkingMemory(userOrPhone, snapshot, { restoredTimestamp: timestampMs });
      return getWorkingMemory(userOrPhone);
    }

    return null;
  }

  function formatWorkingMemoryPrompt(userOrPhone: unknown): string {
    const wm = getWorkingMemory(userOrPhone);
    if (!wm) return '';

    const faultNotice = wm.infraFault ? [
      '[INCIDENCIA EN TURNO PREVIO]',
      'No se obtuvo una decisión estructurada válida de la IA; no se ejecutó ninguna acción. Puede ser un fallo del proveedor o de validación, no necesariamente de red. NO inventes la causa ni afirmes que faltaban tareas/recordatorios. Las referencias conservadas son las previamente mostradas, NO estado vivo; requieren validación contra la fuente vigente.',
    ].join('\n') : '';

    if (!wm.items || wm.items.length === 0) return faultNotice;

    const lines = wm.items.slice(0, 10).map((it) => {
      const typeLabel = it.type === 'calendar_event'
        ? 'Calendario'
        : (it.type === 'reminder'
          ? 'Recordatorio'
          : (it.type === 'entity' ? 'Proyecto/Entidad' : (it.type === 'task' ? 'Tarea' : 'Elemento')));
      const timeDisplay = it.time ? ` (${it.time})` : '';
      const entityDisplay = it.entityName ? ` [${it.entityName}]` : '';
      const recurrence = Object.hasOwn(it.raw || {}, 'recurrenceRule') ? it.raw.recurrenceRule : it.raw?.recurrence_rule;
      const details = [recurrence ? `recurrence=${recurrence}` : '', it.raw?.status ? `status=${it.raw.status}` : ''].filter(Boolean).join(', ');
      return `${it.position}. contextRef={source:working_memory,position:${it.position}} [${typeLabel}] ${it.summary}${timeDisplay}${entityDisplay}${details ? ` [${details}]` : ''}`;
    });

    const sourceDesc = wm.source === 'unified'
      ? 'Agenda Unificada'
      : (wm.source === 'calendar'
        ? 'Google Calendar'
        : (wm.source === 'reminder'
          ? 'Recordatorios'
          : (wm.source === 'entity' ? 'Proyectos/Entidades' : 'Tareas')));

    const containerInfo = wm.activeEntity ? ` | Contenedor: "${wm.activeEntity}"` : '';
    const containerInstruction = wm.activeEntity
      ? (wm.source === 'task'
        ? `[CONTENEDOR OPERATIVO ACTIVO — SOLO SCOPE]\nentityName="${wm.activeEntity}". Working Memory NO contiene su inventario vigente. Toda pregunta semántica sobre contenido o estado actual exige task.list con ese entityName; conversation.reply es inválido aunque los elementos visibles parezcan suficientes.`
        : `Si el usuario se refiere al contenedor completo, usa "${wm.activeEntity}" como referencia humana estructurada; Node resolverá la entidad vigente contra la fuente de verdad.`)
      : '';

    return [
      ...(faultNotice ? [faultNotice] : []),
      '[Memoria de Trabajo del Turno Anterior — referencias, NO inventario vivo]',
      `Origen: ${sourceDesc}${containerInfo} | Período: ${wm.scope || 'general'}${wm.semanticQuery ? ` | Filtro: "${wm.semanticQuery}"` : ''}`,
      ...(containerInstruction ? [containerInstruction] : []),
      ...lines,
      '(Para tareas/recordatorios/eventos anteriores usa contextRef; conserva la posición mostrada. Nunca elijas un elemento eliminado/cancelado. Para otros dominios usa su nombre en target).',
    ].join('\n');
  }

  return { saveWorkingMemory, getWorkingMemory, clearWorkingMemory, getWorkingMemorySnapshot, hydrateWorkingMemoryFromHistory, formatWorkingMemoryPrompt };
}

export function sanitizeResponseText(text: unknown): string {
  if (!text || typeof text !== 'string') return '';

  let cleaned = text;
  cleaned = cleaned.replace(/\[id:\s*[^\]]+\]/gi, '');
  cleaned = cleaned.replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '');
  cleaned = cleaned.replace(/\bhermes[0-9a-f]{10,}\b/gi, '');
  cleaned = cleaned.replace(/\[\s*\]/g, '');
  cleaned = cleaned.replace(/insert or update on table [^]+ violates foreign key constraint [^\n.]+/gi, 'Ocurrió un inconveniente al guardar los datos.');
  cleaned = cleaned.replace(/new row for relation [^]+ violates check constraint [^\n.]+/gi, 'Los datos no cumplen las restricciones del sistema.');
  cleaned = cleaned
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n\s*\n\s*\n+/g, '\n\n')
    .trim();

  return cleaned;
}

export { tokenizeText };
