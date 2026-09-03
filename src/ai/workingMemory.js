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

  const explicitNotifId = memoryData.notificationReminderId || ((memoryData.lastAction === 'nudge' || memoryData.lastAction === 'reminder_dispatched') ? normalizedItems[0]?.internalId : null) || null;

  const payload = {
    source: memoryData.source || 'unified',
    scope: memoryData.scope || 'tomorrow',
    semanticQuery: memoryData.semanticQuery || null,
    entityType: memoryData.entityType || 'all',
    activeEntity,
    lastAction: memoryData.lastAction || 'list',
    notificationReminderId: explicitNotifId,
    notificationContent: memoryData.notificationContent || null,
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
  if (!wm || !wm.items || wm.items.length === 0) return '';

  const lines = wm.items.slice(0, 10).map(it => {
    const typeLabel = it.type === 'calendar_event'
      ? 'Calendario'
      : (it.type === 'reminder' ? 'Recordatorio' : 'Tarea');
    const timeDisplay = it.time ? ` (${it.time})` : '';
    const entityDisplay = it.entityName ? ` [${it.entityName}]` : '';
    return `${it.position}. [${typeLabel}] ${it.summary}${timeDisplay}${entityDisplay}`;
  });

  const sourceDesc = wm.source === 'unified'
    ? 'Agenda Unificada'
    : (wm.source === 'calendar' ? 'Google Calendar' : (wm.source === 'reminder' ? 'Recordatorios' : 'Tareas'));

  const containerInfo = wm.activeEntity ? ` | Contenedor: "${wm.activeEntity}"` : '';
  const containerInstruction = wm.activeEntity
    ? ` Para operar sobre toda la lista/contenedor "${wm.activeEntity}": usa scope: "all", entityName: "${wm.activeEntity}".`
    : ' Para operar sobre todo el conjunto: usa scope: "all".';

  return [
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
} from '../utils/entityResolution.js';

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
  const isCollectiveOrAnaphora = /^(la|las|el|eso|todo|todas|la lista|el proyecto|esa lista|ese proyecto|todas las tareas|todos|todo eso|todas esas cosas)$/i.test(cleanRef);
  if (isCollectiveOrAnaphora && (wm?.activeEntity || pool.length > 0)) {
    return {
      status: 'RESOLVED_CONTAINER',
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
