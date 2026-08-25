import {
  saveReminder,
  cancelReminders,
  acknowledgeReminders,
  createTask,
  getTasks,
  completeTask,
  completeTasks,
  updateTask,
  findOrCreateEntityFuzzy,
  renameEntity,
  mergeEntities,
  deduplicateEntities,
  getOrCreateEntity,
  findEntities,
  getRecentRemindersForPhone,
  getDailyOverview,
  forgetMemories,
  searchMemories,
} from '../db/index.js';
import {
  parseTargetTime,
  humanizeTimeUntil,
  formatLocalDateTime,
} from '../utils/time.js';

/**
 * Execute single or batch tool operations deterministically.
 *
 * @param {string} toolName
 * @param {object} params
 * @param {object} user - User record { id, phone_number, timezone, locale }
 * @returns {Promise<{success: boolean, action: string, data: any, rawSummary: string}>}
 */
export async function executeTool(toolName, params, user) {
  const timezone = user.timezone || 'America/Bogota';
  const locale = user.locale || 'es-CO';
  const language = locale.startsWith('en') ? 'en' : locale.startsWith('pt') ? 'pt' : 'es';

  try {
    switch (toolName) {
      case 'create_reminder':
      case 'manage_reminder': {
        const action = params.action || 'create';

        // 1. Batch / Single creation with Recurrence Rule & Persistent Nudge support
        const items = params.items || params.reminders || (params.content ? [params] : []);

        if (action === 'create' && items.length > 0) {
          const savedReminders = await Promise.all(
            items.map(async (item) => {
              let sendAt = parseTargetTime(item.targetTime, timezone);
              if (!sendAt || sendAt.getTime() <= Date.now()) {
                sendAt = new Date(Date.now() + 60 * 60 * 1000);
              }

              // Extract recurrence rule if specified (e.g. 'daily', 'weekly:monday', etc.)
              let recurrenceRule = item.recurrence || item.recurrenceRule || params.recurrence || null;
              if (item.content && !recurrenceRule) {
                const lower = item.content.toLowerCase();
                if (lower.includes('todos los días') || lower.includes('cada día') || lower.includes('diario') || lower.includes('every day')) {
                  recurrenceRule = 'daily';
                } else if (lower.includes('todos los lunes') || lower.includes('every monday')) {
                  recurrenceRule = 'weekly:1';
                } else if (lower.includes('todos los martes') || lower.includes('every tuesday')) {
                  recurrenceRule = 'weekly:2';
                } else if (lower.includes('todos los miércoles') || lower.includes('every wednesday')) {
                  recurrenceRule = 'weekly:3';
                } else if (lower.includes('todos los jueves') || lower.includes('every thursday')) {
                  recurrenceRule = 'weekly:4';
                } else if (lower.includes('todos los viernes') || lower.includes('every friday')) {
                  recurrenceRule = 'weekly:5';
                } else if (lower.includes('todos los sábados') || lower.includes('every saturday')) {
                  recurrenceRule = 'weekly:6';
                } else if (lower.includes('todos los domingos') || lower.includes('every sunday')) {
                  recurrenceRule = 'weekly:0';
                } else if (lower.includes('cada semana') || lower.includes('semanal') || lower.includes('weekly')) {
                  recurrenceRule = 'weekly';
                } else if (lower.includes('cada mes') || lower.includes('mensual') || lower.includes('monthly')) {
                  recurrenceRule = 'monthly';
                }
              }

              const requiresConfirmation = Boolean(
                item.requiresConfirmation ?? item.requires_confirmation ?? params.requiresConfirmation ?? params.requires_confirmation
              );
              const nudgeIntervalMinutes = Number(
                item.nudgeIntervalMinutes ?? item.nudge_interval_minutes ?? params.nudgeIntervalMinutes ?? params.nudge_interval_minutes ?? 15
              );
              const maxNudges = Number(item.maxNudges ?? item.max_nudges ?? params.maxNudges ?? params.max_nudges ?? 5);

              const reminder = await saveReminder({
                userId: user.id,
                phoneNumber: user.phone_number,
                content: String(item.content || 'Recordatorio').trim(),
                sendAt: sendAt.toISOString(),
                recurrenceRule,
                requiresConfirmation,
                nudgeIntervalMinutes,
                maxNudges,
              });

              return {
                id: reminder?.id,
                content: item.content,
                sendAt: sendAt.toISOString(),
                recurrenceRule,
                requiresConfirmation,
                nudgeIntervalMinutes,
                formattedTime: formatLocalDateTime(sendAt, timezone, locale),
              };
            })
          );

          return {
            success: true,
            action: 'created_reminders_batch',
            data: savedReminders,
            rawSummary: `Se programaron ${savedReminders.length} recordatorios.`,
          };
        }

        if (action === 'acknowledge' || action === 'ack' || action === 'confirm') {
          const result = await acknowledgeReminders({
            userId: user.id,
            phoneNumber: user.phone_number,
            contentQuery: params.content || params.query,
          });

          return {
            success: result.acknowledgedCount > 0,
            action: 'acknowledged_reminders',
            data: result,
            rawSummary: result.acknowledgedCount > 0
              ? `Se confirmó el cumplimiento de ${result.acknowledgedCount} recordatorio(s).`
              : 'No había recordatorios pendientes por confirmar.',
          };
        }

        if (action === 'cancel' || action === 'delete') {
          const result = await cancelReminders({
            userId: user.id,
            phoneNumber: user.phone_number,
            contentQuery: params.content,
            cancelAll: Boolean(params.cancelAll),
            keepLatest: Boolean(params.keepLatest),
          });

          return {
            success: true,
            action: 'cancelled_reminders',
            data: result,
            rawSummary: `Eliminados ${result.cancelledCount} recordatorios. Restan ${result.remainingCount} pendientes.`,
          };
        }

        if (action === 'list') {
          const reminders = await getRecentRemindersForPhone(user.phone_number, 10);
          const active = reminders.filter(r => r.status === 'pending');
          return {
            success: true,
            action: 'listed_reminders',
            data: active,
            rawSummary: `Hay ${active.length} recordatorios pendientes.`,
          };
        }

        return { success: false, action: 'unknown', data: null, rawSummary: 'Acción no válida' };
      }

      case 'manage_entity': {
        const { action = 'create', name, oldName, newName, sourceName, targetName, category = 'project', metadata = {}, query, limit = 10 } = params;

        if (action === 'create' || action === 'update') {
          const entity = await findOrCreateEntityFuzzy({
            userId: user.id,
            name: name || newName,
            category,
            metadata,
          });

          return {
            success: Boolean(entity),
            action: action === 'create' ? 'created_entity' : 'updated_entity',
            data: entity,
            rawSummary: entity ? `Entidad "${entity.name}" guardada correctamente.` : 'No se pudo guardar la entidad.',
          };
        }

        if (action === 'rename') {
          const result = await renameEntity({
            userId: user.id,
            oldName: oldName || sourceName || name,
            newName: newName || targetName,
            category,
          });

          return {
            success: result.success,
            action: 'renamed_entity',
            data: result,
            rawSummary: result.success
              ? `Entidad renombrada de "${result.oldName || oldName}" a "${result.newName || newName}".`
              : `Error al renombrar: ${result.error}`,
          };
        }

        if (action === 'merge') {
          const result = await mergeEntities({
            userId: user.id,
            sourceName: sourceName || oldName || name,
            targetName: targetName || newName,
            category,
          });

          return {
            success: result.success,
            action: 'merged_entities',
            data: result,
            rawSummary: result.success
              ? `Entidad unificada correctamente. Se reasignaron ${result.tasksMovedCount} tareas.`
              : `Error al unificar entidades: ${result.error}`,
          };
        }

        if (action === 'deduplicate') {
          const result = await deduplicateEntities({
            userId: user.id,
            category,
          });

          return {
            success: true,
            action: 'deduplicated_entities',
            data: result,
            rawSummary: `Se unificaron ${result.mergedCount} entidades duplicadas.`,
          };
        }

        if (action === 'list') {
          const entities = await findEntities({
            userId: user.id,
            query,
            category,
            limit,
          });

          return {
            success: true,
            action: 'listed_entities',
            data: entities,
            rawSummary: `Se encontraron ${entities.length} entidades.`,
          };
        }

        return { success: false, action: 'unknown', data: null, rawSummary: 'Acción de entidad no reconocida.' };
      }

      case 'manage_task': {
        const { action, title, description, priority, dueDate, entityName, entityCategory } = params;

        // Batch creation if items array is passed
        const items = params.items || params.tasks || (title ? [params] : []);

        if (action === 'create' && items.length > 0) {
          const savedTasks = await Promise.all(
            items.map(async (item) => {
              let entityId = null;
              if (item.entityName) {
                const entity = await findOrCreateEntityFuzzy({
                  userId: user.id,
                  name: item.entityName,
                  category: item.entityCategory || 'other',
                });
                if (entity) entityId = entity.id;
              }

              let parsedDueDate = null;
              if (item.dueDate) {
                parsedDueDate = parseTargetTime(item.dueDate, timezone);
              }

              const task = await createTask({
                userId: user.id,
                title: item.title,
                description: item.description,
                priority: item.priority || 'medium',
                dueDate: parsedDueDate ? parsedDueDate.toISOString() : null,
                entityId,
              });

              return {
                id: task?.id,
                title: item.title,
                dueFormatted: parsedDueDate ? formatLocalDateTime(parsedDueDate, timezone, locale) : null,
                entityName: item.entityName,
              };
            })
          );

          return {
            success: true,
            action: 'created_tasks_batch',
            data: savedTasks,
            rawSummary: `Se crearon ${savedTasks.length} tareas.`,
          };
        }

        if (action === 'list') {
          const tasks = await getTasks({ userId: user.id, status: 'pending', limit: 10 });
          return {
            success: true,
            action: 'listed_tasks',
            data: tasks,
            rawSummary: `Hay ${tasks.length} tareas pendientes.`,
          };
        }

        if (action === 'complete' || action === 'done' || action === 'finish') {
          const result = await completeTasks({
            userId: user.id,
            taskId: params.taskId,
            titleQuery: title || params.query || params.titleQuery,
            entityName: entityName || params.projectName || params.project,
            completeAll: Boolean(params.completeAll || params.all),
          });

          return {
            success: result.completedCount > 0,
            action: 'completed_tasks',
            data: result,
            rawSummary: result.completedCount > 0
              ? `Se marcaron ${result.completedCount} tarea(s) como completada(s).`
              : `No se encontraron tareas pendientes para completar.`,
          };
        }

        return { success: false, action: 'unknown', data: null, rawSummary: 'Acción de tarea no reconocida.' };
      }

      case 'manage_memory': {
        const { action, query, topicKey } = params;

        if (action === 'forget' || action === 'delete') {
          const result = await forgetMemories({
            userId: user.id,
            topicKey: topicKey || null,
            query: query || params.content || null,
          });

          return {
            success: true,
            action: 'forgot_memories',
            data: result,
            rawSummary: `Se eliminaron ${result.deletedCount} registros de memoria.`,
          };
        }

        return { success: false, action: 'unknown', data: null, rawSummary: 'Acción de memoria no reconocida.' };
      }

      case 'get_pending_summary': {
        const overview = await getDailyOverview({
          userId: user.id,
          phoneNumber: user.phone_number,
          timezone,
        });

        return {
          success: true,
          action: 'daily_overview',
          data: overview,
          rawSummary: JSON.stringify(overview),
        };
      }

      default:
        return { success: false, action: 'unknown', data: null, rawSummary: 'Herramienta no implementada.' };
    }
  } catch (err) {
    console.error(`[tools] error executing ${toolName}:`, err);
    return {
      success: false,
      action: 'error',
      data: null,
      rawSummary: 'Ocurrió un error en la ejecución de la herramienta.',
    };
  }
}
