import { saveMemory, searchMemories, getOrCreateEntity } from '../db/index.js';
import { callChatCompletion, callGeminiDirect } from '../ai/client.js';

const MEMORY_EXTRACTION_PROMPT = `You are the memory extraction engine of a personal assistant.
Analyze the following conversation turn between User and Assistant.

Extract durable facts, personal preferences, commercial/project decisions, or relationship information that will be useful weeks or months from now.

DO NOT EXTRACT (CRITICAL):
- Tasks, to-do items, deadlines, or pending task status (e.g. "Se agregó la tarea X", "Tiene pendiente Y", "Tarea para hoy"). Tasks belong exclusively in the database tasks table.
- Explicit alarms/reminders (these belong exclusively in the reminders table).
- Greetings or conversational filler (e.g. "hola", "cómo estás", "gracias")
- Temporary questions or short-term acknowledgments (e.g. "qué hora es", "ok", "listo")
- Temporary states (e.g. "tengo hambre", "estoy cansado hoy")

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

    const rawResponse = (await callGeminiDirect(messages, { temperature: 0.1, max_tokens: 800 }))
      || (await callChatCompletion(messages, { temperature: 0.1 }));
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
const CONVERSATIONAL_SKIP_REGEX = /^(hola|buenos\s+d[ií]as|buenas\s+tardes|buenas\s+noches|gracias|muchas\s+gracias|mil\s+gracias|de\s+nada|ok|listo|dale|de\s+una|perfecto|entendido|chao|adi[oó]s|hasta\s+luego|qu[eé]\s+puedes\s+hacer|qui[eé]n\s+eres|ayuda)$/i;

export async function retrieveRelevantMemories({ userId, queryText, limit = 4 }) {
  if (!userId || !queryText) return [];

  const clean = queryText.trim().toLowerCase().replace(/[.,!?:;¿¡]/g, '');
  // Skip embedding vector search on pure greetings, pleasantries, and short conversational turns
  if (clean.length < 3 || CONVERSATIONAL_SKIP_REGEX.test(clean)) {
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
