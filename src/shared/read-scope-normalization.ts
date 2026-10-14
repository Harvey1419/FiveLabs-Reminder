import { ALL_PENDING_SCOPE as typedALL_PENDING_SCOPE,AGENDA_SCOPES as typedAGENDA_SCOPES,TASK_SCOPES as typedTASK_SCOPES,REMINDER_SCOPES as typedREMINDER_SCOPES } from './agenda-scope-contract.js';
export const ALL_PENDING_SCOPE = typedALL_PENDING_SCOPE;
export const AGENDA_SCOPES = typedAGENDA_SCOPES;
export const TASK_SCOPES = typedTASK_SCOPES;
export const REMINDER_SCOPES = typedREMINDER_SCOPES;

const AGENDA_SCOPE_SET = new Set(AGENDA_SCOPES);
const TASK_SCOPE_SET = new Set(TASK_SCOPES);
const REMINDER_SCOPE_SET = new Set(REMINDER_SCOPES);

const SCOPE_ALIASES: Readonly<Record<string, string>> = Object.freeze({
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

export interface ParsedReadScope<Fallback = string> {
  scope: string | Fallback; date: string | null; runtimeScope: string | Fallback;
}
/** Alias lookup must never expose properties inherited from Object.prototype. */
function explicitAlias(key: string): string | undefined {
  return Object.hasOwn(SCOPE_ALIASES, key) ? SCOPE_ALIASES[key] : undefined;
}

const EXPLICIT_TASK_DATE_RE = /^explicit_date@(\d{4}-\d{2}-\d{2})$/;
const EXPLICIT_REMINDER_DATE_RE = /^explicit_date@(\d{4}-\d{2}-\d{2})$/;

function rawScopeText(value: unknown): string {
  return String(value || '').trim().toLowerCase();
}

function normalizeRawScope(value: unknown): string {
  return rawScopeText(value).replace(/[\s-]+/g, '_');
}

/**
 * Normalize semantic agenda scope at the Node boundary. The model may express
 * harmless aliases, but every downstream layer receives one canonical value.
 */
export function normalizeAgendaScope(value: unknown, fallback?: string): string;
export function normalizeAgendaScope(value: unknown, fallback: null): string | null;
export function normalizeAgendaScope(value: unknown, fallback: string | null): string | null;
export function normalizeAgendaScope(value: unknown, fallback: string | null = 'upcoming'): string | null {
  const raw = normalizeRawScope(value);
  if (!raw) return fallback;
  if (AGENDA_SCOPE_SET.has(raw)) return raw;
  return explicitAlias(raw) || fallback;
}

/**
 * Task reads share the same temporal vocabulary as Unified Agenda. Runtime may
 * additionally carry an explicit local date as `explicit_date@YYYY-MM-DD` so
 * Node can preserve a model-provided date without inventing another field in
 * the public intent contract.
 */
export function normalizeTaskScope(value: unknown, fallback?: string): string;
export function normalizeTaskScope(value: unknown, fallback: null): string | null;
export function normalizeTaskScope(value: unknown, fallback: string | null): string | null;
export function normalizeTaskScope(value: unknown, fallback: string | null = ALL_PENDING_SCOPE): string | null {
  const literal = rawScopeText(value);
  if (!literal) return fallback;
  if (EXPLICIT_TASK_DATE_RE.test(literal)) return literal;
  if (/^\d{4}-\d{2}-\d{2}$/.test(literal)) return `explicit_date@${literal}`;

  const raw = normalizeRawScope(literal);
  if (TASK_SCOPE_SET.has(raw)) return raw;
  const aliased = explicitAlias(raw);
  return aliased && TASK_SCOPE_SET.has(aliased) ? aliased : fallback;
}

export function buildExplicitTaskDateScope(localDate: unknown): string | null {
  const value = String(localDate || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  return `explicit_date@${value}`;
}

export function parseTaskScope(value: unknown, fallback?: string): ParsedReadScope;
export function parseTaskScope(value: unknown, fallback: null): ParsedReadScope<null>;
export function parseTaskScope(value: unknown, fallback: string | null): ParsedReadScope<null>;
export function parseTaskScope(value: unknown, fallback: string | null = ALL_PENDING_SCOPE): ParsedReadScope<string | null> {
  const normalized = normalizeTaskScope(value, fallback);
  const explicit = EXPLICIT_TASK_DATE_RE.exec(normalized ?? '');
  if (explicit) return { scope: 'explicit_date', date: explicit[1]!, runtimeScope: normalized };
  return { scope: normalized, date: null, runtimeScope: normalized };
}

export function isAllPendingScope(value: unknown): boolean {
  return normalizeAgendaScope(value, null) === ALL_PENDING_SCOPE;
}

export function isAgendaScope(value: unknown): boolean {
  return AGENDA_SCOPE_SET.has(normalizeRawScope(value));
}

export function isTaskScope(value: unknown): boolean {
  const literal = rawScopeText(value);
  if (EXPLICIT_TASK_DATE_RE.test(literal)) return true;
  return TASK_SCOPE_SET.has(normalizeRawScope(literal));
}

/**
 * Reminder reads share the same temporal vocabulary as Agenda and Tasks.
 * Supports lifecycle filters (completed_today, created_today, remaining_today)
 * and temporal scopes (today, tomorrow, day_after_tomorrow, weekdays, this_week, explicit_date).
 */
export function normalizeReminderScope(value: unknown, fallback?: string): string;
export function normalizeReminderScope(value: unknown, fallback: null): string | null;
export function normalizeReminderScope(value: unknown, fallback: string | null): string | null;
export function normalizeReminderScope(value: unknown, fallback: string | null = 'upcoming'): string | null {
  const literal = rawScopeText(value);
  if (!literal) return fallback;
  if (EXPLICIT_REMINDER_DATE_RE.test(literal)) return literal;
  if (/^\d{4}-\d{2}-\d{2}$/.test(literal)) return `explicit_date@${literal}`;

  const raw = normalizeRawScope(literal);
  if (REMINDER_SCOPE_SET.has(raw)) return raw;
  const aliased = explicitAlias(raw);
  if (aliased && REMINDER_SCOPE_SET.has(aliased)) return aliased;
  return fallback;
}

export function buildExplicitReminderDateScope(localDate: unknown): string | null {
  const value = String(localDate || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  return `explicit_date@${value}`;
}

export function parseReminderScope(value: unknown, fallback?: string): ParsedReadScope;
export function parseReminderScope(value: unknown, fallback: null): ParsedReadScope<null>;
export function parseReminderScope(value: unknown, fallback: string | null): ParsedReadScope<null>;
export function parseReminderScope(value: unknown, fallback: string | null = 'upcoming'): ParsedReadScope<string | null> {
  const normalized = normalizeReminderScope(value, fallback);
  const explicit = EXPLICIT_REMINDER_DATE_RE.exec(normalized ?? '');
  if (explicit) return { scope: 'explicit_date', date: explicit[1]!, runtimeScope: normalized };
  return { scope: normalized, date: null, runtimeScope: normalized };
}

export function isReminderScope(value: unknown): boolean {
  const literal = rawScopeText(value);
  if (EXPLICIT_REMINDER_DATE_RE.test(literal)) return true;
  return REMINDER_SCOPE_SET.has(normalizeRawScope(literal));
}

