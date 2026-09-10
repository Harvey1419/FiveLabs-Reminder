import { saveMemory, searchMemories, findOrCreateEntityFuzzy } from '../../infrastructure/database/index.js';
import { callMemoryExtraction } from '../../agent/providers/client.js';

const MEMORY_MAX_CANDIDATES = 16;
const MEMORY_RELATED_CONTEXT_LIMIT = 8;
const MEMORY_EXTRACTION_MAX_TOKENS = 3200;
const MEMORY_EXTRACTION_TIMEOUT_MS = 15000;

const MEMORY_EXTRACTION_PROMPT = `You are the enterprise memory extraction engine of a personal assistant.
Analyze the following conversation turn between User and Assistant.

Extract atomic durable facts, personal preferences, commercial/project decisions, or relationship context that will be useful weeks or months from now. The user text is the ONLY factual source.

QUALITY OVER VOLUME:
- A normal message should usually produce 0 to 3 high-value memories. The technical maximum exists only for unusually rich onboarding or profile updates.
- One candidate must express exactly one independently useful idea. Never bundle identity, work, preferences, and procedures into one memory.
- Do not emit minor details merely because they are present. Prefer fewer durable memories over exhaustive capture.

EXISTING MEMORY IDENTITY:
- Existing active memories may be supplied only to preserve conceptual identity. They are context, never evidence for a new candidate.
- If the current user text repeats an existing memory without a material change, emit no candidate for that idea.
- If the current user text explicitly changes, corrects, or replaces an existing fact or preference, emit the new current fact using the existing memory's exact topicKey. The current user text wins.
- Create a new topicKey only for a genuinely new concept. Keep it stable and value-independent: never put a city, date, current value, adjective, or wording variant in the aspect when the key represents a mutable profile fact or preference.
- Never reproduce an existing memory unless the current user text independently supports it with exact evidence.

STRICT DO NOT EXTRACT (CRITICAL NOISE GATE):
- Bot command confirmations or operational actions (e.g. "Se eliminó el recordatorio", "Reunión duplicada", "Se cancelaron 2 tareas"). NEVER extract system execution confirmations.
- Tasks, to-do items, deadlines, or pending task status (e.g. "Se agregó la tarea X", "Tiene pendiente Y", "Tarea para hoy"). Tasks belong exclusively in the database tasks table.
- Appointments, meetings, plans tied to a date/time, or incomplete scheduling details. These belong to agenda/reminder/calendar flow even when the assistant still needs to ask for the missing clock or lead time. Do not extract a company, person, or place fact merely from where an appointment will occur.
- Assistant agenda echoes or query responses: When the user asks what they have pending or scheduled, NEVER extract new memories from the assistant listing or reading back existing tasks.
- Explicit alarms, reminders, scheduled notifications, or delivery times (these belong exclusively in the reminders table).
- Bot capabilities, system limitations, or assistant self-descriptions (e.g. "El asistente no puede enviar mensajes a terceros").
- Greetings, conversational pleasantries, or short acknowledgments (e.g. "hola", "cómo estás", "gracias", "de nada", "ok", "listo", "dale").
- Temporary states or ephemeral remarks (e.g. "tengo hambre", "estoy cansado hoy", "qué hora es").

TOPIC KEY HIERARCHY (MANDATORY FORMAT):
Always structure topicKey as a clean, lowercase hierarchical path: <category_or_entity_type>/<entity_slug>/<aspect>
Facts directly about the user themself MUST use profile/<aspect> whenever there is a stable profile aspect. Do not encode the user's own residence as a generic place memory; use profile/residence. Do not encode the user's own job as a company memory; use profile/occupation or profile/work. This makes stable self-knowledge reliably available as core profile context.
Examples:
- "person/juan_zapata/relation" (or "person/juan_zapata/status")
- "person/monica_acosta/location" (or "person/monica_acosta/contact")
- "company/ceramica_italia/location" (or "company/ceramica_italia/project")
- "project/yax/scope" (or "project/yax/presentation")
- "place/barranquilla/activities"
- "profile/residence" (or "profile/identity", "profile/occupation")
- "preference/communication" (or "preference/notifications")

CATEGORIES:
- "fact": stable truth about user, family, job, contacts, or entities (e.g. "El contador del usuario se llama Carlos")
- "decision": agreed choice, offer, commercial agreement, or negotiation state (e.g. "Oferta de venta del carro a Juan por 51M")
- "preference": how the user likes things done (e.g. "Prefiere correos breves y directos")
- "episode": notable past event or project milestone (e.g. "Medición de cocina realizada en Florencia")

ENTITY CATEGORIES (entityCategory):
- "person": personas, familiares, socios, doctores, contactos
- "company": empresas, marcas, proveedores
- "project": proyectos laborales, reformas, metas, software
- "place": ciudades (ej. Barranquilla, Madrid), países, ubicaciones
- "pet": mascotas (ej. Barón, perros, gatos)
- "asset": inmuebles, apartamentos, vehículos, herramientas
- "other": cualquier otra entidad

ENTITY NAME CANONICALIZATION (entityName):
- Emite el nombre canónico LIMPIO sin prefijos de ruido (ej: "Reminder", NO "Proyecto Reminder"; "Barranquilla", NO "Ciudad de Barranquilla"; "Barón", NO "El perro Barón"; "Yax", NO "Proyecto Yax").

ATOMICITY AND EVIDENCE RULES:
- Never combine a durable fact with a task, appointment, reminder, deadline, or temporary state.
- Every candidate must include evidence: an exact quote copied from the user text that directly supports the durable fact.
- Do not infer a relationship or entity type merely from the setting of an appointment.
- Prefer returning no candidate over storing an uncertain or mixed memory.
- Return at most ${MEMORY_MAX_CANDIDATES} candidates. If the turn contains more durable information, prioritize identity, working context, explicit preferences, standing responsibilities, and decisions that will be most useful later.
- Keep every candidate compact: topicKey at most 100 characters, content at most 180 characters, evidence one exact contiguous quote of at most 180 characters, and entityName at most 80 characters.

Respond with ONLY a JSON array:
[
  {
    "topicKey": "category_or_type/canonical_slug/aspect",
    "category": "fact" | "decision" | "preference" | "episode",
    "content": "Clear, standalone sentence in Spanish describing the durable fact",
    "evidence": "Exact supporting quote copied from the user text",
    "entityName": "Canonical name without prefix noise, or null",
    "entityCategory": "person" | "company" | "project" | "place" | "pet" | "asset" | "other" | null
  }
]

If nothing durable is worth saving, respond with: []`;

