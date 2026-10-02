import { clearAgentRunsForUser } from '../../infrastructure/database/agent-runs.js';

/**
 * Working Memory state store.
 *
 * Owns short-lived structured conversational state and prompt/sanitization
 * presentation only. Entity/reference interpretation lives in context-reference.
 */

const workingMemoryStore = new Map();
const WORKING_MEMORY_TTL_MS = 2 * 60 * 60 * 1000;
const PERSISTED_WORKING_MEMORY_MAX_AGE_MS = WORKING_MEMORY_TTL_MS;

function getLookupKeys(userOrPhone) {
  if (!userOrPhone) return [];
  const keys = new Set();

  if (typeof userOrPhone === 'string') {
    const raw = userOrPhone.trim();
    if (raw && raw !== 'anonymous') {
      keys.add(raw);
      const digitsOnly = raw.replace(/[^\w]/g, '');
      if (digitsOnly) keys.add(digitsOnly);
    }
  } else if (typeof userOrPhone === 'object') {
    if (userOrPhone.id && typeof userOrPhone.id === 'string') {
      const idStr = userOrPhone.id.trim();
      if (idStr) keys.add(idStr);
    }
    if (userOrPhone.phone_number && typeof userOrPhone.phone_number === 'string') {
      const pRaw = userOrPhone.phone_number.trim();
      if (pRaw) {
        keys.add(pRaw);
        const pDigits = pRaw.replace(/[^\w]/g, '');
        if (pDigits) keys.add(pDigits);
      }
    }
  }

  return Array.from(keys);
}

export function saveWorkingMemory(userOrPhone, memoryData = {}, { restoredTimestamp = null } = {}) {
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
      position: idx + 1,
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
    && normalizedItems.every((it) => it.entityName && it.entityName.toLowerCase() === normalizedItems[0].entityName?.toLowerCase()))
    ? normalizedItems[0].entityName
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

  const validRestoredTimestamp = restoredTimestamp === null ? NaN : Number(restoredTimestamp);
  const payload = {
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
  };

  for (const key of keys) workingMemoryStore.set(key, payload);
}

export function getWorkingMemory(userOrPhone) {
  const keys = getLookupKeys(userOrPhone);
  if (keys.length === 0) return null;

  for (const key of keys) {
    const entry = workingMemoryStore.get(key);
    if (!entry) continue;
    if (Date.now() - entry.timestamp > WORKING_MEMORY_TTL_MS) {
      workingMemoryStore.delete(key);
      continue;
    }
    return entry;
  }

  return null;
}

export function clearWorkingMemory(userOrPhone) {
  const keys = getLookupKeys(userOrPhone);
  for (const key of keys) workingMemoryStore.delete(key);
  clearAgentRunsForUser(userOrPhone);
}

/**
 * Persistable typed snapshot. Internal IDs remain backend-only inside the
 * messages.entities JSON and are never rendered into the LLM prompt directly.
 */
export function getWorkingMemorySnapshot(userOrPhone) {
  const memory = getWorkingMemory(userOrPhone);
  if (!memory) return null;
  try {
    return {
      ...JSON.parse(JSON.stringify(memory)),
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
export function hydrateWorkingMemoryFromHistory(userOrPhone, history = [], now = new Date()) {
  if (getWorkingMemory(userOrPhone)) return getWorkingMemory(userOrPhone);
  const referenceMs = now instanceof Date ? now.getTime() : new Date(now || Date.now()).getTime();
  const turns = Array.isArray(history) ? history : [];

  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const turn = turns[index];
    const entities = turn?.entities;
    if (!entities || typeof entities !== 'object' || !Object.hasOwn(entities, '_workingMemory')) continue;
    const snapshot = entities._workingMemory;
    // An assistant turn that explicitly persisted no Working Memory is an
    // authoritative tombstone. Scanning farther back would resurrect state
    // that was deliberately discarded or cleared.
    if (!snapshot || typeof snapshot !== 'object') return null;

    const timestampCandidate = snapshot.timestamp || turn?.createdAt || snapshot.persistedAt || null;
    const timestampMs = timestampCandidate ? new Date(timestampCandidate).getTime() : NaN;
    if (!Number.isFinite(timestampMs) || referenceMs - timestampMs > PERSISTED_WORKING_MEMORY_MAX_AGE_MS || timestampMs > referenceMs + 60_000) {
      continue;
    }

    if (!(Array.isArray(snapshot.items) && snapshot.items.length > 0) && !snapshot.activeEntity) return null;

    saveWorkingMemory(userOrPhone, snapshot, { restoredTimestamp: timestampMs });
    return getWorkingMemory(userOrPhone);
  }

  return null;
}

export function formatWorkingMemoryPrompt(userOrPhone) {
  const wm = getWorkingMemory(userOrPhone);
  if (!wm) return '';

  if (wm.infraFault) {
    return [
      '[INCIDENCIA DE RED EN TURNO PREVIO]',
      'El turno inmediatamente anterior falló debido a una interrupción temporal de red/infraestructura del proveedor LLM. NO inventes causas funcionales (como que no había recordatorios o tareas). Si el usuario pregunta qué pasó, responde con naturalidad y honestidad que hubo un microcorte momentáneo de conexión con la IA y que por favor repita su mensaje.',
    ].join('\n');
  }

  if (!wm.items || wm.items.length === 0) return '';

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
    '[Memoria de Trabajo del Turno Anterior — referencias, NO inventario vivo]',
    `Origen: ${sourceDesc}${containerInfo} | Período: ${wm.scope || 'general'}${wm.semanticQuery ? ` | Filtro: "${wm.semanticQuery}"` : ''}`,
    ...(containerInstruction ? [containerInstruction] : []),
    ...lines,
    '(Para tareas/recordatorios/eventos anteriores usa contextRef; conserva la posición mostrada. Nunca elijas un elemento eliminado/cancelado. Para otros dominios usa su nombre en target).',
  ].join('\n');
}

export function sanitizeResponseText(text) {
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

export { tokenizeText } from '../../shared/entity-resolution.js';
