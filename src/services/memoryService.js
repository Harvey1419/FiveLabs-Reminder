import { saveMemory, searchMemories, getOrCreateEntity } from '../db/index.js';
import { callChatCompletion } from '../ai/client.js';

const MEMORY_EXTRACTION_PROMPT = `You are the memory extraction engine of a personal assistant.
Analyze the following conversation turn between User and Assistant.

Extract durable facts, personal preferences, commercial/project decisions, or relationship information that will be useful weeks or months from now.

DO NOT EXTRACT:
- Greetings or conversational filler (e.g. "hola", "cómo estás", "gracias")
- Temporary questions or short-term acknowledgments (e.g. "qué hora es", "ok", "listo")
- Temporary states (e.g. "tengo hambre", "estoy cansado hoy")
- Explicit alarms/reminders (these are stored in the reminders table)

CATEGORIES:
- "fact": stable truth about user, family, job, contacts (e.g. "El contador del usuario se llama Carlos")
- "decision": agreed choice, offer, or negotiation state (e.g. "Oferta de venta del carro a Juan por 51M")
- "preference": how the user likes things done (e.g. "Prefiere correos breves")
- "episode": notable past event or project milestone

ENTITY CATEGORIES (entityCategory):
- "person": personas, familiares, socios, doctores, contactos
- "company": empresas, marcas, proveedores
- "project": proyectos laborales, reformas, metas, software
- "place": ciudades (ej. Barranquilla, Madrid), países, ubicaciones
- "pet": mascotas (ej. Barón, perros, gatos)
- "asset": inmuebles, apartamentos, vehículos, herramientas
- "other": cualquier otra entidad

ENTITY NAME CANONICALIZATION (entityName):
- Emite el nombre canónico LIMPIO sin prefijos de ruido (ej: "Reminder", NO "Proyecto Reminder"; "Barranquilla", NO "Ciudad de Barranquilla"; "Barón", NO "El perro Barón").

Respond with ONLY a JSON array:
[
  {
    "topicKey": "topic_name",
    "category": "fact" | "decision" | "preference" | "episode",
    "content": "Clear, standalone sentence in Spanish describing the fact",
    "entityName": "Canonical name without prefix noise, or null",
    "entityCategory": "person" | "company" | "project" | "place" | "pet" | "asset" | "other" | null
  }
]

If nothing durable is worth saving, respond with: []`;

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

  // Quick filter: skip single-word messages or pure greetings
  const trimmed = userText.trim().toLowerCase();
  if (trimmed.length < 5 || trimmed === 'hola' || trimmed === 'ok' || trimmed === 'gracias') {
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

    const rawResponse = await callChatCompletion(messages, { temperature: 0.1 });
    const candidates = parseJsonArray(rawResponse);

    if (!Array.isArray(candidates) || candidates.length === 0) {
      return [];
    }

    const saved = [];
    for (const item of candidates) {
      if (!item.content) continue;

      const mem = await saveMemory({
        userId,
        topicKey: item.topicKey || null,
        category: item.category || 'fact',
        content: item.content,
      });

      if (mem) {
        saved.push(mem);
        console.log(`[memoryService] SAVED MEMORY (${item.topicKey || 'general'}): "${item.content}"`);

        // If an entity was named, register/update it
        if (item.entityName) {
          await getOrCreateEntity({
            userId,
            name: item.entityName,
            category: item.entityCategory || 'other',
          }).catch(err => console.warn('[memoryService] entity auto-link error:', err.message));
        }
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
export async function retrieveRelevantMemories({ userId, queryText, limit = 4 }) {
  if (!userId || !queryText) return [];

  // Filter out short greetings from triggering search
  if (queryText.trim().length < 3) return [];

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