/**
 * Clean and canonicalize topic keys to guarantee deterministic superseding across turns.
 */
export function canonicalizeTopicKey(rawTopicKey, entityName = null, category = 'fact') {
  if (!rawTopicKey) {
    if (entityName) {
      const slug = entityName.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
      return `entity/${slug}/general`;
    }
    return `profile/${category}`;
  }

  let clean = String(rawTopicKey).toLowerCase().trim();
  clean = clean
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9/_]/g, '_')
    .replace(/_+/g, '_')
    .replace(/\/+/g, '/')
    .replace(/^[/_]+|[/_]+$/g, '');

  return clean || `profile/${category}`;
}

/**
 * Extract durable memories from a conversation turn and persist them.
 *
 * @param {object} params
 * @param {string} params.userId
 * @param {string} params.userText
 * @param {string} params.assistantReply - Accepted for caller compatibility, but never used as factual evidence.
 * @param {Array<object>} params.executionFacts - Validated backend outcomes used to remove operational clauses.
 * @param {'extract'|'skip_operational'} params.memoryDisposition - Semantic turn classification from orchestration.
 * @returns {Promise<Array<object>>}
 */
export async function extractAndSaveMemories({
  userId,
  userText,
  assistantReply,
  executionFacts = [],
  memoryDisposition = 'extract',
}) {
  if (!userId || !userText) return [];

  if (memoryDisposition === 'skip_operational' && executionFacts.length === 0) {
    console.log('[memoryService] SKIPPED extraction: unresolved operational-only turn.');
    return [];
  }

  const hasAttachmentEvidence = /<untrusted_attachment_content>/i.test(userText);
  const trustedUserText = String(userText)
    .replace(/<untrusted_attachment_content>[\s\S]*?<\/untrusted_attachment_content>/gi, '')
    .trim();
  if (hasAttachmentEvidence && !trustedUserText) return [];

  const trimmed = trustedUserText.toLowerCase();
  const PURE_TRIVIAL_REGEX = /^(hola|hi|hey|buenos\s+d[ií]as|buenas\s+tardes|buenas\s+noches|ok|listo|dale|gracias|muchas\s+gracias|de\s+nada|chao|adi[oó]s|done|ya|perfecto|entendido)$/i;
  if (trimmed.length < 5 || PURE_TRIVIAL_REGEX.test(trimmed)) return [];

  const eligibleText = getMemoryEligibleText(trustedUserText, executionFacts);
  if (!eligibleText) {
    console.log('[memoryService] SKIPPED extraction: turn content was fully consumed by operational tools.');
    return [];
  }

  try {
    const messages = [
      { role: 'system', content: MEMORY_EXTRACTION_PROMPT },
      {
        role: 'user',
        content: buildMemoryExtractionInput({ userText: eligibleText, existingMemories: await findRelatedActiveMemories(userId, eligibleText) }),
      },
    ];

    const rawResponse = await callMemoryExtraction(messages, {
      temperature: 0,
      max_tokens: MEMORY_EXTRACTION_MAX_TOKENS,
      timeoutMs: MEMORY_EXTRACTION_TIMEOUT_MS,
    });
    const candidates = parseJsonArray(rawResponse);
    if (!Array.isArray(candidates) || candidates.length === 0) return [];

    const saved = [];
    for (const item of candidates.slice(0, MEMORY_MAX_CANDIDATES)) {
      if (!item.content) continue;
      const rejectionReason = getMemoryCandidateRejection(item, eligibleText, executionFacts);
      if (rejectionReason) {
        console.log(`[memoryService] REJECTED candidate reason=${rejectionReason} topic=${item.topicKey || 'unknown'}`);
        continue;
      }

      let canonicalName = item.entityName ? String(item.entityName).trim() : null;
      let matchedEntity = null;
      if (canonicalName) {
        try {
          matchedEntity = await findOrCreateEntityFuzzy({
            userId,
            name: canonicalName,
            category: item.entityCategory || 'other',
          });
          if (matchedEntity?.name) canonicalName = matchedEntity.name;
        } catch (entErr) {
          console.warn('[memoryService] entity fuzzy match error:', entErr.message);
        }
      }

      const safeTopicKey = canonicalizeTopicKey(item.topicKey, canonicalName, item.category);
      const mem = await saveMemory({
        userId,
        topicKey: safeTopicKey,
        category: item.category || 'fact',
        content: item.content,
      });

      if (mem) {
        saved.push(mem);
        console.log(`[memoryService] SAVED MEMORY (${safeTopicKey}): "${item.content}"`);
      }
    }
    return saved;
  } catch (err) {
    console.error('[memoryService] extractAndSaveMemories threw:', err);
    return [];
  }
}

