import { supabase } from '../../infrastructure/database/index.js';
import { selectEntityCandidate } from '../../infrastructure/database/entities.js';
import { resolveCalendarTemporalScope, formatLocalDateTime } from '../../shared/time.js';
import { parseTaskScope } from '../../shared/agenda-scopes.js';

/**
 * Read-only task query boundary.
 * Owns task inclusion/filter semantics; presentation is handled elsewhere.
 */
export async function readTasks({
  userId,
  entityName = null,
  status = 'pending',
  scope = 'all_pending',
  timezone = 'America/Bogota',
  locale = 'es-CO',
  limit = 50,
}) {
  if (!userId) return { tasks: [], items: [], entityName: null, scope: 'all_pending', timezone, locale };

  const safeLimit = Math.min(Math.max(1, Number(limit) || 50), 100);
  const parsedScope = parseTaskScope(scope, 'all_pending');
  let resolvedEntityName = null;
  let resolvedEntityId = null;

  if (entityName) {
    const { data: entities, error: entityError } = await supabase
      .from('entities')
      .select('id, name')
      .eq('user_id', userId);

    if (entityError) throw entityError;

    const selection = selectEntityCandidate(entities || [], String(entityName));
    if (selection.status === 'AMBIGUOUS') {
      return {
        ambiguous: true,
        candidates: selection.candidates || [],
        tasks: [],
        items: [],
        entityName: String(entityName),
        scope: parsedScope.runtimeScope,
        timezone,
        locale,
      };
    }
    if (selection.status === 'RESOLVED') {
      resolvedEntityId = selection.entity.id;
      resolvedEntityName = selection.entity.name;
    } else {
      return {
        tasks: [],
        items: [],
        entityName: String(entityName),
        scope: parsedScope.runtimeScope,
        timezone,
        locale,
      };
    }
  }

  let query = supabase
    .from('tasks')
    .select('*, entities:entity_id(id, name, category)')
    .eq('user_id', userId)
    .limit(safeLimit);

  if (status && status !== 'all') query = query.eq('status', status);
  if (resolvedEntityId) query = query.eq('entity_id', resolvedEntityId);

  if (parsedScope.scope !== 'all_pending') {
    const temporal = resolveCalendarTemporalScope({
      scope: parsedScope.scope,
      ...(parsedScope.date ? { date: parsedScope.date } : {}),
    }, timezone);
    query = query
      .gte('due_date', temporal.timeMin.toISOString())
      .lt('due_date', temporal.timeMax.toISOString());
  }

  query = query
    .order('due_date', { ascending: true, nullsFirst: false })
    .order('created_at', { ascending: false });

  const { data, error } = await query;
  if (error) throw error;

  const tasks = data || [];
  const items = tasks.map((task, index) => ({
    position: index + 1,
    type: 'task',
    internalId: task.id,
    summary: task.title || task.content,
    time: task.due_date
      ? formatLocalDateTime(new Date(task.due_date), timezone, locale)
      : null,
    source: 'task',
    entityName: task.entities?.name || null,
    raw: task,
  }));

  return {
    tasks,
    items,
    entityName: resolvedEntityName,
    scope: parsedScope.runtimeScope,
    timezone,
    locale,
  };
}
