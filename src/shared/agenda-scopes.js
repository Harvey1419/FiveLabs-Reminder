export const ALL_PENDING_SCOPE = 'all_pending';

export const AGENDA_SCOPES = Object.freeze([
  'today',
  'remaining_today',
  'tomorrow',
  'day_after_tomorrow',
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
  'sunday',
  'this_week',
  'next_week',
  'this_weekend',
  'upcoming',
  ALL_PENDING_SCOPE,
  'month',
  'full_year',
  'explicit_date',
  'explicit_range',
]);

export const TASK_SCOPES = Object.freeze([
  'today',
  'remaining_today',
  'tomorrow',
  'day_after_tomorrow',
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
  'sunday',
  'this_week',
  'next_week',
  'this_weekend',
  'upcoming',
  ALL_PENDING_SCOPE,
  'explicit_date',
  'explicit_range',
]);

const AGENDA_SCOPE_SET = new Set(AGENDA_SCOPES);
const TASK_SCOPE_SET = new Set(TASK_SCOPES);

const SCOPE_ALIASES = Object.freeze({
  all: ALL_PENDING_SCOPE,
  pending: ALL_PENDING_SCOPE,
  pendientes: ALL_PENDING_SCOPE,
  todos: ALL_PENDING_SCOPE,
  todos_los_pendientes: ALL_PENDING_SCOPE,
  rest_of_today: 'remaining_today',
  lo_que_queda_de_hoy: 'remaining_today',
  manana: 'tomorrow',
  'mañana': 'tomorrow',
  pasado_manana: 'day_after_tomorrow',
  'pasado_mañana': 'day_after_tomorrow',
  esta_semana: 'this_week',
  proxima_semana: 'next_week',
  este_fin_de_semana: 'this_weekend',
});

const EXPLICIT_TASK_DATE_RE = /^explicit_date@(\d{4}-\d{2}-\d{2})$/;

function normalizeRawScope(value) {
  return String(value || '').trim().toLowerCase().replace(/[\s-]+/g, '_');
}

/**
 * Normalize semantic agenda scope at the Node boundary. The model may express
 * harmless aliases, but every downstream layer receives one canonical value.
 */
export function normalizeAgendaScope(value, fallback = 'upcoming') {
  const raw = normalizeRawScope(value);
  if (!raw) return fallback;
  if (AGENDA_SCOPE_SET.has(raw)) return raw;
  return SCOPE_ALIASES[raw] || fallback;
}

/**
 * Task reads share the same temporal vocabulary as Unified Agenda. Runtime may
 * additionally carry an explicit local date as `explicit_date@YYYY-MM-DD` so
 * Node can preserve a model-provided date without inventing another field in
 * the public intent contract.
 */
export function normalizeTaskScope(value, fallback = ALL_PENDING_SCOPE) {
  const raw = normalizeRawScope(value);
  if (!raw) return fallback;
  if (EXPLICIT_TASK_DATE_RE.test(raw)) return raw;
  if (TASK_SCOPE_SET.has(raw)) return raw;
  const aliased = SCOPE_ALIASES[raw];
  return aliased && TASK_SCOPE_SET.has(aliased) ? aliased : fallback;
}

export function buildExplicitTaskDateScope(localDate) {
  const value = String(localDate || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  return `explicit_date@${value}`;
}

export function parseTaskScope(value, fallback = ALL_PENDING_SCOPE) {
  const normalized = normalizeTaskScope(value, fallback);
  const explicit = EXPLICIT_TASK_DATE_RE.exec(normalized);
  if (explicit) return { scope: 'explicit_date', date: explicit[1], runtimeScope: normalized };
  return { scope: normalized, date: null, runtimeScope: normalized };
}

export function isAllPendingScope(value) {
  return normalizeAgendaScope(value, null) === ALL_PENDING_SCOPE;
}

export function isAgendaScope(value) {
  return AGENDA_SCOPE_SET.has(normalizeRawScope(value));
}

export function isTaskScope(value) {
  const raw = normalizeRawScope(value);
  return TASK_SCOPE_SET.has(raw) || EXPLICIT_TASK_DATE_RE.test(raw);
}
