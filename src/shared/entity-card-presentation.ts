export interface EntityFormatContext { readonly language?: string; readonly category?: unknown }
/** Consumed host view projection; current ownership and effect certainty remain upstream. */
function row(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' ? value as Record<string, unknown> : null;
}
function rows(value: unknown): readonly unknown[] { return Array.isArray(value) ? value : []; }

function categoryLabels(language: string): Record<string, string> & { other: string } {
  return language === 'en'
    ? { person: 'person', company: 'company', project: 'project', place: 'place', pet: 'pet', asset: 'asset', other: 'other' }
    : { person: 'persona', company: 'empresa', project: 'proyecto', place: 'lugar', pet: 'mascota', asset: 'activo', other: 'otro' };
}

export function formatCanonicalEntityCreate(entity: unknown, { language = 'es' }: EntityFormatContext = {}): string {
  const name = row(entity)?.name || (language === 'en' ? 'Unnamed' : 'Sin nombre');
  const category = row(entity)?.category || 'other';
  return language === 'en'
    ? `📁 *Project / entity registered*\n\n• *${name}* — ${category}`
    : `📁 *Proyecto / entidad registrada*\n\n• *${name}* — ${categoryLabels(language)[String(category)] || categoryLabels(language).other}`;
}

export function formatCanonicalEntityRename(data: unknown, params: unknown = {}, { language = 'es' }: EntityFormatContext = {}): string {
  const oldName = row(params)?.oldName || row(data)?.oldName || row(data)?.sourceName || '';
  const newName = row(params)?.newName || row(data)?.newName || row(data)?.name || '';
  if (language === 'en') return `✏️ *Project renamed*\n\n${oldName ? `• ${oldName} → ` : '• '}${newName || 'Updated'}`;
  return `✏️ *Proyecto renombrado*\n\n${oldName ? `• ${oldName} → ` : '• '}${newName || 'Actualizado'}`;
}

export function formatCanonicalEntityMerge(data: unknown, params: unknown = {}, { language = 'es' }: EntityFormatContext = {}): string {
  const sourceName = row(params)?.sourceName || row(data)?.sourceName || '';
  const targetName = row(params)?.targetName || row(data)?.targetName || '';
  const count = Number(row(data)?.tasksMovedCount || 0);
  const header = language === 'en' ? '🔀 *Entities merged*' : '🔀 *Fusión completada*';
  const target = [sourceName, targetName].filter(Boolean).join(' → ');
  const moved = language === 'en'
    ? `${count} task${count === 1 ? '' : 's'} moved`
    : `${count} ${count === 1 ? 'tarea migrada' : 'tareas migradas'}`;
  return `${header}${target ? `\n\n• ${target}` : ''}\n${moved}`;
}

export function formatCanonicalEntityDeduplicate(data: unknown, { language = 'es' }: EntityFormatContext = {}): string {
  const count = Number(row(data)?.mergedCount || 0);
  return language === 'en'
    ? `🧹 *Deduplication complete*\n\n${count} redundant ${count === 1 ? 'entity was' : 'entities were'} merged.`
    : `🧹 *Limpieza completada*\n\nSe ${count === 1 ? 'fusionó' : 'fusionaron'} ${count} ${count === 1 ? 'entidad redundante' : 'entidades redundantes'}.`;
}

