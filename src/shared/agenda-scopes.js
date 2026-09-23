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

export const REMINDER_SCOPES = Object.freeze([
  'today',
  'pending_today',
  'remaining_today',
  'completed_today',
  'created_today',
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
const REMINDER_SCOPE_SET = new Set(REMINDER_SCOPES);

const SCOPE_ALIASES = Object.freeze({
  all: ALL_PENDING_SCOPE,
  pending: ALL_PENDING_SCOPE,
  pendientes: ALL_PENDING_SCOPE,
  todos: ALL_PENDING_SCOPE,
  todos_los_pendientes: ALL_PENDING_SCOPE,
  hoy: 'today',
  rest_of_today: 'remaining_today',
  lo_que_queda_de_hoy: 'remaining_today',
  pending_remaining_today: 'remaining_today',
  completados_hoy: 'completed_today',
  creados_hoy: 'created_today',
  manana: 'tomorrow',
  'mañana': 'tomorrow',
  pasado_manana: 'day_after_tomorrow',
  'pasado_mañana': 'day_after_tomorrow',
  esta_semana: 'this_week',
  proxima_semana: 'next_week',
  este_fin_de_semana: 'this_weekend',
  lunes: 'monday',
  martes: 'tuesday',
  miercoles: 'wednesday',
  'miércoles': 'wednesday',
  jueves: 'thursday',
  viernes: 'friday',
  sabado: 'saturday',
  'sábado': 'saturday',
  domingo: 'sunday',
});

const EXPLICIT_TASK_DATE_RE = /^explicit_date@(\d{4}-\d{2}-\d{2})$/;
const EXPLICIT_REMINDER_DATE_RE = /^explicit_date@(\d{4}-\d{2}-\d{2})$/;

function rawScopeText(value) {
  return String(value || '').trim().toLowerCase();
}

function normalizeRawScope(value) {
  return rawScopeText(value).replace(/[\s-]+/g, '_');
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
  const literal = rawScopeText(value);
  if (!literal) return fallback;
  if (EXPLICIT_TASK_DATE_RE.test(literal)) return literal;
  if (/^\d{4}-\d{2}-\d{2}$/.test(literal)) return `explicit_date@${literal}`;

  const raw = normalizeRawScope(literal);
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
  const literal = rawScopeText(value);
  if (EXPLICIT_TASK_DATE_RE.test(literal)) return true;
  return TASK_SCOPE_SET.has(normalizeRawScope(literal));
}

/**
 * Reminder reads share the same temporal vocabulary as Agenda and Tasks.
 * Supports lifecycle filters (completed_today, created_today, remaining_today)
 * and temporal scopes (today, tomorrow, day_after_tomorrow, weekdays, this_week, explicit_date).
 */
export function normalizeReminderScope(value, fallback = 'upcoming') {
  const literal = rawScopeText(value);
  if (!literal) return fallback;
  if (EXPLICIT_REMINDER_DATE_RE.test(literal)) return literal;
  if (/^\d{4}-\d{2}-\d{2}$/.test(literal)) return `explicit_date@${literal}`;

  const raw = normalizeRawScope(literal);
  if (REMINDER_SCOPE_SET.has(raw)) return raw;
  const aliased = SCOPE_ALIASES[raw];
  if (aliased && REMINDER_SCOPE_SET.has(aliased)) return aliased;
  return fallback;
}

export function buildExplicitReminderDateScope(localDate) {
  const value = String(localDate || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  return `explicit_date@${value}`;
}

export function parseReminderScope(value, fallback = 'upcoming') {
  const normalized = normalizeReminderScope(value, fallback);
  const explicit = EXPLICIT_REMINDER_DATE_RE.exec(normalized);
  if (explicit) return { scope: 'explicit_date', date: explicit[1], runtimeScope: normalized };
  return { scope: normalized, date: null, runtimeScope: normalized };
}

export function isReminderScope(value) {
  const literal = rawScopeText(value);
  if (EXPLICIT_REMINDER_DATE_RE.test(literal)) return true;
  return REMINDER_SCOPE_SET.has(normalizeRawScope(literal));
}