/**
 * Structured profile ranking remains available for explicit profile-oriented
 * surfaces, but is not injected unconditionally into every Hermes turn.
 */
const CORE_PROFILE_ASPECTS = new Set([
  'identity', 'name', 'residence', 'location', 'occupation', 'work', 'job',
  'language', 'family', 'relationship', 'contact', 'communication', 'notifications',
]);

function coreProfileScore(memory) {
  const topic = String(memory?.topic_key || '').toLowerCase();
  const category = String(memory?.category || '').toLowerCase();
  if (!topic) return 0;
  if (topic.startsWith('profile/')) return 100;
  if (topic.startsWith('preference/')) return 95;
  if (category === 'preference') return 90;

  const segments = topic.split('/').filter(Boolean);
  const aspect = segments.at(-1) || '';
  if (CORE_PROFILE_ASPECTS.has(aspect) && category === 'fact') return 80;
  return 0;
}

export function selectCoreProfileMemories(memories, limit = 10) {
  const safeLimit = Math.min(Math.max(1, Number(limit) || 10), 15);
  return (Array.isArray(memories) ? memories : [])
    .map((memory, index) => ({ memory, score: coreProfileScore(memory), index }))
    .filter(({ score }) => score > 0)
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .slice(0, safeLimit)
    .map(({ memory }) => ({ ...memory, category: `core_profile:${memory.category || 'fact'}` }));
}

/**
 * Retrieve only query-relevant durable memory for the foreground turn.
 * `limit` is the total prompt budget, not a semantic result count plus an
 * additional always-on profile. Relevance is delegated to the hybrid semantic
 * search (vector threshold + FTS); Node does not maintain a phrase list for
 * greetings or other conversational forms.
 */
export async function retrieveRelevantMemories({ userId, queryText, limit = 5 }) {
  if (!userId || !queryText) return [];

  const hasAttachmentEvidence = /<untrusted_attachment_content>/i.test(queryText);
  const retrievalQuery = String(queryText)
    .replace(/<untrusted_attachment_content>[\s\S]*?<\/untrusted_attachment_content>/gi, '')
    .trim();
  if (!retrievalQuery) return [];

  // Attachment content is untrusted evidence. With only a tiny trusted caption,
  // avoid allowing the attachment body to drive durable-memory retrieval.
  if (hasAttachmentEvidence && retrievalQuery.split(/\s+/).length <= 5) return [];

  const safeLimit = Math.min(Math.max(1, Number(limit) || 5), 10);
  const semanticMemories = await searchMemories({
    userId,
    query: retrievalQuery,
    limit: safeLimit,
  });
  return (Array.isArray(semanticMemories) ? semanticMemories : []).slice(0, safeLimit);
}

