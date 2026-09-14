/**
 * Deterministic interceptor for task and project inventory queries.
 *
 * When an LLM interprets an inventory query (e.g. '"qué tareas tengo en reminder"')
 * as conversational commentary (domain: 'conversation', action: 'reply'), it bypasses
 * database queries and hallucinates stale counts from conversation history.
 *
 * This interceptor guarantees that explicit requests to view or list tasks or projects
 * are deterministically executed against authoritative database storage.
 */

const TEMPORAL_SCOPE_MAP = new Map([
  ['hoy', 'today'],
  ['today', 'today'],
  ['mañana', 'tomorrow'],
  ['manana', 'tomorrow'],
  ['tomorrow', 'tomorrow'],
  ['esta semana', 'this_week'],
  ['this week', 'this_week'],
]);

/**
 * Strips surrounding quotation marks, backticks, brackets, and leading/trailing whitespace.
 */
export function sanitizeUserQueryText(text) {
  if (!text || typeof text !== 'string') return '';
  return text
    .replace(/<untrusted_attachment_content>[\s\S]*?<\/untrusted_attachment_content>/gi, '')
    .trim()
    .replace(/^["'“`«\s]+|["'”`»\s]+$/g, '')
    .trim();
}

/**
 * Inspects user text to detect explicit task or project inventory queries.
 * Returns an operational action object if detected, or null to allow normal routing.
 *
 * @param {string} rawText
 * @returns {{ domain: string, action: string, entityName?: string, scope?: string } | null}
 */
export function detectInventoryQuery(rawText) {
  const text = sanitizeUserQueryText(rawText);
  if (!text) return null;

  // Clean trailing punctuation (?, !, .)
  const clean = text.replace(/[?.!]+$/, '').trim();

  // 1. Projects listing
  const projectListPattern = /^(?:(?:qu[eé]|cu[aá]les)\s+(?:son\s+)?(?:mis\s+)?proyectos(?:\s+(?:que\s+tengo|tengo|hay))?|(?:ver|mostrar|listar|dime|ens[eñ]ame)\s+(?:mis\s+)?proyectos|mis\s+proyectos|proyectos|list\s+projects|show\s+(?:my\s+)?projects|my\s+projects)$/i;
  if (projectListPattern.test(clean)) {
    return { domain: 'project', action: 'list' };
  }

  // 2. Tasks scoped to a container or temporal scope
  const taskContainerPatterns = [
    // qu[eé]/cu[aá]les ... tareas ... en/de <container>
    /^(?:(?:qu[eé]|cu[aá]les)\s+(?:son\s+)?(?:las\s+|mis\s+)?tareas(?:\s+(?:que\s+tengo|tengo|hay))?)\s+(?:en|de|del proyecto|en el proyecto)\s+(.+)$/i,
    // (ver|mostrar|listar|dime) ... tareas ... en/de <container>
    /^(?:(?:ver|mostrar|listar|dime|ens[eñ]ame)\s+(?:las\s+|mis\s+)?tareas)\s+(?:en|de|del proyecto|en el proyecto)\s+(.+)$/i,
    // tareas en/de <container>
    /^tareas\s+(?:en|de|del proyecto|en el proyecto)\s+(.+)$/i,
    // english: "tasks in <container>", "show tasks in <container>", "tasks for <container>"
    /^(?:(?:show|list|view|what\s+are\s+my)\s+)?tasks\s+(?:in|for|of|from)\s+(.+)$/i,
  ];

  for (const pattern of taskContainerPatterns) {
    const match = clean.match(pattern);
    if (match && match[1]) {
      const rawTarget = match[1].trim();
      const normalizedTarget = rawTarget.toLowerCase();

      if (TEMPORAL_SCOPE_MAP.has(normalizedTarget)) {
        return {
          domain: 'task',
          action: 'list',
          scope: TEMPORAL_SCOPE_MAP.get(normalizedTarget),
        };
      }

      if (rawTarget) {
        return {
          domain: 'task',
          action: 'list',
          entityName: rawTarget,
          scope: 'all_pending',
        };
      }
    }
  }

  // 3. General tasks listing (all pending tasks)
  const generalTaskPatterns = [
    /^(?:qu[eé]|cu[aá]les)\s+(?:son\s+)?(?:las\s+|mis\s+)?tareas(?:\s+(?:que\s+tengo|tengo|hay))?(?:\s+pendientes)?$/i,
    /^(?:ver|mostrar|listar|dime|ens[eñ]ame)\s+(?:las\s+|mis\s+)?tareas(?:\s+pendientes)?$/i,
    /^(?:mis\s+tareas|tareas\s+pendientes|tareas)$/i,
    /^(?:qu[eé]|que)\s+(?:tengo|hay)\s+pendiente(?:s)?$/i,
    /^(?:show|list|view|what\s+are)\s+(?:my\s+)?(?:pending\s+)?tasks$/i,
  ];

  for (const pattern of generalTaskPatterns) {
    if (pattern.test(clean)) {
      return {
        domain: 'task',
        action: 'list',
        scope: 'all_pending',
      };
    }
  }

  return null;
}
