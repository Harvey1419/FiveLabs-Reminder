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
  const normalizedItems = rawItems.map((it, idx) => ({
    position: idx + 1,
    type: it.type || 'unknown', // 'calendar_event' | 'reminder' | 'task'
    internalId: String(it.internalId || it.id || '').trim(),
    summary: String(it.summary || it.title || it.content || '').trim(),
    time: it.time || it.localTime || it.localStartTime || null,
    source: it.source || it.domain || memoryData.source || 'unknown',
    raw: it.raw || it,
  })).filter(it => Boolean(it.internalId));

  const payload = {
    source: memoryData.source || 'unified',
    scope: memoryData.scope || 'tomorrow',
    semanticQuery: memoryData.semanticQuery || null,
    entityType: memoryData.entityType || 'all',
    lastAction: memoryData.lastAction || 'list',
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
    return `${it.position}. [${typeLabel}] ${it.summary}${timeDisplay}`;
  });

  const sourceDesc = wm.source === 'unified'
    ? 'Agenda Unificada'
    : (wm.source === 'calendar' ? 'Google Calendar' : (wm.source === 'reminder' ? 'Recordatorios' : 'Tareas'));

  return [
    `[Memoria de Trabajo del Turno Anterior]`,
    `Origen: ${sourceDesc} | Período: ${wm.scope || 'general'}${wm.semanticQuery ? ` | Filtro: "${wm.semanticQuery}"` : ''}`,
    ...lines,
    `(Para operar sobre un elemento de la lista anterior, usa target: "1", target: "el primero", o el nombre; el backend resolverá el ID interno).`,
  ].join('\n');
}

/**
 * Normalize text tokens for semantic scoring
 */
