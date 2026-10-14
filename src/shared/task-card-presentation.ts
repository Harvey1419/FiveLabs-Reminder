/** Existing domain DTO retained for presenter callers during the gradual migration. */
export interface CanonicalTaskItem {
  readonly id: string; readonly title: string | null; readonly description: string | null;
  readonly priority: string | null; readonly status: string | null;
  readonly dueDate: string | null; readonly entityName: string | null;
}
export interface TaskFormatContext {
  readonly language?: string; readonly timezone?: string;
  readonly isMultiDay?: boolean; readonly projectName?: string | null; readonly numbered?: boolean;
  readonly onTaskRendered?: ((row: unknown, fields: readonly string[]) => void) | null;
}
export interface TaskPresentationDependencies {
  formatHumanFriendlyDateTime(value: unknown, timezone?: string, language?: string): string;
}
/** Consumed host row projection only; validation and ownership remain upstream. */
function row(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' ? value as Record<string, unknown> : null;
}
/** Canonical task rendering is pure apart from the injected human date formatter. */
export function createTaskPresentation(dependencies: TaskPresentationDependencies) {
  const { formatHumanFriendlyDateTime } = dependencies;

  function getProjectName(task: unknown, language = 'es'): string {
    const fallback = language === 'en' ? 'No project' : 'Sin proyecto';
    const value = row(row(task)?.entities)?.name || row(task)?.entityName || row(task)?.projectName || null;
    return String(value || fallback).trim() || fallback;
  }

  function groupTasksByProject(tasks: unknown = [], language = 'es'): Map<string, unknown[]> {
    const groups = new Map<string, unknown[]>();
    for (const task of Array.isArray(tasks) ? tasks : []) {
      const project = getProjectName(task, language);
      if (!groups.has(project)) groups.set(project, []);
      groups.get(project)!.push(task);
    }
    return groups;
  }

  function getTaskTime(task: unknown, { timezone, language, isMultiDay }: TaskFormatContext): unknown {
    const dueDate = row(task)?.dueDate || row(task)?.due_date || null;
    if (isMultiDay && dueDate) {
      return formatHumanFriendlyDateTime(dueDate, timezone, language);
    }
    return row(task)?.localTime || null;
  }

  function countTaskNotes(task: unknown): number {
    const desc = row(task)?.description || row(task)?.notes || null;
    if (!desc || typeof desc !== 'string') return 0;
    const trimmed = desc.trim();
    if (!trimmed) return 0;
    const lines = trimmed.split('\n').map((l) => l.trim()).filter(Boolean);
    return lines.length > 0 ? lines.length : 1;
  }

  // Report only complete, unchanged field values at the actual render decision.
  // Humanized dates and normalized notes are deliberately not coverage proof.
  function fullyRenderedTaskFields(task: unknown, description: string, time: unknown): string[] {
    const fields = [];
    const value = row(task);
    if (typeof value?.description === 'string' && value.description.length > 0
      && value.description.length <= 400 && value.description === description
      && !description.includes('\n')) fields.push('description');
    if (typeof value?.due_date === 'string' && value.due_date === time) fields.push('due_date');
    return fields;
  }

  function formatTaskNotesBadge(task: unknown, isEnglish = false): string {
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
  function formatTaskProjectGroups(tasks: unknown = [], {
    language = 'es',
    timezone = 'UTC',
    isMultiDay = false,
    projectName = null,
    numbered = false,
    onTaskRendered = null,
  }: TaskFormatContext = {}): string {
    const safeTasks: unknown[] = Array.isArray(tasks) ? tasks : [];
    if (safeTasks.length === 0) return '';

    const groups = projectName
      ? new Map([[projectName, safeTasks]])
      : groupTasksByProject(safeTasks, language);

    let globalIndex = 1;
    return [...groups.entries()].map(([project, projectTasks]) => {
      const isUnscoped = project === (language === 'en' ? 'No project' : 'Sin proyecto');
      const projectIcon = isUnscoped ? '📌' : '📁';
      const lines = projectTasks.map((task) => {
        const title = row(task)?.title || row(task)?.content || (language === 'en' ? 'Untitled task' : 'Tarea sin título');
        const time = getTaskTime(task, { timezone, language, isMultiDay });
        const notesBadge = formatTaskNotesBadge(task, language === 'en');
        const prefix = numbered ? `${globalIndex++}.` : '•';
        const desc = String(row(task)?.description || row(task)?.notes || '').trim();
        const noteLine = desc ? `\n   ↳ 📝 _${desc.replace(/\n+/g, ' · ')}_` : '';
        onTaskRendered?.(task, fullyRenderedTaskFields(task, desc, time));
        return `${prefix} ${title}${time ? ` — ${time}` : ''}${notesBadge}${noteLine}`;
      });
      return `${projectIcon} *${project}*\n${lines.join('\n')}`;
    }).join('\n\n');
  }

  function normalizeTaskArray(data: unknown): readonly unknown[] {
    if (Array.isArray(data)) return data;
    if (Array.isArray(row(data)?.tasks)) return row(data)!.tasks as unknown[];
    if (data && typeof data === 'object') return [data];
    return [];
  }

  function formatCanonicalTaskCreate(data: unknown, {
    language = 'es',
    timezone = 'UTC',
  }: TaskFormatContext = {}): string {
    const tasks = normalizeTaskArray(data);
    if (tasks.length === 0) return language === 'en' ? '✅ *Task created*' : '✅ *Tarea creada*';
    const header = language === 'en'
      ? `✅ *${tasks.length === 1 ? 'Task created' : `${tasks.length} tasks created`}*`
      : `✅ *${tasks.length === 1 ? 'Tarea creada' : `${tasks.length} tareas creadas`}*`;
    const groups = formatTaskProjectGroups(tasks, {
      language,
      timezone,
      isMultiDay: true,
      numbered: tasks.length > 1,
    });
    return `${header}${groups ? `\n\n${groups}` : ''}`;
  }

  function formatCanonicalTaskComplete(data: unknown, {
    language = 'es',
    timezone = 'UTC',
  }: TaskFormatContext = {}): string {
    if (row(data)?.completedCount !== undefined) {
      const count = Number(row(data)?.completedCount || 0);
      const project = String(row(data)?.entityName || '').trim();
      const header = language === 'en'
        ? `✅ *${count === 1 ? '1 task completed' : `${count} tasks completed`}*`
        : `✅ *${count === 1 ? '1 tarea completada' : `${count} tareas completadas`}*`;
      if (!project) return header;
      return `${header}\n\n📁 *${project}*`;
    }

    const tasks = normalizeTaskArray(data);
    const task = tasks[0];
    if (!task) return language === 'en' ? '✅ *Task completed*' : '✅ *Tarea completada*';
    const header = row(data)?.alreadyCompleted === true
      ? (language === 'en' ? '✅ *Task already completed*' : '✅ *Tarea ya completada*')
      : (language === 'en' ? '✅ *Task completed*' : '✅ *Tarea completada*');
    const groups = formatTaskProjectGroups([task], { language, timezone, isMultiDay: false });
    return `${header}${groups ? `\n\n${groups}` : ''}`;
  }

  function formatCanonicalTaskUpdate(data: unknown, {
    language = 'es',
    timezone = 'UTC',
  }: TaskFormatContext = {}): string {
    const tasks = normalizeTaskArray(data);
    const task = tasks[0];
    if (!task) return language === 'en' ? '🔄 *Task updated*' : '🔄 *Tarea actualizada*';

    const header = language === 'en' ? '🔄 *Task updated*' : '🔄 *Tarea actualizada*';
    const groups = formatTaskProjectGroups([task], { language, timezone, isMultiDay: true });
    const priorityLabels: Record<string, string> = { low: 'baja', medium: 'media', high: 'alta', urgent: 'urgente' };
    const priority = row(task)?.priority && row(task)?.priority !== 'medium'
      ? `\n${language === 'en' ? '⚡ Priority' : '⚡ Prioridad'}: ${language === 'en' ? row(task)?.priority : (priorityLabels[String(row(task)?.priority)] || row(task)?.priority)}`
      : '';
    return `${header}${groups ? `\n\n${groups}` : ''}${priority}`;
  }

  function formatCanonicalTaskDelete(data: unknown, {
    language = 'es',
  }: TaskFormatContext = {}): string {
    const task = normalizeTaskArray(data)[0] || null;
    const header = language === 'en' ? '🗑️ *Task deleted*' : '🗑️ *Tarea eliminada*';
    const title = String(row(task)?.title || row(task)?.content || '').trim();
    return title ? `${header}\n\n• ${title}` : header;
  }

  return { groupTasksByProject, getTaskTime, countTaskNotes, fullyRenderedTaskFields, formatTaskNotesBadge, formatTaskProjectGroups, formatCanonicalTaskCreate, formatCanonicalTaskComplete, formatCanonicalTaskUpdate, formatCanonicalTaskDelete };
}
