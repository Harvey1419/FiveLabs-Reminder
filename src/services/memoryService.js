import { saveMemory, searchMemories, findOrCreateEntityFuzzy } from '../db/index.js';
import { callChatCompletion, callGeminiDirect } from '../ai/client.js';

const MEMORY_EXTRACTION_PROMPT = `You are the enterprise memory extraction engine of a personal assistant.
Analyze the following conversation turn between User and Assistant.

Extract durable facts, personal preferences, commercial/project decisions, or relationship context that will be useful weeks or months from now.

STRICT DO NOT EXTRACT (CRITICAL NOISE GATE):
- Bot command confirmations or operational actions (e.g. "Se eliminó el recordatorio", "Reunión duplicada", "Se cancelaron 2 tareas"). NEVER extract system execution confirmations.
- Tasks, to-do items, deadlines, or pending task status (e.g. "Se agregó la tarea X", "Tiene pendiente Y", "Tarea para hoy"). Tasks belong exclusively in the database tasks table.
- Assistant agenda echoes or query responses: When the user asks what they have pending or scheduled, NEVER extract new memories from the assistant listing or reading back existing tasks.
- Explicit alarms, reminders, scheduled notifications, or delivery times (these belong exclusively in the reminders table).
- Bot capabilities, system limitations, or assistant self-descriptions (e.g. "El asistente no puede enviar mensajes a terceros").
- Greetings, conversational pleasantries, or short acknowledgments (e.g. "hola", "cómo estás", "gracias", "de nada", "ok", "listo", "dale").
- Temporary states or ephemeral remarks (e.g. "tengo hambre", "estoy cansado hoy", "qué hora es").

TOPIC KEY HIERARCHY (MANDATORY FORMAT):
Always structure topicKey as a clean, lowercase hierarchical path: <category_or_entity_type>/<entity_slug>/<aspect>
Examples:
- "person/juan_zapata/relation" (or "person/juan_zapata/status")
- "person/monica_acosta/location" (or "person/monica_acosta/contact")
- "company/ceramica_italia/location" (or "company/ceramica_italia/project")
- "project/yax/scope" (or "project/yax/presentation")
- "place/barranquilla/activities"
- "profile/residence" (or "profile/identity")
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

SYNTHESIS RULE:
Combine related points into a single, cohesive, high-signal standalone sentence rather than generating multiple fragmented micro-memories for the same entity.

Respond with ONLY a JSON array:
[
  {
    "topicKey": "category_or_type/canonical_slug/aspect",
    "category": "fact" | "decision" | "preference" | "episode",
    "content": "Clear, standalone sentence in Spanish describing the durable fact",
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
 * @param {string} params.assistantReply
 * @returns {Promise<Array<object>>}
 */
export async function extractAndSaveMemories({ userId, userText, assistantReply }) {
  if (!userId || !userText) return [];

  // Quick filter: skip single-word messages, pure greetings, or agenda queries
  const trimmed = userText.trim().toLowerCase();
  if (trimmed.length < 5 || trimmed === 'hola' || trimmed === 'ok' || trimmed === 'gracias') {
    return [];
  }

  // Pure query turns (asking what tasks or reminders exist), confirmations, or polite closures do not generate new facts
  const isQueryTurn = /\b(qu[eé]\s+(?:tengo|hay|tareas|recordatorios|pendientes|citas)|cu[aá]l\s+es\s+(?:la\s+m[aá]s\s+pr[oó]xima|el\s+pr[oó]ximo)|a\s+qu[eé]\s+hora|cu[aá]ndo\s+tengo|agenda|mis\s+pendientes|mis\s+recordatorios|what\s+(?:tasks|reminders|do\s+i\s+have)|no\s+(?:tenemos|tengo|hay)\s+(?:nada|ning[uú]n|m[aá]s)|no\s+necesito\s+nada|eso\s+es\s+todo|gracias\s+por\s+(?:recordar|avisar|la\s+informaci[oó]n)|verdad\?|cierto\?)\b/i.test(trimmed);
  if (isQueryTurn) {
    return [];
  }

  try {
    const messages = [
      { role: 'system', content: MEMORY_EXTRACTION_PROMPT },
      {
        role: 'user',
        content: `User said: "${userText}"\nAssistant replied: "${assistantReply}"`,
      },
    ];

    const rawResponse = (await callGeminiDirect(messages, { temperature: 0.1, max_tokens: 800 }))
      || (await callChatCompletion(messages, { temperature: 0.1 }));
    const candidates = parseJsonArray(rawResponse);

    if (!Array.isArray(candidates) || candidates.length === 0) {
      return [];
    }

    const saved = [];
    for (const item of candidates) {
      if (!item.content) continue;

      let canonicalName = item.entityName ? String(item.entityName).trim() : null;
      let matchedEntity = null;

      // 1. If an entity was named, resolve or register with fuzzy deduplication
      if (canonicalName) {
        try {
          matchedEntity = await findOrCreateEntityFuzzy({
            userId,
            name: canonicalName,
            category: item.entityCategory || 'other',
          });
          if (matchedEntity?.name) {
            canonicalName = matchedEntity.name;
          }
        } catch (entErr) {
          console.warn('[memoryService] entity fuzzy match error:', entErr.message);
        }
      }

      // 2. Canonicalize topicKey to guarantee deterministic superseding
      const safeTopicKey = canonicalizeTopicKey(item.topicKey, canonicalName, item.category);

      // 3. Save memory (superseding any previous active memory with identical topicKey)
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
 * Retrieve active memories relevant to a user's query or conversation context.
 *
 * @param {object} params
 * @param {string} params.userId
 * @param {string} params.queryText
 * @param {number} [params.limit=4]
 * @returns {Promise<Array<object>>}
 */
const META_MEMORY_QUERY_REGEX = /\b(qu[eé]\s+(sabes|conoces|recuerdas|guardas|tienes)\s+(de|sobre|acerca\s+de)\s+m[ií]|qu[eé]\s+memorias\s+tienes|qu[eé]\s+informaci[oó]n\s+tienes\s+(de|sobre)\s+m[ií]|dime\s+(todo\s+)?(lo\s+que\s+sabes|mis\s+memorias|mis\s+preferencias|mis\s+datos)|qu[eé]\s+sabes\s+de\s+mi|qu[eé]\s+sabes\s+sobre\s+mi)\b/i;

const OPERATIONAL_OR_CONVERSATIONAL_REGEX = /^(hola|buenos\s+d[ií]as|buenas\s+tardes|buenas\s+noches|gracias|muchas\s+gracias|mil\s+gracias|de\s+nada|ok|listo|dale|de\s+una|perfecto|entendido|chao|adi[oó]s|hasta\s+luego|qu[eé]\s+puedes\s+hacer|qui[eé]n\s+eres|ayuda|recu[eé]rdame|acu[eé]rdame|av[ií]same|remind\s+me|quita|cancela|elimina|borra|cambia|mueve|\d+\s*minutos?\s*antes|\d+\s*horas?\s*antes|mu[eé]strame|lista|agenda|pendientes|mis\s+(tareas|pendientes|recordatorios)|qu[eé]\s+(tareas|pendientes|recordatorios|actividades|compromisos|citas)|qu[eé]\s+(tengo|hay|qued[oó]|queda|tenemos)\s+(de\s+|para\s+)?(hoy|mañana|tareas|pendientes|recordatorios|actividades|hacer)|cu[aá]les\s+(son\s+)?(mis\s+)?(tareas|pendientes|recordatorios)|dime\s+(mis\s+|las\s+|la\s+)?(tareas|pendientes|recordatorios|agenda)|c[oó]mo\s+quedan|otra\s+vez)\b/i;

export async function retrieveRelevantMemories({ userId, queryText, limit = 5 }) {
  if (!userId || !queryText) return [];

  // If user asks about their overall memory profile, retrieve all active memories
  if (META_MEMORY_QUERY_REGEX.test(queryText)) {
    const { getActiveMemories } = await import('../db/index.js');
    return getActiveMemories({ userId, limit: Math.max(limit, 15) });
  }

  const clean = queryText.trim().toLowerCase().replace(/[.,!?:;¿¡]/g, '');
  // Skip embedding vector search on operational commands, greetings, task/agenda queries, and relative follow-up turns
  if (clean.length < 4 || OPERATIONAL_OR_CONVERSATIONAL_REGEX.test(clean)) {
    return [];
  }

  return searchMemories({
    userId,
    query: queryText,
    limit,
  });
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
  } catch (err) {
    console.warn('[memoryService] JSON array parse failed:', err.message);
  }
  return [];
}
