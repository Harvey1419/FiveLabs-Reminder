function categoryLabels(language) {
  return language === 'en'
    ? { person: 'person', company: 'company', project: 'project', place: 'place', pet: 'pet', asset: 'asset', other: 'other' }
    : { person: 'persona', company: 'empresa', project: 'proyecto', place: 'lugar', pet: 'mascota', asset: 'activo', other: 'otro' };
}

export function formatCanonicalEntityCreate(entity, { language = 'es' } = {}) {
  const name = entity?.name || (language === 'en' ? 'Unnamed' : 'Sin nombre');
  const category = entity?.category || 'other';
  return language === 'en'
    ? `📁 *Project / entity registered*\n\n• *${name}* — ${category}`
    : `📁 *Proyecto / entidad registrada*\n\n• *${name}* — ${categoryLabels(language)[category] || categoryLabels(language).other}`;
}

export function formatCanonicalEntityRename(data, params = {}, { language = 'es' } = {}) {
  const oldName = params.oldName || data?.oldName || data?.sourceName || '';
  const newName = params.newName || data?.newName || data?.name || '';
  if (language === 'en') return `✏️ *Project renamed*\n\n${oldName ? `• ${oldName} → ` : '• '}${newName || 'Updated'}`;
  return `✏️ *Proyecto renombrado*\n\n${oldName ? `• ${oldName} → ` : '• '}${newName || 'Actualizado'}`;
}

export function formatCanonicalEntityMerge(data, params = {}, { language = 'es' } = {}) {
  const sourceName = params.sourceName || data?.sourceName || '';
  const targetName = params.targetName || data?.targetName || '';
  const count = Number(data?.tasksMovedCount || 0);
  const header = language === 'en' ? '🔀 *Entities merged*' : '🔀 *Fusión completada*';
  const target = [sourceName, targetName].filter(Boolean).join(' → ');
  const moved = language === 'en'
    ? `${count} task${count === 1 ? '' : 's'} moved`
    : `${count} ${count === 1 ? 'tarea migrada' : 'tareas migradas'}`;
  return `${header}${target ? `\n\n• ${target}` : ''}\n${moved}`;
}

export function formatCanonicalEntityDeduplicate(data, { language = 'es' } = {}) {
  const count = Number(data?.mergedCount || 0);
  return language === 'en'
    ? `🧹 *Deduplication complete*\n\n${count} redundant ${count === 1 ? 'entity was' : 'entities were'} merged.`
    : `🧹 *Limpieza completada*\n\nSe ${count === 1 ? 'fusionó' : 'fusionaron'} ${count} ${count === 1 ? 'entidad redundante' : 'entidades redundantes'}.`;
}

export function formatCanonicalEntityList(entities = [], {
  category = null,
  language = 'es',
} = {}) {
  const safeEntities = Array.isArray(entities) ? entities : [];
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

  const labels = categoryLabels(language);
  const header = language === 'en'
    ? (isProjectList ? '📁 *Your projects*' : '🗂️ *Your registered entities*')
    : (isProjectList ? '📁 *Tus proyectos*' : '🗂️ *Tus entidades registradas*');
  const lines = safeEntities.map((entity) => {
    const name = entity?.name || (language === 'en' ? 'Unnamed' : 'Sin nombre');
    if (isProjectList) {
      const hasCount = entity?.taskCount !== undefined || entity?.pendingTaskCount !== undefined;
      if (hasCount) {
        const count = Number(entity?.taskCount ?? entity?.pendingTaskCount ?? 0);
        const taskUnit = count === 1 ? (language === 'en' ? 'task' : 'tarea') : (language === 'en' ? 'tasks' : 'tareas');
        return `• *${name}* (${count} ${taskUnit})`;
      }
      return `• *${name}*`;
    }
    return `• *${name}* — ${labels[entity?.category] || labels.other}`;
  });
  return `${header}\n\n${lines.join('\n')}`;
}

export function formatCanonicalEntityDelete(data = {}, { language = 'es' } = {}) {
  const entities = Array.isArray(data?.entities) ? data.entities : (Array.isArray(data?.projects) ? data.projects : []);
  const deletedCount = Number(data?.deletedCount ?? entities.length ?? 0);
  const deletedTaskCount = Number(data?.deletedTaskCount || 0);
  const cancelledReminderCount = Number(data?.cancelledReminderCount || 0);
  const preservedCompletedTaskCount = Number(data?.preservedCompletedTaskCount || 0);
  const names = entities.map((entity) => entity?.name).filter(Boolean);

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
  if (data?.reminderCleanupError || data?.taskCleanupError || data?.partialSuccess === true) {
    notes.push(language === 'en'
      ? '⚠️ The projects were deleted, but their active work could not be cleaned up completely.'
      : '⚠️ Los proyectos se eliminaron, pero su trabajo activo no pudo limpiarse por completo.');
  }

  return [header, lines.join('\n'), notes.join('\n')].filter(Boolean).join('\n\n');
}
