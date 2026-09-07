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
  'all_pending',
  'month',
  'full_year',
  'explicit_date',
  'explicit_range',
]);

const AGENDA_SCOPE_SET = new Set(AGENDA_SCOPES);

const AGENDA_SCOPE_ALIASES = Object.freeze({
  all: 'all_pending',
  pending: 'all_pending',
  pendientes: 'all_pending',
  todos: 'all_pending',
  todos_los_pendientes: 'all_pending',
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

/**
 * Normalize semantic agenda scope at the Node boundary. The model may express
 * harmless aliases, but every downstream layer receives one canonical value.
 */
export function normalizeAgendaScope(value, fallback = 'upcoming') {
  const raw = String(value || '').trim().toLowerCase().replace(/[\s-]+/g, '_');
  if (!raw) return fallback;
  if (AGENDA_SCOPE_SET.has(raw)) return raw;
  return AGENDA_SCOPE_ALIASES[raw] || fallback;
}

export function isAgendaScope(value) {
  return AGENDA_SCOPE_SET.has(String(value || '').trim().toLowerCase());
}
