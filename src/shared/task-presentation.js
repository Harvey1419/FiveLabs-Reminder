import { formatHumanFriendlyDateTime } from './time.js';

function getProjectName(task, language = 'es') {
  const fallback = language === 'en' ? 'No project' : 'Sin proyecto';
  const value = task?.entities?.name || task?.entityName || task?.projectName || null;
  return String(value || fallback).trim() || fallback;
}

export function groupTasksByProject(tasks = [], language = 'es') {
  const groups = new Map();
  for (const task of Array.isArray(tasks) ? tasks : []) {
    const project = getProjectName(task, language);
    if (!groups.has(project)) groups.set(project, []);
    groups.get(project).push(task);
  }
  return groups;
}

function getTaskTime(task, { timezone, language, isMultiDay }) {
  const dueDate = task?.dueDate || task?.due_date || null;
  if (isMultiDay && dueDate) {
    return formatHumanFriendlyDateTime(dueDate, timezone, language);
  }
  return task?.localTime || null;
}

export function countTaskNotes(task) {
  const desc = task?.description || task?.notes || null;
  if (!desc || typeof desc !== 'string') return 0;
  const trimmed = desc.trim();
  if (!trimmed) return 0;
  const lines = trimmed.split('\n').map((l) => l.trim()).filter(Boolean);
  return lines.length > 0 ? lines.length : 1;
}

export function formatTaskNotesBadge(task, isEnglish = false) {
  const count = countTaskNotes(task);
  if (count <= 0) return '';
  if (isEnglish) {
    return count === 1 ? ' 📝 _(1 note)_' : ` 📝 _(${count} notes)_`;
  }
  return count === 1 ? ' 📝 _(1 nota)_' : ` 📝 _(${count} notas)_`;
}

/**
 * Canonical WhatsApp presentation for task collections.
 * Hierarchy is always Project -> tasks. Identity metadata is never rendered as
 * a trailing project tag on each individual task.
 */
export function formatTaskProjectGroups(tasks = [], {
  language = 'es',
  timezone = 'UTC',
  isMultiDay = false,
  projectName = null,
} = {}) {
  const safeTasks = Array.isArray(tasks) ? tasks : [];
  if (safeTasks.length === 0) return '';

  const groups = projectName
    ? new Map([[projectName, safeTasks]])
    : groupTasksByProject(safeTasks, language);

  return [...groups.entries()].map(([project, projectTasks]) => {
    const isUnscoped = project === (language === 'en' ? 'No project' : 'Sin proyecto');
    const projectIcon = isUnscoped ? '📌' : '📁';
    const lines = projectTasks.map((task) => {
      const title = task?.title || task?.content || (language === 'en' ? 'Untitled task' : 'Tarea sin título');
      const time = getTaskTime(task, { timezone, language, isMultiDay });
      const notesBadge = formatTaskNotesBadge(task, language === 'en');
      return `• ${title}${time ? ` — ${time}` : ''}${notesBadge}`;
    });
    return `${projectIcon} *${project}*\n${lines.join('\n')}`;
  }).join('\n\n');
}

function normalizeTaskArray(data) {
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.tasks)) return data.tasks;
  if (data && typeof data === 'object') return [data];
  return [];
}

export function formatCanonicalTaskCreate(data, {
  language = 'es',
  timezone = 'UTC',
} = {}) {
  const tasks = normalizeTaskArray(data);
  if (tasks.length === 0) return language === 'en' ? '✅ *Task created*' : '✅ *Tarea creada*';
  const header = language === 'en'
    ? `✅ *${tasks.length === 1 ? 'Task created' : `${tasks.length} tasks created`}*`
    : `✅ *${tasks.length === 1 ? 'Tarea creada' : `${tasks.length} tareas creadas`}*`;
  const groups = formatTaskProjectGroups(tasks, { language, timezone, isMultiDay: true });
  return `${header}${groups ? `\n\n${groups}` : ''}`;
}

export function formatCanonicalTaskComplete(data, {
  language = 'es',
  timezone = 'UTC',
} = {}) {
  if (data?.completedCount !== undefined) {
    const count = Number(data.completedCount || 0);
    const project = String(data.entityName || '').trim();
    const header = language === 'en'
      ? `✅ *${count === 1 ? '1 task completed' : `${count} tasks completed`}*`
      : `✅ *${count === 1 ? '1 tarea completada' : `${count} tareas completadas`}*`;
    if (!project) return header;
    return `${header}\n\n📁 *${project}*`;
  }

  const tasks = normalizeTaskArray(data);
  const task = tasks[0];
  if (!task) return language === 'en' ? '✅ *Task completed*' : '✅ *Tarea completada*';
  const header = language === 'en' ? '✅ *Task completed*' : '✅ *Tarea completada*';
  const groups = formatTaskProjectGroups([task], { language, timezone, isMultiDay: false });
  return `${header}${groups ? `\n\n${groups}` : ''}`;
}

export function formatCanonicalTaskUpdate(data, {
  language = 'es',
  timezone = 'UTC',
} = {}) {
  const tasks = normalizeTaskArray(data);
  const task = tasks[0];
  if (!task) return language === 'en' ? '🔄 *Task updated*' : '🔄 *Tarea actualizada*';

  const header = language === 'en' ? '🔄 *Task updated*' : '🔄 *Tarea actualizada*';
  const groups = formatTaskProjectGroups([task], { language, timezone, isMultiDay: true });
  const priority = task?.priority && task.priority !== 'medium'
    ? `\n${language === 'en' ? '⚡ Priority' : '⚡ Prioridad'}: ${task.priority}`
    : '';
  return `${header}${groups ? `\n\n${groups}` : ''}${priority}`;
}

export function formatCanonicalTaskDelete(data, {
  language = 'es',
} = {}) {
  const task = normalizeTaskArray(data)[0] || null;
  const header = language === 'en' ? '🗑️ *Task deleted*' : '🗑️ *Tarea eliminada*';
  const title = String(task?.title || task?.content || '').trim();
  return title ? `${header}\n\n• ${title}` : header;
}
