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
      return `• ${title}${time ? ` — ${time}` : ''}`;
    });
    return `${projectIcon} *${project}*\n${lines.join('\n')}`;
  }).join('\n\n');
}
