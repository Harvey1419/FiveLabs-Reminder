/**
 * Working Memory (Short-Term Conversational State) & Deterministic Reference Resolver
 *
 * Responsibilities:
 * 1. Maintain short-term structured state per user/phone (TTL: 15 mins).
 * 2. Resolve relative references ('el primero', 'la segunda', 'la cita', 'el más temprano')
 *    to internal entity IDs without exposing UUIDs or internal IDs to the LLM or user.
 * 3. Provide deterministic disambiguation: 0 match -> error/no-op, 1 match -> exact ID, >1 matches -> ambiguous (ask clarification, no mutation).
 * 4. Output response sanitization to guarantee NO internal IDs/UUIDs leak to WhatsApp.
 */

// In-memory working memory cache keyed by canonical user identifier (userId or clean phone)
const workingMemoryStore = new Map();
const WORKING_MEMORY_TTL_MS = 15 * 60 * 1000; // 15 minutes
const COLLECTIVE_REFERENCES = new Set([
  'la', 'las', 'el', 'eso', 'todo', 'todas', 'la lista', 'el proyecto',
  'esa lista', 'ese proyecto', 'todas las tareas', 'todos', 'todo eso', 'todas esas cosas',
]);

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

/**
 * Extract all normalized lookup keys for a user identifier or user object.
 */
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

/**
 * Save structured working memory for a user.
 *
 * @param {string|object} userOrPhone
 * @param {object} memoryData
 * @param {string} [memoryData.source] - 'unified' | 'calendar' | 'reminder' | 'task' | 'memory'
 * @param {string} [memoryData.scope] - 'today' | 'tomorrow' | 'this_week' | 'next_week' | 'custom'
 * @param {string} [memoryData.semanticQuery]
 * @param {string} [memoryData.entityType] - 'all' | 'calendar_event' | 'reminder' | 'task'
 * @param {string} [memoryData.activeEntityId] - Trusted backend ID for the active container; never exposed to the model
 * @param {string} [memoryData.lastAction]
 * @param {Array<object>} memoryData.items - Ordered list of structured items
 */
