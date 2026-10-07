/**
 * Language detection and locale synchronization for Hermes TempleLabs.
 *
 * Ground truth principle: The language the user actually speaks in chat is the
 * authoritative source of truth, regardless of their phone number country code.
 */

const SPANISH_INVERTED_PUNCTUATION_RE = /[¿¡]/;
const SPANISH_SPECIAL_CHARS_RE = /[ñÑáéíóúÁÉÍÓÚ]/;

export const EXPLICIT_SPANISH_DIRECTIVE_RE = /^(?:habla(?:me)? en (?:español|castellano)|en español(?: por favor| porfa)?|speak in spanish|cambia(?:r)? mi idioma a español)/i;
export const EXPLICIT_ENGLISH_DIRECTIVE_RE = /^(?:speak in english|in english(?: please)?|habla(?:me)? en ingl[eé]s|cambia(?:r)? mi idioma a ingl[eé]s)/i;

const SPANISH_TOKENS = new Set([
  'hola', 'buen', 'bueno', 'buenos', 'buenas', 'dia', 'dias', 'días', 'tarde', 'tardes', 'noche', 'noches',
  'que', 'qué', 'quien', 'quién', 'como', 'cómo', 'donde', 'dónde', 'cuando', 'cuándo', 'por', 'para', 'con',
  'de', 'del', 'en', 'un', 'una', 'unos', 'unas', 'el', 'la', 'los', 'las', 'lo', 'al', 'es', 'son', 'fue', 'era',
  'soy', 'eres', 'somos', 'estoy', 'estas', 'estás', 'esta', 'está', 'estamos', 'estan', 'están',
  'tu', 'tú', 'te', 'ti', 'mi', 'mí', 'mis', 'me', 'nos', 'le', 'les', 'su', 'sus',
  'usted', 'ustedes', 'hacer', 'hace', 'hago', 'hizo', 'tener', 'tengo', 'tiene', 'tienen',
  'gracias', 'favor', 'porfa', 'porfavor', 'pero', 'porque', 'si', 'sí', 'no', 'ya', 'muy', 'mas', 'más',
  'tambien', 'también', 'nada', 'todo', 'todos', 'todas', 'recordar', 'recuerdame', 'recuérdame',
  'tarea', 'tareas', 'pendiente', 'pendientes', 'cita', 'citas', 'reunion', 'reunión',
  'hoy', 'mañana', 'ayer', 'semana', 'mes', 'año', 'bien', 'mal', 'listo', 'lista', 'deuda', 'devolver',
  'agregar', 'agrega', 'agregale', 'agrégale', 'quien', 'inventó', 'invento', 'creó', 'creo', 'sabes',
]);

const ENGLISH_TOKENS = new Set([
  'hello', 'hi', 'hey', 'what', 'whats', "what's", 'who', 'how', 'when', 'where', 'why',
  'for', 'with', 'from', 'of', 'in', 'on', 'at', 'to', 'a', 'an', 'the',
  'is', 'are', 'was', 'were', 'am', 'be', 'been', 'being', 'have', 'has', 'had', 'do', 'does', 'did',
  'you', 'your', 'yours', 'me', 'my', 'mine', 'we', 'our', 'ours', 'us', 'they', 'them', 'their', 'theirs',
  'he', 'him', 'his', 'she', 'her', 'hers', 'it', 'its',
  'good', 'morning', 'afternoon', 'evening', 'night', 'thanks', 'thank', 'please', 'pls',
  'but', 'because', 'yes', 'yeah', 'yep', 'no', 'nope', 'already', 'very', 'more', 'also',
  'nothing', 'everything', 'all', 'remind', 'reminder', 'task', 'tasks', 'todo', 'todos',
  'meeting', 'appointment', 'today', 'tomorrow', 'yesterday', 'week', 'month', 'year', 'well', 'bad',
  'done', 'finish', 'create', 'update', 'delete', 'cancel',
]);

/**
 * Detect language ('es' vs 'en') from conversational message text.
 * Returns null if the text is language-neutral, purely numeric, or indeterminate.
 *
 * @param {string} text
 * @returns {'es' | 'en' | null}
 */
export function detectLanguageFromText(text) {
  if (!text || typeof text !== 'string') return null;
  const trimmed = text.trim();
  if (!trimmed) return null;

  // 1. Explicit language directive commands have top priority
  if (EXPLICIT_SPANISH_DIRECTIVE_RE.test(trimmed)) return 'es';
  if (EXPLICIT_ENGLISH_DIRECTIVE_RE.test(trimmed)) return 'en';

  // 2. Clear Spanish orthographical markers
  if (SPANISH_INVERTED_PUNCTUATION_RE.test(trimmed)) return 'es';

  // Strip URLs and formatting characters
  const clean = trimmed
    .replace(/https?:\/\/\S+/gi, '')
    .replace(/[*_~`]/g, ' ')
    .toLowerCase();

  const words = clean
    .split(/[\s,.;:!?()[\]{}"'\\/]+/)
    .map((w) => w.trim())
    .filter((w) => w.length > 0);

  if (words.length === 0) return null;

  let esScore = 0;
  let enScore = 0;

  for (const word of words) {
    if (SPANISH_TOKENS.has(word)) esScore += 1;
    if (ENGLISH_TOKENS.has(word)) enScore += 1;
    // Specific accented Spanish tokens that are unequivocal
    if (SPANISH_SPECIAL_CHARS_RE.test(word) && !ENGLISH_TOKENS.has(word)) {
      esScore += 1.5;
    }
  }

  if (esScore === 0 && enScore === 0) return null;

  if (esScore > enScore) return 'es';
  if (enScore > esScore) return 'en';

  return null;
}