function parseJsonArray(text) {
  if (!text) return [];
  try {
    let clean = text.trim();
    const start = clean.indexOf('[');
    const end = clean.lastIndexOf(']');
    if (start >= 0 && end > start) {
      clean = clean.slice(start, end + 1);
      return JSON.parse(clean);
    }
    const parsed = JSON.parse(clean);
    if (Array.isArray(parsed?.memories)) return parsed.memories;
  } catch (err) {
    console.warn('[memoryService] JSON array parse failed:', err.message);
  }
  return [];
}

async function findRelatedActiveMemories(userId, query) {
  try {
    const related = await searchMemories({ userId, query, limit: MEMORY_RELATED_CONTEXT_LIMIT });
    return (Array.isArray(related) ? related : [])
      .filter((memory) => memory?.topic_key && memory?.content)
      .slice(0, MEMORY_RELATED_CONTEXT_LIMIT)
      .map((memory) => ({
        topicKey: String(memory.topic_key),
        category: String(memory.category || 'fact'),
        content: String(memory.content),
      }));
  } catch (error) {
    console.warn('[memoryService] related memory lookup failed:', error.message);
    return [];
  }
}

export function buildMemoryExtractionInput({ userText, existingMemories = [] }) {
  const related = Array.isArray(existingMemories) ? existingMemories.slice(0, MEMORY_RELATED_CONTEXT_LIMIT) : [];
  return `Existing active memories (identity context only; never factual evidence):\n<existing_memories>${JSON.stringify(related)}</existing_memories>\n\nUser text (the only factual source):\n<user_text>${userText}</user_text>`;
}

const OPERATIONAL_MEMORY_TOOLS = new Set([
  'manage_reminder', 'manage_task', 'manage_entity', 'manage_google_calendar', 'get_unified_agenda',
  'manage_memory',
]);

const MEMORY_STOPWORDS = new Set([
  'a', 'al', 'and', 'at', 'con', 'de', 'del', 'el', 'en', 'for', 'la', 'las', 'le', 'lo', 'los',
  'me', 'mi', 'of', 'para', 'por', 'que', 'the', 'to', 'un', 'una', 'y', 'yo',
]);

function meaningfulTokens(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .split(/\s+/)
    .filter((token) => token.length > 1 && !MEMORY_STOPWORDS.has(token));
}

function tokenOverlap(left, right) {
  const leftTokens = [...new Set(meaningfulTokens(left))];
  const rightTokens = new Set(meaningfulTokens(right));
  if (leftTokens.length === 0 || rightTokens.size === 0) return 0;
  return leftTokens.filter((token) => rightTokens.has(token)).length / leftTokens.length;
}

function operationalCorpus(executionFacts) {
  return (executionFacts || [])
    .filter((fact) => OPERATIONAL_MEMORY_TOOLS.has(fact?.tool))
    .map((fact) => `${fact.card || ''} ${fact.summary || ''}`)
    .join(' ');
}

export function getMemoryEligibleText(userText, executionFacts = []) {
  const corpus = operationalCorpus(executionFacts);
  if (!corpus) return String(userText || '').trim();

  const clauses = String(userText || '')
    .split(/(?<=[.!?])\s+|[\n;]+/)
    .map((clause) => clause.trim())
    .filter(Boolean);
  const residual = clauses.filter((clause) => tokenOverlap(clause, corpus) < 0.5);
  return residual.join(' ').trim();
}

function getMemoryCandidateRejection(item, sourceText, executionFacts) {
  if (!String(item?.topicKey || '').trim()) return 'missing_topic_key';
  const evidence = String(item?.evidence || '').trim();
  if (!evidence) return 'missing_user_evidence';

  const normalizedSource = meaningfulTokens(sourceText).join(' ');
  const normalizedEvidence = meaningfulTokens(evidence).join(' ');
  if (!normalizedEvidence || !normalizedSource.includes(normalizedEvidence)) return 'evidence_not_in_user_text';

  const corpus = operationalCorpus(executionFacts);
  if (corpus && (tokenOverlap(evidence, corpus) >= 0.5 || tokenOverlap(item.content, corpus) >= 0.5)) {
    return 'overlaps_operational_execution';
  }
  return null;
}