export function saveWorkingMemory(userOrPhone, memoryData = {}) {
  const keys = getLookupKeys(userOrPhone);
  if (keys.length === 0) return;

  const rawItems = Array.isArray(memoryData.items) ? memoryData.items : [];
  const normalizedItems = rawItems.map((it, idx) => {
    const rawTitle = it.title || it.content || it.name || it.summary || '';
    const rawType = (it.type && it.type !== 'unknown')
      ? it.type
      : (memoryData.entityType && memoryData.entityType !== 'all'
        ? memoryData.entityType
        : (memoryData.source === 'task' ? 'task' : (memoryData.source === 'reminder' ? 'reminder' : (memoryData.source === 'calendar' ? 'calendar_event' : 'unknown'))));

    return {
      position: idx + 1,
      type: rawType, // 'calendar_event' | 'reminder' | 'task'
      internalId: String(it.internalId || it.id || '').trim(),
      summary: String(it.summary || rawTitle).trim(),
      title: String(it.title || rawTitle).trim(),
      time: it.time || it.localTime || it.localStartTime || null,
      source: it.source || it.domain || memoryData.source || 'unknown',
      entityName: it.entityName || it.raw?.entities?.name || it.raw?.entityName || null,
      raw: it.raw || it,
    };
  }).filter(it => Boolean(it.internalId));

  // Determine uniform or explicit active container/entity
  const explicitEntity = memoryData.activeEntity || memoryData.entityName || null;
  const uniformEntity = (!explicitEntity && normalizedItems.length > 0 && normalizedItems.every(it => it.entityName && it.entityName.toLowerCase() === normalizedItems[0].entityName?.toLowerCase()))
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

  const explicitNotifId = memoryData.notificationReminderId || ((memoryData.lastAction === 'nudge' || memoryData.lastAction === 'reminder_dispatched') ? normalizedItems[0]?.internalId : null) || null;

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
    pendingClarifications: Array.isArray(memoryData.pendingClarifications)
      ? memoryData.pendingClarifications.map((item) => ({
        type: item.type || 'clarification',
        content: String(item.content || '').trim(),
        sourceTimeText: String(item.sourceTimeText || '').trim(),
        advanceMinutes: Number.isFinite(Number(item.advanceMinutes)) ? Number(item.advanceMinutes) : null,
        reason: String(item.reason || '').trim(),
        question: String(item.question || '').trim(),
        proposedReminder: item.proposedReminder?.targetTime
          ? {
            content: String(item.proposedReminder.content || item.content || '').trim(),
            targetTime: String(item.proposedReminder.targetTime).trim(),
            sourceTimeText: String(item.proposedReminder.sourceTimeText || item.sourceTimeText || '').trim(),
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
      : [],
    timestamp: Date.now(),
    items: normalizedItems,
  };

  for (const k of keys) {
    workingMemoryStore.set(k, payload);
  }
}

/**
 * Retrieve working memory for a user if within TTL.
 *
 * @param {string|object} userOrPhone
 * @returns {object|null}
 */
export function getWorkingMemory(userOrPhone) {
  const keys = getLookupKeys(userOrPhone);
  if (keys.length === 0) return null;

  for (const k of keys) {
    const entry = workingMemoryStore.get(k);
    if (entry) {
      if (Date.now() - entry.timestamp > WORKING_MEMORY_TTL_MS) {
        workingMemoryStore.delete(k);
        continue;
      }
      return entry;
    }
  }

  return null;
}

/**
 * Clear working memory for a user.
 */
export function clearWorkingMemory(userOrPhone) {
  const keys = getLookupKeys(userOrPhone);
  for (const k of keys) {
    workingMemoryStore.delete(k);
  }
}

/**
 * Format working memory for inclusion in the Agent Core System Prompt.
 * CRITICAL: Zero database UUIDs or internal IDs are included here!
 * Only ordinal positions (1, 2, 3...) and human summaries are shown.
 *
 * @param {string|object} userOrPhone
 * @returns {string}
 */
export function formatWorkingMemoryPrompt(userOrPhone) {
  const wm = getWorkingMemory(userOrPhone);
  if (!wm) return '';
  const pendingClarifications = Array.isArray(wm.pendingClarifications) ? wm.pendingClarifications : [];
  if ((!wm.items || wm.items.length === 0) && pendingClarifications.length === 0) return '';

  let pendingSection = [];
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
    pendingSection = [
      '[Typed Pending State — propuestas de fondo NO ejecutadas]',
      ...lines,
      'Si el mensaje actual responde o modifica una propuesta, usa exactamente una transición: execute_pending, discard_pending, revise_pending o clarification_request. Si cambia de tema y no aborda la propuesta, atiende el mensaje actual sin forzar una transición y conserva este estado pendiente. No repitas acciones ya completadas ni trates la propuesta como ejecutada.',
    ];
    if (!wm.items || wm.items.length === 0) return pendingSection.join('\n');
  }

  const lines = wm.items.slice(0, 10).map(it => {
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
    : (wm.source === 'calendar' ? 'Google Calendar' : (wm.source === 'reminder' ? 'Recordatorios' : 'Tareas'));

  const containerInfo = wm.activeEntity ? ` | Contenedor: "${wm.activeEntity}"` : '';
  const containerInstruction = wm.activeEntity
    ? ` Para operar sobre toda la lista/contenedor "${wm.activeEntity}": usa scope: "all", entityName: "${wm.activeEntity}".`
    : ' Para operar sobre todo el conjunto: usa scope: "all".';

  return [
    ...pendingSection,
    ...(pendingSection.length > 0 ? ['[Elementos ejecutados más recientes — foco para referencias nuevas]'] : []),
    `[Memoria de Trabajo del Turno Anterior]`,
    `Origen: ${sourceDesc}${containerInfo} | Período: ${wm.scope || 'general'}${wm.semanticQuery ? ` | Filtro: "${wm.semanticQuery}"` : ''}`,
    ...lines,
    `(Para operar sobre un elemento de la lista anterior, usa target: "1", target: "el primero", o el nombre.${containerInstruction} El backend resolverá el ID interno).`,
  ].join('\n');
}

/**
 * Normalize text tokens for semantic scoring
 */
import {
  isStrictUUID,
  normalizeTextForMatching,
  stripConversationalWrappers,
  isStandaloneAffirmative,
  parseOrdinalReference,
  tokenizeText,
  calculateMatchScore,
} from '../../shared/entity-resolution.js';

export { tokenizeText };

/**
 * Deterministic Entity Reference Resolver.
 * Resolves relative references ("el primero", "la segunda", "la cita médica", "1", "el más temprano")
 * against working memory or provided active candidates.
 *
 * @param {object} params
 * @param {string|object} params.userOrPhone
 * @param {string} params.reference - Raw reference string from LLM or user text
 * @param {Array<object>} [params.candidates] - Fallback candidate list (e.g. pendingConfirmationReminders)
 * @param {string} [params.preferredType] - 'calendar_event' | 'reminder' | 'task'
 * @returns {{ status: 'RESOLVED'|'AMBIGUOUS'|'NOT_FOUND', item?: object, candidates?: Array<object>, reason?: string }}
 */
export function resolveEntityReference({
  userOrPhone,
  reference,
  candidates = null,
  preferredType = null,
}) {
  if (!reference) {
    return { status: 'NOT_FOUND', reason: 'EMPTY_REFERENCE' };
  }

  const rawRefStr = String(reference).trim();
  if (!rawRefStr) {
    return { status: 'NOT_FOUND', reason: 'EMPTY_REFERENCE' };
  }

  const wm = getWorkingMemory(userOrPhone);
  const wmItems = (wm?.items || []);

  let pool = [];
  if (wmItems.length > 0) {
    if (preferredType) {
      const typeFiltered = wmItems.filter(it => it.type === preferredType);
      if (typeFiltered.length > 0) {
        pool = typeFiltered;
      }
    } else {
      pool = wmItems.slice();
    }
  }

  // If pool is empty (no Working Memory), fallback to candidate list
  if (pool.length === 0 && candidates && Array.isArray(candidates) && candidates.length > 0) {
    pool = candidates.map((c, idx) => ({
      position: idx + 1,
      type: c.type || (c.due_date ? 'task' : (c.content || c.title ? 'reminder' : 'calendar_event')),
      internalId: String(c.internalId || c.id || ''),
      summary: String(c.summary || c.content || c.title || ''),
      time: c.localTime || c.time || null,
      source: c.source || (c.due_date ? 'task' : 'reminder'),
      raw: c.raw || c,
    })).filter(c => Boolean(c.internalId));

    if (preferredType) {
      pool = pool.filter(it => it.type === preferredType);
    }
  }

  if (pool.length === 0) {
    return { status: 'NOT_FOUND', reason: 'NO_CANDIDATES_AVAILABLE' };
  }

  // 1. Direct Ordinal Matching (e.g. "1", "el primero", "la segunda", "#2", "el último", "la segunda ya la hice")
  const strippedRef = stripConversationalWrappers(rawRefStr);
  const ordinalPos = parseOrdinalReference(strippedRef) || parseOrdinalReference(rawRefStr);
  if (ordinalPos !== null) {
    if (ordinalPos === -1) {
      const match = pool[pool.length - 1];
      if (match) return { status: 'RESOLVED', item: match };
    } else {
      const match = pool.find(it => it.position === ordinalPos) || pool[ordinalPos - 1];
      if (match) return { status: 'RESOLVED', item: match };
    }
  }

  const cleanRef = normalizeTextForMatching(rawRefStr);

  // 2. Relative temporal superlatives: "el más temprano", "el más tarde"
  if (cleanRef.includes('mas temprano') || cleanRef.includes('primero')) {
    const timedItems = pool.filter(it => Boolean(it.time));
    if (timedItems.length > 0) {
      return { status: 'RESOLVED', item: timedItems[0] };
    }
  }
  if (cleanRef.includes('mas tarde') || cleanRef.includes('ultimo')) {
    const timedItems = pool.filter(it => Boolean(it.time));
    if (timedItems.length > 0) {
      return { status: 'RESOLVED', item: timedItems[timedItems.length - 1] };
    }
  }

  // 3. Direct ID match if exact or prefix UUID was provided
  const directIdMatch = pool.find(it => it.internalId === rawRefStr || (rawRefStr.length >= 8 && it.internalId.startsWith(rawRefStr)));
  if (directIdMatch) {
    return { status: 'RESOLVED', item: directIdMatch };
  }

  // 4. Cleaned query semantic matching (strip completion wrappers)
  const queryToMatch = strippedRef || rawRefStr;
  const refTokens = tokenizeText(queryToMatch);

  if (refTokens.length > 0) {
    const scored = [];
    for (const it of pool) {
      const itSummary = it.summary || it.content || it.title || '';
      const score = calculateMatchScore(queryToMatch, itSummary);
      if (score >= 0.5) {
        scored.push({ item: it, score });
      }
    }

    scored.sort((a, b) => b.score - a.score);

    if (scored.length === 1) {
      return { status: 'RESOLVED', item: scored[0].item };
    }

    if (scored.length > 1) {
      const top = scored[0];
      const runnerUp = scored[1];
      if (top.score >= 0.75 && (top.score - runnerUp.score) >= 0.20) {
        return { status: 'RESOLVED', item: top.item };
      }
      return {
        status: 'AMBIGUOUS',
        candidates: scored.map(s => s.item),
        reason: 'MULTIPLE_CANDIDATES',
      };
    }
  }

  // 5. Standalone Affirmative Contextual Resolution:
  // If pool has exactly 1 candidate and user provided a standalone affirmative ("listo", "ya lo hice", "ya fui", "ya está", "ya quedó")
  if (pool.length === 1 && isStandaloneAffirmative(rawRefStr)) {
    return { status: 'RESOLVED', item: pool[0] };
  }

  // 6. Container / Collective Anaphora Resolution:
  // If user refers to the entire list or uses collective/anaphoric pronouns ("la", "las", "eso", "todo", "todas", "la lista", "el proyecto")
  const isCollectiveOrAnaphora = COLLECTIVE_REFERENCES.has(cleanRef.toLocaleLowerCase());
  if (isCollectiveOrAnaphora && (wm?.activeEntity || pool.length > 0)) {
    return {
      status: 'RESOLVED_CONTAINER',
      entityId: wm?.activeEntityId || null,
      entityName: wm?.activeEntity || pool[0]?.entityName || null,
      items: pool,
    };
  }

  return { status: 'NOT_FOUND', reason: 'NO_MATCHING_ENTITY' };
}

/**
 * Output Response Sanitizer.
 * Enforces strict boundary: INTERNAL TOOL CONTEXT ≠ USER-FACING RESPONSE.
 * Completely strips any accidental database UUIDs, internal [id: ...] tags,
 * and system markers before delivering text to WhatsApp.
 *
 * @param {string} text
 * @returns {string}
 */
export function sanitizeResponseText(text) {
  if (!text || typeof text !== 'string') return '';

  let cleaned = text;

  // 1. Remove [id: ...] or [id:xxxxxxxx] tags (case insensitive)
  cleaned = cleaned.replace(/\[id:\s*[^\]]+\]/gi, '');

  // 2. Remove isolated standard 36-character UUIDs (e.g. 550e8400-e29b-41d4-a716-446655440000)
  cleaned = cleaned.replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '');

  // 3. Remove raw Google event internal IDs (e.g. hermes7a8f9b... or 26+ alphanumeric hashes)
  cleaned = cleaned.replace(/\bhermes[0-9a-f]{10,}\b/gi, '');

  // 4. Remove empty brackets left over (e.g. "[]", "[ ]")
  cleaned = cleaned.replace(/\[\s*\]/g, '');

  // 5. Clean consecutive whitespaces and trailing spaces on lines
  cleaned = cleaned
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n\s*\n\s*\n+/g, '\n\n')
    .trim();

  return cleaned;
}
