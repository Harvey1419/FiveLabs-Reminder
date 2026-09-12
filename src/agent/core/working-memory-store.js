import {
  PENDING_INTENT_TTL_MS,
  formatPendingIntentForPrompt,
  sanitizePendingAction,
} from './pending-intent.js';
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

function sanitizePendingIntent(intent) {
  if (!intent || typeof intent !== 'object') return null;
  const actions = Array.isArray(intent.actions)
    ? intent.actions.map(sanitizePendingAction).filter(Boolean).slice(0, 12)
    : [];
  if (actions.length === 0) return null;
  return {
    version: 1,
    actions,
    missingFields: [...new Set((intent.missingFields || []).map((field) => String(field).trim()).filter(Boolean))].slice(0, 12),
    question: String(intent.question || '').trim(),
    createdAt: intent.createdAt || new Date().toISOString(),
    updatedAt: intent.updatedAt || new Date().toISOString(),
  };
}

function sanitizePendingOperation(operation) {
  if (!operation) return null;
  if (operation.kind === 'entity_delete') {
    return {
      kind: 'entity_delete',
      targetName: operation.targetName ? String(operation.targetName).trim() : null,
      category: operation.category ? String(operation.category).trim() : null,
      scope: operation.scope === 'all' ? 'all' : 'single',
      preserveNames: Array.isArray(operation.preserveNames)
        ? operation.preserveNames.map((name) => String(name).trim()).filter(Boolean).slice(0, 20)
        : [],
    };
  }
  if (operation.kind === 'reminder_cancel' && ['elapsed', 'all'].includes(operation.scope)) {
    const cutoff = operation.cutoffAt ? new Date(operation.cutoffAt) : null;
    return {
      kind: 'reminder_cancel',
      scope: operation.scope,
      cutoffAt: cutoff && !Number.isNaN(cutoff.getTime()) ? cutoff.toISOString() : null,
    };
  }
  return null;
}

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
      time: it.time || it.localTime || it.localStartTime || null,
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

  const pendingIntent = sanitizePendingIntent(memoryData.pendingIntent);
  const pendingClarifications = Array.isArray(memoryData.pendingClarifications)
    ? memoryData.pendingClarifications.map((item) => ({
      type: item.type || 'clarification',
      content: String(item.content || '').trim(),
      advanceMinutes: Number.isFinite(Number(item.advanceMinutes)) ? Number(item.advanceMinutes) : null,
      reason: String(item.reason || '').trim(),
      question: String(item.question || '').trim(),
      proposedReminder: item.proposedReminder?.targetTime
        ? {
          content: String(item.proposedReminder.content || item.content || '').trim(),
          targetTime: String(item.proposedReminder.targetTime).trim(),
          advanceMinutes: Number.isFinite(Number(item.proposedReminder.advanceMinutes))
            ? Number(item.proposedReminder.advanceMinutes)
            : null,
          recurrence: item.proposedReminder.recurrence || null,
          requiresConfirmation: Boolean(item.proposedReminder.requiresConfirmation),
          nudgeIntervalMinutes: Number.isFinite(Number(item.proposedReminder.nudgeIntervalMinutes))
            ? Number(item.proposedReminder.nudgeIntervalMinutes)
            : null,
          maxNudges: Number.isFinite(Number(item.proposedReminder.maxNudges))
            ? Number(item.proposedReminder.maxNudges)
            : null,
          replacePending: Boolean(item.proposedReminder.replacePending),
          checklist: Array.isArray(item.proposedReminder.checklist)
            ? item.proposedReminder.checklist.slice(0, 20)
            : null,
        }
        : null,
      proposedOperation: sanitizePendingOperation(item.proposedOperation),
    })).filter((item) => item.content)
    : [];
  const hasPendingState = Boolean(pendingIntent) || pendingClarifications.length > 0;
  const explicitPendingExpiry = Number(memoryData.pendingExpiresAt);
  const inheritedPendingExpiry = Number(existingEntry?.pendingExpiresAt);
  const pendingExpiresAt = hasPendingState
    ? (memoryData.refreshPendingExpiry === true
      ? Date.now() + PENDING_INTENT_TTL_MS
      : (Number.isFinite(explicitPendingExpiry) && explicitPendingExpiry > Date.now()
        ? explicitPendingExpiry
        : (Number.isFinite(inheritedPendingExpiry) && inheritedPendingExpiry > Date.now()
          ? inheritedPendingExpiry
          : Date.now() + PENDING_INTENT_TTL_MS)))
    : null;

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
    pendingIntent,
    pendingClarifications,
    pendingExpiresAt,
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
    if (entry.pendingExpiresAt && entry.pendingExpiresAt <= Date.now()) {
      entry.pendingIntent = null;
      entry.pendingClarifications = [];
      entry.pendingExpiresAt = null;
      if (!entry.items?.length) {
        for (const lookupKey of keys) workingMemoryStore.delete(lookupKey);
        return null;
      }
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

    const hasPersistedPending = Boolean(snapshot.pendingIntent)
      || (Array.isArray(snapshot.pendingClarifications) && snapshot.pendingClarifications.length > 0);
    const persistedPendingExpiry = Number(snapshot.pendingExpiresAt);
    const pendingIsUnavailable = hasPersistedPending
      && (!Number.isFinite(persistedPendingExpiry) || persistedPendingExpiry <= referenceMs);
    const restorableSnapshot = pendingIsUnavailable
      ? {
          ...snapshot,
          pendingIntent: null,
          pendingClarifications: [],
          pendingExpiresAt: null,
        }
      : snapshot;

    // A recent assistant turn may carry an older preserved pending intent.
    // Its own deadline remains authoritative; the turn timestamp must never
    // mint a fresh TTL or make Node reinterpret conversation continuity.
    if (pendingIsUnavailable && !(Array.isArray(snapshot.items) && snapshot.items.length > 0)) return null;

    saveWorkingMemory(userOrPhone, restorableSnapshot, { restoredTimestamp: timestampMs });
    return getWorkingMemory(userOrPhone);
  }

  return null;
}

