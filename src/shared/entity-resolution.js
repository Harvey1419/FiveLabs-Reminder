/**
 * Unified Entity Resolution & Text Normalization Engine
 *
 * Provides deterministic, multi-tenant, diacritic-agnostic, and wrapper-resilient
 * resolution for Tasks, Reminders, and Calendar items.
 */

export const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Strict UUID Validator.
 * Never uses length heuristic. Strictly validates UUID RFC 4122 format.
 *
 * @param {any} val
 * @returns {boolean}
 */
export function isStrictUUID(val) {
  if (!val || typeof val !== 'string') return false;
  return UUID_REGEX.test(val.trim());
}

/**
 * Universal text normalizer for diacritic-insensitive, punctuation-insensitive matching.
 * Handles:
 * - lowercase
 * - accents / diacritics (e.g. "diseñar" -> "disenar", "reunión" -> "reunion")
 * - smart quotes & brackets (« » “ ” ' " ` ~)
 * - punctuation (.,;:!?¡¿-_/\)
 * - multi-whitespace collapsing
 *
 * @param {string} str
 * @returns {string}
 */
export function normalizeTextForMatching(str) {
  if (!str || typeof str !== 'string') return '';
  return str
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // strip diacritics
    .replace(/[«»“”"'`~*#_~(){}\[\]]/g, '') // strip quotes/brackets
    .replace(/[.,;:!?¡¿\-_/\\]/g, ' ') // replace punctuation with spaces
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Strip conversational completion/action wrappers without modifying legitimate title words.
 * Handles:
 * - Leading prefixes: "Completar la tarea de...", "Ya hice la tarea...", "Marca como hecha...", "Recordatorio:..."
 * - Trailing suffixes: ": Ya lo hice", " - ya la hice", " ya quedó", " ya terminé esa", " listo", " hecho"
 *
 * @param {string} str
 * @returns {string}
 */
export function stripConversationalWrappers(str) {
  if (!str || typeof str !== 'string') return '';
  let s = str.trim();

  // Strip leading conversational prefixes
  s = s.replace(/^((?:por\s+favor\s+)?(?:completar|completa|completame|terminar|termina|marca|marcar|ya\s+hice|ya\s+hize|ya\s+complete|ya\s+completé|ya\s+termine|ya\s+terminé|hice|hize)\s+(?:la\s+|el\s+)?(?:tarea|recordatorio)?\s*(?:de\s+|para\s+|:\s*)?)+/i, '');

  // Strip type prefixes like "Tarea:", "Recordatorio:", "Task:", "Reminder:"
  s = s.replace(/^(?:tarea|recordatorio|task|reminder)\s*:\s*/i, '');

  // Strip trailing completion suffixes
  s = s.replace(/(?::|,|-)?\s*(?:ya\s+lo\s+hice|ya\s+la\s+hice|ya\s+se\s+hizo|lo\s+hice|la\s+hice|ya\s+está\s+hecho|ya\s+esta\s+hecho|ya\s+está\s+hecha|ya\s+esta\s+hecha|ya\s+está|ya\s+esta|ya\s+quedó|ya\s+quedo|ya\s+quedó\s+esa|ya\s+quedo\s+esa|ya\s+quedó\s+eso|ya\s+quedo\s+eso|esa\s+ya\s+quedó|esa\s+ya\s+quedo|eso\s+ya\s+quedó|eso\s+ya\s+quedo|ya\s+terminé\s+esa|ya\s+termine\s+esa|ya\s+terminé\s+eso|ya\s+termine\s+eso|ya\s+terminé|ya\s+termine|lo\s+terminé|lo\s+termine|la\s+terminé|la\s+termine|listo|ok|hecho|completado|completada|eso\s+ya\s+lo\s+hice|eso\s+ya\s+la\s+hice)\b.*$/i, '');

  // Strip residual surrounding punctuation & spaces
  s = s.replace(/^[:,\-–—\s]+|[:,\-–—\s]+$/g, '').trim();
  return s;
}

/**
 * Check if a reference string is a standalone affirmative completion phrase.
 * Strict check: must NOT match arbitrary sentences containing isolated common words like "el", "la", "ya".
 *
 * @param {string} str
 * @returns {boolean}
 */
export function isStandaloneAffirmative(str) {
  if (!str || typeof str !== 'string') return false;
  const clean = normalizeTextForMatching(str);
  if (!clean) return false;

  const standaloneAffirmatives = new Set([
    'listo', 'ok', 'hecho', 'ya', 'fui', 'ya fui', 'ya lo hice', 'lo hice',
    'ya la hice', 'la hice', 'ya esta', 'ya esta hecho', 'ya esta hecha',
    'ya quedo', 'ya quedo esa', 'ya quedo eso', 'esa ya quedo', 'eso ya quedo',
    'lo termine', 'la termine', 'ya termine', 'ya termine esa', 'ya termine eso',
    'completado', 'completada', 'si', 'correcto'
  ]);

  return standaloneAffirmatives.has(clean);
}

/**
 * Parse ordinal references from natural language.
 *
 * @param {string} str
 * @returns {number|null} 1-based position or -1 for last
 */
export function parseOrdinalReference(str) {
  if (!str || typeof str !== 'string') return null;
  const clean = normalizeTextForMatching(str).replace(/^#/, '').trim();

  const ordinalMap = {
    '1': 1, 'primero': 1, 'primera': 1, 'primer': 1, 'el 1': 1, 'el primero': 1, 'la primera': 1, 'opcion 1': 1, 'la 1': 1,
    '2': 2, 'segundo': 2, 'segunda': 2, 'el 2': 2, 'el segundo': 2, 'la segunda': 2, 'opcion 2': 2, 'la 2': 2,
    '3': 3, 'tercero': 3, 'tercera': 3, 'tercer': 3, 'el 3': 3, 'el tercero': 3, 'la tercera': 3, 'opcion 3': 3, 'la 3': 3,
    '4': 4, 'cuarto': 4, 'cuarta': 4, 'el 4': 4, 'el cuarto': 4, 'la cuarta': 4, 'opcion 4': 4, 'la 4': 4,
    '5': 5, 'quinto': 5, 'quinta': 5, 'el 5': 5, 'el quinto': 5, 'la quinta': 5, 'opcion 5': 5, 'la 5': 5,
  };

  if (ordinalMap[clean] !== undefined) {
    return ordinalMap[clean];
  }

  if (['ultimo', 'ultima', 'el ultimo', 'la ultima'].includes(clean)) {
    return -1; // special marker for last item
  }

  // Check matching ordinal patterns inside phrases (e.g. "el segundo recordatorio", "la segunda tarea", "la segunda ya la hice")
  if (/\b(?:el\s+|la\s+)?primer[oa]?\b|\b(?:el|la|opcion)\s+1\b/.test(clean)) return 1;
  if (/\b(?:el\s+|la\s+)?segund[oa]\b|\b(?:el|la|opcion)\s+2\b/.test(clean)) return 2;
  if (/\b(?:el\s+|la\s+)?tercer[oa]?\b|\b(?:el|la|opcion)\s+3\b/.test(clean)) return 3;
  if (/\b(?:el\s+|la\s+)?cuart[oa]\b|\b(?:el|la|opcion)\s+4\b/.test(clean)) return 4;
  if (/\b(?:el\s+|la\s+)?quint[oa]\b|\b(?:el|la|opcion)\s+5\b/.test(clean)) return 5;
  if (/\b(?:el\s+|la\s+)?ultim[oa]\b/.test(clean)) return -1;

  return null;
}

/**
 * Tokenize string for semantic token-overlap scoring.
 * Strips conversational filler and short non-meaningful words.
 *
 * @param {string} str
 * @returns {Array<string>}
 */
export function tokenizeText(str) {
  const norm = normalizeTextForMatching(str);
  if (!norm) return [];

  const STOPWORDS = new Set([
    'para', 'los', 'las', 'con', 'que', 'por', 'del', 'una', 'uno', 'este',
    'esta', 'ese', 'esa', 'mis', 'tus', 'les', 'nos', 'favor', 'como', 'sobre',
    'tarea', 'recordatorio', 'recordatorios', 'tareas'
  ]);

  return norm
    .split(/\s+/)
    .filter(w => w.length > 2 && !STOPWORDS.has(w));
}

/**
 * Calculate deterministic match score between query and candidate text.
 * Returns score between 0 and 1.
 *
 * @param {string} query
 * @param {string} candidate
 * @returns {number}
 */
export function calculateMatchScore(query, candidate) {
  const normQ = normalizeTextForMatching(query);
  const normC = normalizeTextForMatching(candidate);

  if (!normQ || !normC) return 0;
  if (normQ === normC) return 1.0;
  if (normC.includes(normQ)) return 0.95;
  if (normQ.includes(normC)) return 0.90;

  const qTokens = tokenizeText(normQ);
  const cTokens = tokenizeText(normC);
  if (qTokens.length === 0 || cTokens.length === 0) return 0;

  const matches = qTokens.filter(qt => cTokens.some(ct => ct.includes(qt) || qt.includes(ct)));
  const matchCount = matches.length;
  if (matchCount === 0) return 0;

  const coverage = matchCount / qTokens.length;
  const precision = matchCount / cTokens.length;
  const f1 = (2 * coverage * precision) / (coverage + precision);

  return Math.max(coverage * 0.8, f1);
}