export function tokenizeText(str) {
  return String(str || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\w\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 2 && !['para', 'los', 'las', 'con', 'que', 'por', 'del', 'una', 'uno', 'este', 'esta', 'ese', 'esa', 'mis', 'tus', 'los', 'les', 'nos', 'hable', 'hablar', 'escribi', 'escribir', 'hice', 'hacer', 'quedo', 'quedar'].includes(w));
}

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
  const refStr = String(reference || '').trim().toLowerCase();
  if (!refStr) {
    return { status: 'NOT_FOUND', reason: 'EMPTY_REFERENCE' };
  }

  const wm = getWorkingMemory(userOrPhone);
  const wmItems = (wm?.items || []);

  let pool = wmItems.slice();

  // If explicit candidate items are provided (e.g. active pending reminders in DB or date-bounded search), prioritize them
  if (candidates && Array.isArray(candidates)) {
    const normCandidates = candidates.map((c, idx) => ({
      position: idx + 1,
      type: c.type || (c.due_date ? 'task' : (c.content || c.title ? 'reminder' : 'calendar_event')),
      internalId: String(c.internalId || c.id || ''),
      summary: String(c.summary || c.content || c.title || ''),
      time: c.localTime || c.time || null,
      source: c.source || (c.due_date ? 'task' : 'reminder'),
      raw: c.raw || c,
    })).filter(c => Boolean(c.internalId));

    pool = normCandidates;
  }

  if (pool.length === 0) {
    return { status: 'NOT_FOUND', reason: 'NO_CANDIDATES_AVAILABLE' };
  }

  // Filter by preferredType if explicitly requested and matches exist
  if (preferredType) {
    const typeFiltered = pool.filter(it => it.type === preferredType);
    if (typeFiltered.length > 0) {
      pool = typeFiltered;
    }
  }

  // 1. Direct Ordinal Matching
  const ordinalMap = {
    '1': 1, 'primero': 1, 'primera': 1, 'primer': 1, 'el 1': 1, 'el primero': 1, 'la primera': 1, 'opcion 1': 1, 'opción 1': 1,
    '2': 2, 'segundo': 2, 'segunda': 2, 'el 2': 2, 'el segundo': 2, 'la segunda': 2, 'opcion 2': 2, 'opción 2': 2,
    '3': 3, 'tercero': 3, 'tercera': 3, 'tercer': 3, 'el 3': 3, 'el tercero': 3, 'la tercera': 3, 'opcion 3': 3, 'opción 3': 3,
    '4': 4, 'cuarto': 4, 'cuarta': 4, 'el 4': 4, 'el cuarto': 4, 'la cuarta': 4,
    '5': 5, 'quinto': 5, 'quinta': 5, 'el 5': 5, 'el quinto': 5, 'la quinta': 5,
  };

  const cleanRef = refStr.replace(/^#/, '').trim();
  if (ordinalMap[cleanRef] !== undefined) {
    const pos = ordinalMap[cleanRef];
    const match = pool.find(it => it.position === pos) || pool[pos - 1];
    if (match) {
      return { status: 'RESOLVED', item: match };
    }
  }

  // Check for "el último" / "la última"
  if (['ultimo', 'ultima', 'el ultimo', 'la ultima', 'el último', 'la última'].includes(cleanRef)) {
    const match = pool[pool.length - 1];
    if (match) {
      return { status: 'RESOLVED', item: match };
    }
  }

  // 2. Relative temporal superlatives: "el más temprano", "el más tarde"
  if (cleanRef.includes('mas temprano') || cleanRef.includes('más temprano') || cleanRef.includes('primero')) {
    const timedItems = pool.filter(it => Boolean(it.time));
    if (timedItems.length > 0) {
      return { status: 'RESOLVED', item: timedItems[0] };
    }
  }
  if (cleanRef.includes('mas tarde') || cleanRef.includes('más tarde') || cleanRef.includes('ultimo')) {
    const timedItems = pool.filter(it => Boolean(it.time));
    if (timedItems.length > 0) {
      return { status: 'RESOLVED', item: timedItems[timedItems.length - 1] };
    }
  }

  // 3. Direct ID prefix match if raw UUID or prefix was provided
  const directIdMatch = pool.find(it => it.internalId === refStr || it.internalId.startsWith(refStr));
  if (directIdMatch) {
    return { status: 'RESOLVED', item: directIdMatch };
  }

  // 4. Normalized semantic matching across candidate items
  const refTokens = tokenizeText(cleanRef);
  if (refTokens.length > 0) {
    const scored = [];
    for (const it of pool) {
      const itTokens = tokenizeText(it.summary || it.content || it.title);
      if (itTokens.length === 0) continue;

      const matchedTokens = refTokens.filter(rt => itTokens.some(itT => itT.includes(rt) || rt.includes(itT)));
      const matchCount = matchedTokens.length;
      if (matchCount === 0) continue;

      // Token coverage relative to reference tokens
      const queryCoverage = matchCount / refTokens.length;

      // Candidate must match at least 50% of reference tokens (or 100% for single-word queries)
      if (queryCoverage >= 0.5 || refTokens.length === 1) {
        const itemPrecision = matchCount / itTokens.length;
        const f1Score = (2 * queryCoverage * itemPrecision) / (queryCoverage + itemPrecision) || queryCoverage;
        const finalScore = Math.max(queryCoverage, f1Score);

        if (finalScore >= 0.5) {
          scored.push({ item: it, score: finalScore });
        }
      }
    }

    scored.sort((a, b) => b.score - a.score);

    if (scored.length === 1 && scored[0].score >= 0.5) {
      return { status: 'RESOLVED', item: scored[0].item };
    }

    if (scored.length > 1) {
      const top = scored[0];
      const runnerUp = scored[1];
      // Unambiguous winner check
      if (top.score >= 0.75 && (top.score - runnerUp.score) >= 0.25) {
        return { status: 'RESOLVED', item: top.item };
      }
      // Ambiguous: multiple plausible candidates
      return {
        status: 'AMBIGUOUS',
        candidates: scored.map(s => s.item),
        reason: 'MULTIPLE_CANDIDATES',
      };
    }
  }

  // If pool has exactly 1 item and user said something affirmative/referential ("cancélalo", "borralo", "eliminalo", "eso", "listo", "ya fui", "ya lo hice", "ya está", "ya quedó", "lo terminé", "ya terminé", "ok", "hecho")
  const isAffirmative = /\b(cancelalo|cancélalo|borralo|bórralo|eliminalo|elimínalo|eso|el|la|listo|hecho|ya|fui|ya\s+fui|ya\s+lo\s+hice|lo\s+hice|ya\s+esta|ya\s+está|ya\s+quedo|ya\s+quedó|lo\s+termine|lo\s+terminé|ya\s+termine|ya\s+terminé|ok|completado|completada)\b/i.test(cleanRef);
  if (pool.length === 1 && isAffirmative) {
    return { status: 'RESOLVED', item: pool[0] };
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