export function formatCanonicalEntityList(entities: unknown = [], {
  category = null,
  language = 'es',
}: EntityFormatContext = {}): string {
  const safeEntities = rows(entities);
  const isProjectList = category === 'project';

  if (safeEntities.length === 0) {
    if (language === 'en') {
      return isProjectList
        ? '📁 *Projects*\n\nYou have no registered projects.'
        : '🗂️ *Registered entities*\n\nYou have no registered entities.';
    }
    return isProjectList
      ? '📁 *Proyectos*\n\nNo tienes proyectos registrados.'
      : '🗂️ *Entidades registradas*\n\nNo tienes entidades registradas.';
  }

  const isEn = language === 'en';
  const labels = categoryLabels(language);
  const header = isEn
    ? (isProjectList ? '📁 *Your projects*' : '🗂️ *Your registered entities*')
    : (isProjectList ? '📁 *Tus proyectos*' : '🗂️ *Tus entidades registradas*');

  if (isProjectList) {
    let globalIndex = 1;
    const lines = safeEntities.map((entity) => {
      const name = row(entity)?.name || (isEn ? 'Unnamed' : 'Sin nombre');
      const hasCount = row(entity)?.taskCount !== undefined || row(entity)?.pendingTaskCount !== undefined;
      let badge = '';
      if (hasCount) {
        const count = Number(row(entity)?.taskCount ?? row(entity)?.pendingTaskCount ?? 0);
        if (count > 0) {
          const taskWord = count === 1 ? (isEn ? 'pending task' : 'tarea pendiente') : (isEn ? 'pending tasks' : 'tareas pendientes');
          badge = ` · ${count} ${taskWord}`;
        } else {
          badge = isEn ? ' · _no pending tasks_' : ' · _sin tareas pendientes_';
        }
      }
      return `${globalIndex++}. *${name}*${badge}`;
    });

    const tip = isEn
      ? '\n\n💡 _Ask "tasks in [project]" or "view tasks for 1"._'
      : '\n\n💡 _Pide "tareas de [proyecto]" o "ver tareas de la 1"._';

    return `${header}\n\n${lines.join('\n')}${tip}`;
  }

  const lines = safeEntities.map((entity) => {
    const name = row(entity)?.name || (isEn ? 'Unnamed' : 'Sin nombre');
    return `• *${name}* — ${labels[String(row(entity)?.category)] || labels.other}`;
  });
  return `${header}\n\n${lines.join('\n')}`;
}

export function formatCanonicalEntityDelete(data: unknown = {}, { language = 'es' }: EntityFormatContext = {}): string {
  const entities = Array.isArray(row(data)?.entities) ? rows(row(data)?.entities) : rows(row(data)?.projects);
  const deletedCount = Number(row(data)?.deletedCount ?? entities.length ?? 0);
  const deletedTaskCount = Number(row(data)?.deletedTaskCount || 0);
  const cancelledReminderCount = Number(row(data)?.cancelledReminderCount || 0);
  const preservedCompletedTaskCount = Number(row(data)?.preservedCompletedTaskCount || 0);
  const names = entities.map((entity) => row(entity)?.name).filter(Boolean);

  const header = language === 'en'
    ? `🗑️ *${deletedCount === 1 ? 'Project deleted' : `${deletedCount} projects deleted`}*`
    : `🗑️ *${deletedCount === 1 ? 'Proyecto eliminado' : `${deletedCount} proyectos eliminados`}*`;
  const lines = names.map((name) => `• ${name}`);
  const notes = [];

  if (deletedTaskCount > 0) {
    notes.push(language === 'en'
      ? `🗑️ ${deletedTaskCount} unfinished task${deletedTaskCount === 1 ? ' was' : 's were'} also deleted.`
      : `🗑️ También se ${deletedTaskCount === 1 ? 'eliminó' : 'eliminaron'} ${deletedTaskCount} ${deletedTaskCount === 1 ? 'tarea pendiente asociada' : 'tareas pendientes asociadas'}.`);
  }
  if (cancelledReminderCount > 0) {
    notes.push(language === 'en'
      ? `🔕 ${cancelledReminderCount} related reminder${cancelledReminderCount === 1 ? ' was' : 's were'} cancelled.`
      : `🔕 Se ${cancelledReminderCount === 1 ? 'canceló' : 'cancelaron'} ${cancelledReminderCount} ${cancelledReminderCount === 1 ? 'recordatorio relacionado' : 'recordatorios relacionados'}.`);
  }
  if (preservedCompletedTaskCount > 0) {
    notes.push(language === 'en'
      ? `📚 ${preservedCompletedTaskCount} completed task${preservedCompletedTaskCount === 1 ? ' remains' : 's remain'} in history.`
      : `📚 ${preservedCompletedTaskCount} ${preservedCompletedTaskCount === 1 ? 'tarea completada permanece' : 'tareas completadas permanecen'} en el historial.`);
  }
  if (row(data)?.reminderCleanupError || row(data)?.taskCleanupError || row(data)?.partialSuccess === true) {
    notes.push(language === 'en'
      ? '⚠️ The projects were deleted, but their active work could not be cleaned up completely.'
      : '⚠️ Los proyectos se eliminaron, pero su trabajo activo no pudo limpiarse por completo.');
  }

  return [header, lines.join('\n'), notes.join('\n')].filter(Boolean).join('\n\n');
}
