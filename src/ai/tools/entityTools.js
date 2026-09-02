import {
  findOrCreateEntityFuzzy,
  renameEntityCascade,
  mergeEntities,
  deduplicateEntities,
  getEntitiesByUser,
} from '../../db/index.js';

/**
 * Domain tool for managing entities / projects / contacts.
 */
export async function executeEntityTool({ action, params = {}, user, language = 'es' }) {
  const userId = user?.id;

  const normalizedAction = String(action || 'create').replace(/_entity$/, '');

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

      const rawSummary = language === 'en'
        ? `📁 *Project / Entity registered:*\n*${entity.name}* (${entity.category || 'general'})`
        : `📁 *Proyecto / Contacto registrado:*\n*${entity.name}* (${entity.category || 'general'})`;

      return {
        success: true,
        action: 'created_entity',
        data: entity,
        rawSummary,
        formattedCard: rawSummary,
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

      const rawSummary = language === 'en'
        ? `✏️ *Project renamed:* "${oldName}" ➔ *"${newName}"* (Updated in all linked tasks).`
        : `✏️ *Proyecto renombrado:* "${oldName}" ➔ *"${newName}"* (Actualizado en todas las tareas vinculadas).`;

      return {
        success: true,
        action: 'renamed_entity',
        data: res,
        rawSummary,
        formattedCard: rawSummary,
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

      const rawSummary = language === 'en'
        ? `🔀 *Merged:* "${sourceName}" merged into *"${targetName}"* (${res.tasksMovedCount} tasks moved).`
        : `🔀 *Fusión completada:* "${sourceName}" se unió a *"${targetName}"* (${res.tasksMovedCount} tareas migradas).`;

      return {
        success: true,
        action: 'merged_entities',
        data: res,
        rawSummary,
        formattedCard: rawSummary,
      };
    }

    case 'deduplicate': {
      const { category } = params;
      const res = await deduplicateEntities(userId, category);
      const rawSummary = language === 'en'
        ? `🧹 *Deduplication complete:* Merged ${res.mergedCount} redundant entities.`
        : `🧹 *Limpieza completada:* Se fusionaron ${res.mergedCount} entidades redundantes.`;

      return {
        success: true,
        action: 'deduplicated_entities',
        data: res,
        rawSummary,
        formattedCard: rawSummary,
      };
    }

    case 'list': {
      const { category = null, limit = 20 } = params;
      const entities = await getEntitiesByUser({ userId, category, limit });
      return {
        success: true,
        action: 'listed_entities',
        data: entities,
        rawSummary: `Tienes ${entities.length} entidad(es) registradas.`,
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
