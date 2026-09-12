import {
  findOrCreateEntityFuzzy,
  renameEntityCascade,
  mergeEntities,
  deduplicateEntities,
  getEntitiesByUser,
  deleteEntities,
  inspectOwnedEntityReferences,
} from '../../infrastructure/database/index.js';

/**
 * Domain tool for managing entities / projects / contacts.
 * Successful operations return structured truth; presentation happens at the
 * ExecutionFacts boundary. Destructive confirmation and ambiguity messages
 * remain operational contracts owned by this tool.
 */
export async function executeEntityTool({ action, params = {}, user, language = 'es', clarificationResolution = false }) {
  const userId = user?.id;

  const normalizedAction = String(action || 'create');

  switch (normalizedAction) {
    case 'create':
    case 'upsert': {
      const { name, category = 'other', metadata = {} } = params;
      if (!name) {
        return {
          success: false,
          action: 'invalid_parameters',
          errorCode: 'INVALID_PARAMETERS',
          error: 'Falta el nombre de la entidad.',
          rawSummary: 'Falta el nombre de la entidad.',
        };
      }

      const preflight = await inspectOwnedEntityReferences({
        userId,
        references: [{ name, category }],
      });
      if (!preflight.success) {
        return {
          success: false,
          action: 'database_error',
          errorCode: preflight.errorCode || 'DATABASE_ERROR',
          error: preflight.error || 'No se pudo validar la entidad.',
          rawSummary: preflight.error || 'No se pudo validar la entidad.',
        };
      }
      const resolution = preflight.resolutions[0];
      if (resolution?.status === 'AMBIGUOUS') {
        const names = (resolution.candidates || []).slice(0, 5).map((entity) => entity.name).join(', ');
        const question = language === 'en'
          ? `Which entity did you mean: ${names}?`
          : `¿A cuál entidad te refieres: ${names}?`;
        return {
          success: false,
          action: 'ambiguous_entity',
          errorCode: 'AMBIGUOUS_TARGET',
          error: question,
          rawSummary: question,
          requiresClarification: true,
        };
      }

      const entity = await findOrCreateEntityFuzzy({
        userId,
        name,
        category,
        metadata,
      });

      if (!entity) {
        return {
          success: false,
          action: 'database_error',
          errorCode: 'DATABASE_ERROR',
          error: 'No se pudo guardar la entidad.',
          rawSummary: 'No se pudo guardar la entidad.',
        };
      }

      return {
        success: true,
        action: 'created_entity',
        data: entity,
      };
    }

    case 'rename': {
      const { oldName, newName, category } = params;
      if (!oldName || !newName) {
        return {
          success: false,
          action: 'invalid_parameters',
          errorCode: 'INVALID_PARAMETERS',
          error: 'Faltan oldName y newName para renombrar.',
          rawSummary: 'Faltan oldName y newName para renombrar.',
        };
      }

      const res = await renameEntityCascade({
        userId,
        oldName,
        newName,
        category,
      });

      if (!res.success) {
        return {
          success: false,
          action: 'entity_not_found',
          errorCode: 'ENTITY_NOT_FOUND',
          error: res.error || `No se encontró '${oldName}' para renombrar.`,
          rawSummary: res.error || `No se encontró '${oldName}' para renombrar.`,
        };
      }

      return {
        success: true,
        action: 'renamed_entity',
        data: res,
      };
    }

    case 'merge': {
      const { sourceName, targetName, category } = params;
      if (!sourceName || !targetName) {
        return {
          success: false,
          action: 'invalid_parameters',
          errorCode: 'INVALID_PARAMETERS',
          error: 'Faltan sourceName y targetName para fusionar.',
          rawSummary: 'Faltan sourceName y targetName para fusionar.',
        };
      }

      const res = await mergeEntities({
        userId,
        sourceName,
        targetName,
        category,
      });

      if (!res.success) {
        return {
          success: false,
          action: 'merge_failed',
          errorCode: 'MERGE_FAILED',
          error: res.error || 'No se pudo completar la fusión de entidades.',
          rawSummary: res.error || 'No se pudo completar la fusión de entidades.',
        };
      }

      return {
        success: true,
        action: 'merged_entities',
        data: res,
      };
    }

    case 'deduplicate': {
      const { category } = params;
      const res = await deduplicateEntities(userId, category);
      return {
        success: true,
        action: 'deduplicated_entities',
        data: res,
      };
    }

    case 'list': {
      const { category = null, limit = 20 } = params;
      const entities = await getEntitiesByUser({ userId, category, limit });
      return {
        success: true,
        action: 'listed_entities',
        data: entities,
      };
    }

    case 'delete': {
      const entityIds = Array.isArray(params.entityIds) && params.entityIds.length > 0 ? params.entityIds : null;
      const targetName = params.targetName || null;
      const category = params.category || null;
      const scope = params.scope || 'single';
      const preserveNames = Array.isArray(params.preserveNames) ? params.preserveNames : [];
      const preview = await deleteEntities({
        userId, targetName, category, scope, preserveNames, dryRun: !clarificationResolution && !entityIds, entityIds,
      });

      if (!preview.success) {
        const message = preview.errorCode === 'AMBIGUOUS_TARGET'
          ? (language === 'en' ? 'Several projects match that name. Which one should I delete?' : 'Hay varios proyectos que coinciden con ese nombre. ¿Cuál deseas eliminar?')
          : (language === 'en' ? 'I could not find projects matching that request.' : 'No encontré proyectos que coincidan con esa solicitud.');
        return {
          success: false,
          action: preview.errorCode === 'AMBIGUOUS_TARGET' ? 'ambiguous_entity' : 'entity_not_found',
          errorCode: preview.errorCode || 'NOT_FOUND',
          error: message,
          rawSummary: message,
          formattedCard: `⚠️ ${message}`,
          requiresClarification: preview.errorCode === 'AMBIGUOUS_TARGET',
        };
      }

      if (!clarificationResolution) {
        const names = preview.entities.map((entity) => entity.name);
        const preservedText = preserveNames.length > 0
          ? (language === 'en' ? ` I will keep ${preserveNames.join(', ')}.` : ` Conservaré ${preserveNames.join(', ')}.`)
          : '';
        const taskText = preview.pendingTaskCount > 0
          ? (language === 'en'
            ? ` ${preview.pendingTaskCount} unfinished task${preview.pendingTaskCount === 1 ? ' will' : 's will'} also be deleted.`
            : ` También se ${preview.pendingTaskCount === 1 ? 'eliminará' : 'eliminarán'} ${preview.pendingTaskCount} ${preview.pendingTaskCount === 1 ? 'tarea pendiente asociada' : 'tareas pendientes asociadas'}.`)
          : '';
        const historyText = preview.preservedCompletedTaskCount > 0
          ? (language === 'en'
            ? ` ${preview.preservedCompletedTaskCount} completed task${preview.preservedCompletedTaskCount === 1 ? ' will remain' : 's will remain'} in history.`
            : ` ${preview.preservedCompletedTaskCount} ${preview.preservedCompletedTaskCount === 1 ? 'tarea completada permanecerá' : 'tareas completadas permanecerán'} en el historial.`)
          : '';
        const reminderText = preview.activeReminderCount > 0
          ? (language === 'en'
            ? ` ${preview.activeReminderCount} active reminder${preview.activeReminderCount === 1 ? ' will' : 's will'} also be cancelled.`
            : ` También se ${preview.activeReminderCount === 1 ? 'cancelará' : 'cancelarán'} ${preview.activeReminderCount} ${preview.activeReminderCount === 1 ? 'recordatorio activo relacionado' : 'recordatorios activos relacionados'}.`)
          : '';
        const question = language === 'en'
          ? `Should I delete ${names.length} ${names.length === 1 ? 'project' : 'projects'}: ${names.join(', ')}?${preservedText}${taskText}${reminderText}${historyText}`
          : `¿Quieres que elimine ${names.length} ${names.length === 1 ? 'proyecto' : 'proyectos'}: ${names.join(', ')}?${preservedText}${taskText}${reminderText}${historyText}`;
        const proposedOperation = {
          kind: 'entity_delete', targetName, category, scope, preserveNames,
        };
        const pendingClarifications = [{
          type: 'entity_deletion',
          content: scope === 'all' ? 'Eliminación de proyectos' : `Eliminar ${targetName}`,
          question,
          proposedOperation,
        }];
        return {
          success: false,
          complete: false,
          action: 'entity_deletion_confirmation_required',
          errorCode: 'CONFIRMATION_REQUIRED',
          error: question,
          rawSummary: `⚠️ *Confirmación necesaria*\n\n${question}`,
          formattedCard: `⚠️ *Confirmación necesaria*\n\n${question}`,
          requiresClarification: true,
          pendingClarifications,
          data: { pendingClarifications, previewEntities: preview.entities },
        };
      }

      return {
        success: true,
        complete: preview.complete !== false,
        partialSuccess: preview.partialSuccess === true,
        action: 'deleted_entities',
        data: preview,
      };
    }

    default:
      return {
        success: false,
        action: 'unsupported_action',
        errorCode: 'UNSUPPORTED_ACTION',
        error: `Acción '${action}' no soportada para manage_entity.`,
        rawSummary: `Acción '${action}' no soportada para manage_entity.`,
      };
  }
}
