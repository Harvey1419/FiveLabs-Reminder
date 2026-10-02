import {
  findOrCreateProjectFuzzy,
  renameProject,
  findProjects,
  deleteProjects,
  selectProjectCandidate,
} from '../../infrastructure/database/projects.js';

/**
 * Domain tool for managing operational containers (projects, checklists, shopping lists).
 */
export async function executeProjectTool({
  action,
  params = {},
  user,
  language = 'es',
  clarificationResolution = false,
}) {
  const userId = user?.id;
  const normalizedAction = String(action || 'create');

  switch (normalizedAction) {
    case 'create':
    case 'upsert': {
      const name = params.name || params.target;
      if (!name) {
        return {
          success: false,
          action: 'invalid_parameters',
          errorCode: 'INVALID_PARAMETERS',
          error: language === 'en' ? 'Missing project name.' : 'Falta el nombre del proyecto o lista.',
          rawSummary: language === 'en' ? 'Missing project name.' : 'Falta el nombre del proyecto o lista.',
        };
      }

      const project = await findOrCreateProjectFuzzy({
        userId,
        name,
        description: params.description || null,
        metadata: params.metadata || {},
      });

      if (!project) {
        return {
          success: false,
          action: 'database_error',
          errorCode: 'DATABASE_ERROR',
          error: language === 'en' ? 'Could not save project.' : 'No se pudo guardar el proyecto.',
          rawSummary: language === 'en' ? 'Could not save project.' : 'No se pudo guardar el proyecto.',
        };
      }

      return {
        success: true,
        action: 'created_project',
        data: project,
      };
    }

    case 'rename': {
      const { oldName, newName } = params;
      if (!oldName || !newName) {
        return {
          success: false,
          action: 'invalid_parameters',
          errorCode: 'INVALID_PARAMETERS',
          error: language === 'en' ? 'Missing oldName and newName.' : 'Faltan oldName y newName para renombrar.',
          rawSummary: language === 'en' ? 'Missing oldName and newName.' : 'Faltan oldName y newName para renombrar.',
        };
      }

      const res = await renameProject({ userId, oldName, newName });
      if (!res.success) {
        return {
          success: false,
          action: 'project_not_found',
          errorCode: 'PROJECT_NOT_FOUND',
          error: res.error || (language === 'en' ? `Could not rename '${oldName}'.` : `No se pudo renombrar '${oldName}'.`),
          rawSummary: res.error || (language === 'en' ? `Could not rename '${oldName}'.` : `No se pudo renombrar '${oldName}'.`),
        };
      }

      return {
        success: true,
        action: 'renamed_project',
        data: res.project,
      };
    }

    case 'list': {
      const { query = null, status = 'active', limit = 50 } = params;
      const projects = await findProjects({ userId, query, status, limit });
      return {
        success: true,
        action: 'listed_projects',
        data: projects,
      };
    }

    case 'delete': {
      const projectIds = Array.isArray(params.projectIds) && params.projectIds.length > 0 ? params.projectIds : null;
      const targetNames = Array.isArray(params.targetNames) && params.targetNames.length > 0 ? params.targetNames : null;
      const targetName = params.targetName || params.target || null;
      const rawScope = params.scope || (params.filter === 'no_tasks' ? 'no_tasks' : null);
      const scope = (rawScope === 'no_tasks' || rawScope === 'empty') ? 'no_tasks' : (rawScope || 'single');
      const preserveNames = Array.isArray(params.preserveNames) ? params.preserveNames : [];

      const preview = await deleteProjects({
        userId,
        targetName,
        targetNames,
        scope,
        preserveNames,
        dryRun: !clarificationResolution,
        projectIds,
      });

      if (!preview.success && !['NOT_FOUND', 'AMBIGUOUS_TARGET', 'INVALID_PARAMETERS'].includes(preview.errorCode)) {
        const counts = `${preview.deletedCount || 0} / ${preview.deletedTaskCount || 0} / ${preview.cancelledReminderCount || 0}`;
        const message = language === 'en'
          ? `I could not complete the deletion. Confirmed changes (projects / tasks / reminders): ${counts}. I stopped subsequent steps.`
          : `No pude completar la eliminación. Cambios confirmados (proyectos / tareas / recordatorios): ${counts}. Detuve los pasos siguientes.`;
        return { success: false, complete: false, partialSuccess: preview.partialSuccess === true,
          outcome: preview.outcome, action: 'project_deletion_incomplete', errorCode: preview.errorCode,
          error: message, rawSummary: message, formattedCard: `⚠️ ${message}`, data: preview };
      }
      if (!preview.success) {
        let message = language === 'en' ? 'I could not find projects matching that request.' : 'No encontré proyectos que coincidan con esa solicitud.';
        if (preview.errorCode === 'AMBIGUOUS_TARGET') {
          message = language === 'en' ? 'Several projects match that name. Which one should I delete?' : 'Hay varios proyectos que coinciden con ese nombre. ¿Cuál deseas eliminar?';
        } else if (scope === 'no_tasks') {
          message = language === 'en' ? 'You do not have any projects without pending tasks.' : 'No tienes proyectos sin tareas asociadas.';
        }
        return {
          success: false,
          action: preview.errorCode === 'AMBIGUOUS_TARGET' ? 'ambiguous_project' : 'project_not_found',
          errorCode: preview.errorCode || 'NOT_FOUND',
          error: message,
          rawSummary: message,
          formattedCard: `⚠️ ${message}`,
          requiresClarification: preview.errorCode === 'AMBIGUOUS_TARGET',
        };
      }

      if (!clarificationResolution) {
        const names = preview.projects.map((p) => p.name);
        const count = names.length;
        const projectList = count > 1
          ? `\n\n${names.map((n) => `• *${n}*`).join('\n')}`
          : `: *${names[0]}*`;

        const preservedText = preserveNames.length > 0
          ? (language === 'en' ? `\n\n📌 I will keep ${preserveNames.join(', ')}.` : `\n\n📌 Conservaré ${preserveNames.join(', ')}.`)
          : '';
        const taskText = preview.pendingTaskCount > 0
          ? (language === 'en'
            ? `\n\n🗑️ ${preview.pendingTaskCount} unfinished task${preview.pendingTaskCount === 1 ? ' will' : 's will'} also be deleted.`
            : `\n\n🗑️ También se ${preview.pendingTaskCount === 1 ? 'eliminará' : 'eliminarán'} ${preview.pendingTaskCount} ${preview.pendingTaskCount === 1 ? 'tarea pendiente asociada' : 'tareas pendientes asociadas'}.`)
          : '';
        const historyText = preview.preservedCompletedTaskCount > 0
          ? (language === 'en'
            ? `\n📚 ${preview.preservedCompletedTaskCount} completed task${preview.preservedCompletedTaskCount === 1 ? ' will remain' : 's will remain'} in history.`
            : `\n📚 ${preview.preservedCompletedTaskCount} ${preview.preservedCompletedTaskCount === 1 ? 'tarea completada permanecerá' : 'tareas completadas permanecerán'} en el historial.`)
          : '';
        const reminderText = preview.activeReminderCount > 0
          ? (language === 'en'
            ? `\n🔕 ${preview.activeReminderCount} active reminder${preview.activeReminderCount === 1 ? ' will' : 's will'} also be cancelled.`
            : `\n🔕 También se ${preview.activeReminderCount === 1 ? 'cancelará' : 'cancelarán'} ${preview.activeReminderCount} ${preview.activeReminderCount === 1 ? 'recordatorio activo relacionado' : 'recordatorios activos relacionados'}.`)
          : '';

        const emptyScopeNote = scope === 'no_tasks'
          ? (language === 'en' ? ' without pending tasks' : ' sin tareas asociadas')
          : '';
        const question = language === 'en'
          ? `Should I delete ${count === 1 ? '1 project' : `${count} projects`}${emptyScopeNote}${projectList}?${preservedText}${taskText}${reminderText}${historyText}`
          : `¿Quieres que elimine ${count === 1 ? '1 proyecto' : `${count} proyectos`}${emptyScopeNote}${projectList}?${preservedText}${taskText}${reminderText}${historyText}`;

        const proposedOperation = {
          kind: 'project_delete',
          targetName: count === 1 ? names[0] : null,
          targetNames: count > 1 ? names : null,
          projectIds: preview.projects.map((p) => p.id),
          scope,
          preserveNames,
        };
        const pendingClarifications = [{
          type: 'project_deletion',
          content: scope === 'all'
            ? 'Eliminación de todos los proyectos'
            : (scope === 'no_tasks'
              ? 'Eliminación de proyectos sin tareas'
              : (count === 1 ? `Eliminar ${names[0]}` : `Eliminar ${count} proyectos`)),
          question,
          proposedOperation,
        }];

        return {
          success: false,
          complete: false,
          action: 'project_deletion_confirmation_required',
          errorCode: 'CONFIRMATION_REQUIRED',
          error: question,
          rawSummary: `⚠️ *${language === 'en' ? 'Confirmation required' : 'Confirmación necesaria'}*\n\n${question}`,
          formattedCard: `⚠️ *${language === 'en' ? 'Confirmation required' : 'Confirmación necesaria'}*\n\n${question}`,
          requiresClarification: true,
          pendingClarifications,
          data: { pendingClarifications, previewProjects: preview.projects },
        };
      }

      return {
        success: true,
        complete: preview.complete !== false,
        partialSuccess: preview.partialSuccess === true,
        action: 'deleted_projects',
        data: preview,
      };
    }

    default:
      return {
        success: false,
        action: 'unsupported_action',
        errorCode: 'UNSUPPORTED_ACTION',
        error: `Acción '${action}' no soportada para manage_project.`,
        rawSummary: `Acción '${action}' no soportada para manage_project.`,
      };
  }
}
