import { supabase } from '../../infrastructure/database/index.js';
import { selectEntityCandidate } from '../../infrastructure/database/entities.js';
import { resolveCalendarTemporalScope, formatLocalDateTime } from '../../shared/time.js';
import { parseTaskScope } from '../../shared/agenda-scopes.js';

const DEFAULT_TIMEZONE = 'America/Bogota';

async function resolveTaskContainer({ userId, entityId = null, entityName = null }) {
  if (entityId) return { id: entityId, name: entityName || null };
  if (!entityName) return { id: null, name: null };

  const { data, error } = await supabase
    .from('entities')
    .select('id, name')
    .eq('user_id', userId);

  if (error) throw error;
  const selection = selectEntityCandidate(data || [], entityName);
  if (selection.status === 'AMBIGUOUS') {
    return { id: null, name: entityName, ambiguous: true, candidates: selection.candidates || [] };
  }
  if (selection.status !== 'RESOLVED') {
    return { id: null, name: entityName, unresolved: true };
  }
  return { id: selection.entity.id, name: selection.entity.name };
}

/**
 * Canonical read model for task collections. It owns task inclusion semantics
 * (status, project and temporal scope) and returns structured data only.
 */
export async function getTaskList({
  userId,
  timezone = DEFAULT_TIMEZONE,
  locale = 'es-CO',
  language = 'es',
  status = 'pending',
  scope = 'all_pending',
  entityId = null,
  entityName = null,
  limit = 50,
}) {
  if (!userId) {
    return { tasks: [], items: [], entityName: entityName || null, scope: 'all_pending', timezone, locale };
  }

  const tz = timezone || DEFAULT_TIMEZONE;
  const parsedScope = parseTaskScope(scope, 'all_pending');
  const container = await resolveTaskContainer({ userId, entityId, entityName });

  if (container.ambiguous) {
    return {
      ambiguous: true,
      candidates: container.candidates,
      tasks: [],
      items: [],
      entityName: entityName || null,
      scope: parsedScope.runtimeScope,
      timezone: tz,
      locale,
    };
  }

  if (container.unresolved) {
    return { tasks: [], items: [], entityName: entityName || null, scope: parsedScope.runtimeScope, timezone: tz, locale };
  }

  let query = supabase
    .from('tasks')
    .select('*, entities:entity_id(id, name, category)')
    .eq('user_id', userId);

  if (status && status !== 'all') query = query.eq('status', status);
  if (container.id) query = query.eq('entity_id', container.id);

  if (parsedScope.scope !== 'all_pending') {
    const temporal = resolveCalendarTemporalScope({
      scope: parsedScope.scope,
      ...(parsedScope.date ? { date: parsedScope.date } : {}),
    }, tz);
    query = query
      .gte('due_date', temporal.timeMin instanceof Date ? temporal.timeMin.toISOString() : String(temporal.timeMin))
      .lt('due_date', temporal.timeMax instanceof Date ? temporal.timeMax.toISOString() : String(temporal.timeMax));
  }

  query = query
    .order('due_date', { ascending: true, nullsFirst: false })
    .order('created_at', { ascending: false })
    .limit(Math.min(Math.max(1, Number(limit) || 50), 100));

  const { data, error } = await query;
  if (error) {
    console.error('[taskReadService] task read failed:', error.message);
    throw error;
  }

  const tasks = (data || []).map((task) => {
    const dueDate = task.due_date || null;
    return {
      ...task,
      type: 'task',
      entityName: task.entities?.name || container.name || null,
      dueDate,
      localTime: dueDate
        ? new Intl.DateTimeFormat(language === 'en' ? 'en-US' : 'es-CO', {
          timeZone: tz,
          hour: 'numeric',
          minute: '2-digit',
          hour12: true,
        }).format(new Date(dueDate))
        : null,
      localFormatted: dueDate ? formatLocalDateTime(new Date(dueDate), tz, locale) : null,
    };
  });

  const items = tasks.map((task, index) => ({
    position: index + 1,
    type: 'task',
    internalId: task.id,
    summary: task.title || task.content,
    time: task.localTime,
    source: 'task',
    entityName: task.entityName || null,
    raw: task,
  }));

  return {
    tasks,
    items,
    entityName: container.name || entityName || null,
    scope: parsedScope.runtimeScope,
    timezone: tz,
    locale,
  };
}
