/**
 * Deterministic interceptor for task, project, calendar, reminder, and agenda inventory queries.
 *
 * When an LLM interprets an inventory query (e.g. "qué tengo para mañana" or "qué tareas tengo en reminder")
 * as conversational commentary (domain: 'conversation', action: 'reply'), it bypasses
 * database queries and hallucinates stale items from conversation history.
 *
 * This interceptor guarantees that explicit requests to view or list agenda, tasks,
 * projects, calendar events, or reminders are deterministically executed against
 * authoritative storage and live provider APIs.
 */

const TEMPORAL_SCOPE_MAP = new Map([
  ['hoy', 'today'],
  ['today', 'today'],
  ['mañana', 'tomorrow'],
  ['manana', 'tomorrow'],
  ['tomorrow', 'tomorrow'],
  ['pasado mañana', 'day_after_tomorrow'],
  ['pasado manana', 'day_after_tomorrow'],
  ['day after tomorrow', 'day_after_tomorrow'],
  ['esta semana', 'this_week'],
  ['this week', 'this_week'],
  ['proxima semana', 'next_week'],
  ['próxima semana', 'next_week'],
  ['next week', 'next_week'],
  ['este fin de semana', 'this_weekend'],
  ['fin de semana', 'this_weekend'],
  ['this weekend', 'this_weekend'],
  ['weekend', 'this_weekend'],
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
 * Strips conversational pleasantries and filler prefixes (e.g. "Oye", "Porfa", "Hermes", "Súper").
 */
export function stripConversationalPrefix(text) {
  if (!text || typeof text !== 'string') return '';
  return text
    .replace(/^(?:(?:oye|hola|buenas|hey|hi|hello|hermes|por\s*fa(?:vor)?|dime|favor|ok|vale|s[uú]per|genial|perfecto|listo|gracias)\b[\s,.:;!¡¿?]*)+/i, '')
    .trim();
}

export function resolveTemporalScope(target, defaultScope = 'all_pending') {
  if (!target) return defaultScope;
  const normalized = target.toLowerCase().trim();
  return TEMPORAL_SCOPE_MAP.get(normalized) || defaultScope;
}

/**
 * Inspects user text to detect explicit task, project, calendar, reminder, or agenda inventory queries.
 * Returns an operational action object if detected, or null to allow normal routing.
 *
 * @param {string} rawText
 * @returns {{ domain: string, action: string, entityName?: string, scope?: string, status?: string } | null}
 */
export function detectInventoryQuery(rawText) {
  const text = sanitizeUserQueryText(rawText);
  if (!text) return null;

  // Clean trailing punctuation (?, !, .) and conversational prefixes
  const unpunctuated = text.replace(/[?.!]+$/, '').trim();
  const clean = stripConversationalPrefix(unpunctuated);
  if (!clean) return null;

  // 1. Completed tasks query (daily wrap-up)
  const completedTaskPattern = /^(?:(?:qu[eé]|cu[aá]les)\s+(?:tareas\s+)?complet[eé]\s+hoy|qu[eé]\s+hice\s+hoy|(?:ver|mostrar|listar|dime|ens[eñ]ame)\s+(?:las\s+)?tareas\s+completadas(?:\s+hoy)?|tareas\s+completadas(?:\s+hoy)?|lo\s+que\s+complet[eé]\s+hoy|what\s+did\s+i\s+(?:complete|finish|do)\s+today|completed\s+tasks(?:\s+today)?|show\s+(?:my\s+)?completed\s+tasks(?:\s+today)?)$/i;
  if (completedTaskPattern.test(clean)) {
    return {
      domain: 'task',
      action: 'list',
      status: 'completed',
      scope: 'today',
    };
  }

  // 2. Projects listing
  const projectListPattern = /^(?:(?:qu[eé]|cu[aá]les)\s+(?:son\s+)?(?:mis\s+)?proyectos(?:\s+(?:que\s+tengo|tengo|hay))?|(?:ver|mostrar|listar|dime|ens[eñ]ame)\s+(?:mis\s+)?proyectos|mis\s+proyectos|proyectos|list\s+projects|show\s+(?:my\s+)?projects|my\s+projects)$/i;
  if (projectListPattern.test(clean)) {
    return { domain: 'project', action: 'list' };
  }

  // 3. Calendar-specific queries
  const calPattern = /^(?:(?:qu[eé]|cu[aá]les)\s+(?:son\s+)?(?:las\s+|mis\s+)?(?:reuniones|eventos|citas)(?:\s+(?:que\s+tengo|tengo|hay))?|(?:ver|mostrar|listar|revisa(?:r)?|consulta(?:r)?|ens[eñ]ame)\s+(?:mi\s+)?calendario|(?:qu[eé]\s+tengo\s+en\s+(?:mi\s+)?calendario)|(?:mis\s+)?(?:reuniones|eventos|citas)|(?:mi\s+)?calendario|(?:what\s+meetings(?:\s+do\s+i\s+have)?|check(?:\s+my)?\s+calendar|show(?:\s+my)?\s+calendar|my\s+calendar|calendar))(?:\s+(?:para\s+|de\s+|en\s+|for\s+)?(hoy|mañana|manana|pasado\s+mañana|pasado\s+manana|esta\s+semana|la\s+pr[oó]xima\s+semana|pr[oó]xima\s+semana|el\s+fin\s+de\s+semana|fin\s+de\s+semana|today|tomorrow|this\s+week|next\s+week|this\s+weekend))?$/i;
  const calMatch = clean.match(calPattern);
  if (calMatch) {
    return {
      domain: 'calendar',
      action: 'list',
      scope: resolveTemporalScope(calMatch[1]),
    };
  }

  // 4. Reminder-specific queries
  const remPattern = /^(?:(?:qu[eé]|cu[aá]les)\s+(?:son\s+)?(?:los\s+|mis\s+)?recordatorios(?:\s+(?:que\s+tengo|tengo|hay))?|(?:ver|mostrar|listar|revisa(?:r)?|consulta(?:r)?|ens[eñ]ame)\s+(?:mis\s+)?recordatorios|(?:mis\s+)?recordatorios|(?:what\s+reminders(?:\s+do\s+i\s+have)?|show(?:\s+my)?\s+reminders|my\s+reminders|reminders))(?:\s+(?:para\s+|de\s+|en\s+|for\s+)?(hoy|mañana|manana|pasado\s+mañana|pasado\s+manana|esta\s+semana|la\s+pr[oó]xima\s+semana|pr[oó]xima\s+semana|el\s+fin\s+de\s+semana|fin\s+de\s+semana|today|tomorrow|this\s+week|next\s+week|this\s+weekend))?$/i;
  const remMatch = clean.match(remPattern);
  if (remMatch) {
    return {
      domain: 'reminder',
      action: 'list',
      scope: resolveTemporalScope(remMatch[1]),
    };
  }

  // 5. Unified agenda queries (e.g. "qué tengo para mañana", "cuál es mi agenda", "qué hay hoy")
  const agendaPattern = /^(?:(?:qu[eé]\s+(?:es\s+lo\s+que\s+)?tengo(?:\s+(?:agendado|planeado|programado))?|qu[eé]\s+hay|cu[aá]l\s+es\s+mi\s+agenda|c[oó]mo\s+viene\s+mi\s+d[ií]a|c[oó]mo\s+est[aá]\s+mi\s+agenda|mi\s+agenda|agenda|ver\s+agenda|revisar\s+agenda|revisa\s+mi\s+agenda)(?:\s+(?:para\s+|de\s+|en\s+)?(hoy|mañana|manana|pasado\s+mañana|pasado\s+manana|esta\s+semana|la\s+pr[oó]xima\s+semana|pr[oó]xima\s+semana|el\s+fin\s+de\s+semana|fin\s+de\s+semana))?|(?:what(?:\s+do\s+i|\s+is)?\s+have(?:\s+scheduled|\s+planned)?|what'?s\s+(?:on\s+my\s+(?:agenda|schedule)|up)|what\s+is\s+my\s+agenda|show(?:\s+me)?\s+my\s+agenda|my\s+agenda|schedule)(?:\s+(?:for\s+)?(today|tomorrow|the\s+day\s+after\s+tomorrow|this\s+week|next\s+week|this\s+weekend))?)$/i;
  const agendaMatch = clean.match(agendaPattern);
  if (agendaMatch) {
    return {
      domain: 'agenda',
      action: 'read',
      scope: resolveTemporalScope(agendaMatch[1] || agendaMatch[2]),
    };
  }

  // 6. Tasks scoped to a container or temporal scope
  const taskContainerPatterns = [
    // qu[eé]/cu[aá]les ... tareas ... en/de <container>
    /^(?:(?:qu[eé]|cu[aá]les)\s+(?:son\s+)?(?:las\s+|mis\s+)?tareas(?:\s+(?:que\s+tengo|tengo|hay))?)\s+(?:en|de|del proyecto|en el proyecto|para)\s+(.+)$/i,
    // (ver|mostrar|listar|dime) ... tareas ... en/de <container>
    /^(?:(?:ver|mostrar|listar|dime|ens[eñ]ame)\s+(?:las\s+|mis\s+)?tareas)\s+(?:en|de|del proyecto|en el proyecto|para)\s+(.+)$/i,
    // tareas en/de <container>
    /^tareas\s+(?:en|de|del proyecto|en el proyecto|para)\s+(.+)$/i,
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

  // 7. General tasks listing (all pending tasks)
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
