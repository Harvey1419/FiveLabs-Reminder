import { supabase } from '../../infrastructure/database/index.js';
import { selectEntityCandidate } from '../../infrastructure/database/entities.js';
import { resolveCalendarTemporalScope, formatLocalDateTime } from '../../shared/time.js';
import { parseTaskScope } from '../../shared/agenda-scopes.js';

const DEFAULT_TIMEZONE = 'America/Bogota';

async function resolveTaskContainer({ userId, entityId = null, entityName = null }) {
  if (entityId) return { id: entityId, name: entityName || null };
  if (!entityName) return { id: null, name: null };

  const [{ data: entitiesData, error }, { data: projectsData }] = await Promise.all([
    supabase.from('entities').select('id, name').eq('user_id', userId),
    supabase.from('projects').select('id, name').eq('user_id', userId).eq('status', 'active'),
  ]);

  if (error) throw error;
  const allContainers = [
    ...(entitiesData || []),
    ...(projectsData || []).map((p) => ({ id: p.id, name: p.name })),
  ];
  const uniqueContainers = Array.from(new Map(allContainers.map((c) => [c.id, c])).values());

  const selection = selectEntityCandidate(uniqueContainers, entityName);
  if (selection.status === 'AMBIGUOUS') {
    return { id: null, name: entityName, ambiguous: true, candidates: selection.candidates || [] };
  }
  if (selection.status !== 'RESOLVED') {
    return { id: null, name: entityName, unresolved: true };
  }
  return { id: selection.entity.id, name: selection.entity.name };
}

function normalizeSearchText(str) {
  return String(str || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();
}

function stemWord(word) {
  if (word.length > 4 && word.endsWith('es')) return word.slice(0, -2);
  if (word.length > 3 && word.endsWith('s')) return word.slice(0, -1);
  return word;
}

export function taskMatchesQuery(task, rawQuery) {
  const cleanQuery = String(rawQuery || '').trim();
  if (!cleanQuery) return true;

  const normalizedQuery = normalizeSearchText(cleanQuery);
  const title = task?.title || task?.content || '';
  const desc = task?.description || task?.notes || '';
  const taskText = normalizeSearchText(`${title} ${desc}`);

  if (taskText.includes(normalizedQuery) || taskText.includes(stemWord(normalizedQuery))) return true;

  const queryTokens = normalizedQuery.split(/\s+/).filter((t) => t.length > 1);
  if (queryTokens.length > 1 && queryTokens.every((tok) => taskText.includes(tok) || taskText.includes(stemWord(tok)))) {
    return true;
  }

  return false;
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
  query = null,
  limit = 50,
}) {
  const cleanQuery = typeof query === 'string' && query.trim() ? query.trim() : null;
  if (!userId) {
    return { tasks: [], items: [], entityName: entityName || null, query: cleanQuery, scope: 'all_pending', timezone, locale };
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
    return { tasks: [], items: [], entityName: entityName || null, query: cleanQuery, scope: parsedScope.runtimeScope, timezone: tz, locale };
  }

  let dbQuery = supabase
    .from('tasks')
    .select('*, entities:entity_id(id, name, category), projects:project_id(id, name, status)')
    .eq('user_id', userId);

  if (status && status !== 'all') dbQuery = dbQuery.eq('status', status);
  if (container.id) {
    if (typeof dbQuery.or === 'function') {
      dbQuery = dbQuery.or(`entity_id.eq.${container.id},project_id.eq.${container.id}`);
    } else {
      dbQuery = dbQuery.eq('entity_id', container.id);
    }
  }

  if (parsedScope.scope !== 'all_pending') {
    const temporal = resolveCalendarTemporalScope({
      scope: parsedScope.scope,
      ...(parsedScope.date ? { date: parsedScope.date } : {}),
    }, tz);
    const dateField = status === 'completed' ? 'completed_at' : 'due_date';
    dbQuery = dbQuery
      .gte(dateField, temporal.timeMin instanceof Date ? temporal.timeMin.toISOString() : String(temporal.timeMin))
      .lt(dateField, temporal.timeMax instanceof Date ? temporal.timeMax.toISOString() : String(temporal.timeMax));
  }

  if (status === 'completed') {
    dbQuery = dbQuery
      .order('completed_at', { ascending: false, nullsFirst: false })
      .order('created_at', { ascending: false });
  } else {
    dbQuery = dbQuery
      .order('due_date', { ascending: true, nullsFirst: false })
      .order('created_at', { ascending: false });
  }
  dbQuery = dbQuery.limit(Math.min(Math.max(1, Number(limit) || 50), 100));

  const { data, error } = await dbQuery;
  if (error) {
    console.error('[taskReadService] task read failed:', error.message);
    throw error;
  }

  const allTasks = (data || []).map((task) => {
    const dueDate = task.due_date || null;
    const relevantDate = status === 'completed' ? (task.completed_at || task.updated_at || dueDate) : dueDate;
    const resolvedEntityName = task.entities?.name || task.projects?.name || container.name || null;
    return {
      ...task,
      type: 'task',
      entityName: resolvedEntityName,
      dueDate,
      localTime: relevantDate
        ? new Intl.DateTimeFormat(language === 'en' ? 'en-US' : 'es-CO', {
          timeZone: tz,
          hour: 'numeric',
          minute: '2-digit',
          hour12: true,
        }).format(new Date(relevantDate))
        : null,
      localFormatted: relevantDate ? formatLocalDateTime(new Date(relevantDate), tz, locale) : null,
    };
  });

  const tasks = cleanQuery ? allTasks.filter((task) => taskMatchesQuery(task, cleanQuery)) : allTasks;

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
    status: status || 'pending',
    entityName: container.name || entityName || null,
    query: cleanQuery,
    scope: parsedScope.runtimeScope,
    timezone: tz,
    locale,
  };
}