export function formatWorkingMemoryPrompt(userOrPhone) {
  const wm = getWorkingMemory(userOrPhone);
  if (!wm) return '';
  const pendingClarifications = Array.isArray(wm.pendingClarifications) ? wm.pendingClarifications : [];
  const pendingIntentText = formatPendingIntentForPrompt(wm.pendingIntent);
  if ((!wm.items || wm.items.length === 0) && pendingClarifications.length === 0 && !pendingIntentText) return '';

  let pendingSection = [];
  if (pendingIntentText) {
    pendingSection.push(
      '[Typed Pending Intent — una operación conversacional coherente NO ejecutada]',
      pendingIntentText,
      'Interpreta si el mensaje actual completa, corrige, cancela o ignora esta intención. Para completarla devuelve las acciones finales fusionadas con continuationIndex y pendingIntentEffect=resolve. Si aún falta información usa replace y una sola clarification.request. Si cambia de tema usa preserve. Para cancelar usa pending.discard. Nunca pierdas campos conocidos ni ejecutes una continuación stale.',
    );
  }
  if (pendingClarifications.length > 0) {
    const lines = pendingClarifications.slice(0, 5).map((item, index) => {
      const advance = item.advanceMinutes ? ` | Aviso previo solicitado: ${item.advanceMinutes} minutos` : '';
      const question = item.question ? ` | Pregunta pendiente: ${item.question}` : '';
      const proposedAt = item.proposedReminder?.targetTime ? ` | proposedAt: ${item.proposedReminder.targetTime}` : '';
      const proposedOperation = item.proposedOperation
        ? ` | proposedOperation=${JSON.stringify(item.proposedOperation)}`
        : '';
      return `${index + 1}. contextRef={source:pending_state,position:${index + 1}} | status=NOT_EXECUTED | ${item.content}${proposedAt}${proposedOperation}${advance}${question}`;
    });
    pendingSection.push(
      '[Typed Pending State — propuestas de fondo NO ejecutadas]',
      ...lines,
      'Si el mensaje actual responde o modifica una propuesta, usa exactamente una transición canónica: pending.execute, pending.discard, pending.revise o clarification.request. Si cambia de tema y no aborda la propuesta, atiende el mensaje actual sin forzar una transición y conserva este estado pendiente. No repitas acciones ya completadas ni trates la propuesta como ejecutada.',
    );
    if (!wm.items || wm.items.length === 0) return pendingSection.join('\n');
  }

  const lines = wm.items.slice(0, 10).map((it) => {
    const typeLabel = it.type === 'calendar_event'
      ? 'Calendario'
      : (it.type === 'reminder'
        ? 'Recordatorio'
        : (it.type === 'entity' ? 'Proyecto/Entidad' : (it.type === 'task' ? 'Tarea' : 'Elemento')));
    const timeDisplay = it.time ? ` (${it.time})` : '';
    const entityDisplay = it.entityName ? ` [${it.entityName}]` : '';
    return `${it.position}. contextRef={source:working_memory,position:${it.position}} [${typeLabel}] ${it.summary}${timeDisplay}${entityDisplay}`;
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
    ...pendingSection,
    ...(pendingSection.length > 0 ? ['[Elementos ejecutados más recientes — foco para referencias nuevas]'] : []),
    '[Memoria de Trabajo del Turno Anterior — referencias, NO inventario vivo]',
    `Origen: ${sourceDesc}${containerInfo} | Período: ${wm.scope || 'general'}${wm.semanticQuery ? ` | Filtro: "${wm.semanticQuery}"` : ''}`,
    ...(containerInstruction ? [containerInstruction] : []),
    ...lines,
    '(Para operar sobre un elemento anterior, usa target: "1", target: "el primero", o el nombre. El backend resolverá el ID interno).',
  ].join('\n');
}

export function sanitizeResponseText(text) {
  if (!text || typeof text !== 'string') return '';

  let cleaned = text;
  cleaned = cleaned.replace(/\[id:\s*[^\]]+\]/gi, '');
  cleaned = cleaned.replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '');
  cleaned = cleaned.replace(/\bhermes[0-9a-f]{10,}\b/gi, '');
  cleaned = cleaned.replace(/\[\s*\]/g, '');
  cleaned = cleaned
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n\s*\n\s*\n+/g, '\n\n')
    .trim();

  return cleaned;
}

export { tokenizeText } from '../../shared/entity-resolution.js';
