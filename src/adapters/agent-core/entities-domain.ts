import {
  entityResultSchema, type EntityRecord, type EntityRequest, type EntityResult, type JsonObject,
} from '@templelabs/contracts';
import type { EntityDomainPort, ToolOutcome } from '@templelabs/tools';
import {
  getEntitiesByUser, findOrCreateEntityFuzzy, renameEntityCascade, mergeEntities, deleteEntities,
} from '../../infrastructure/database/entities.js';
import type { ProductivityUser } from '../../features/productivity-domain.js';
import { checkDomainContext } from './domain-outcome.js';

interface EntityRowLike {
  id?: unknown;
  name?: unknown;
  category?: unknown;
  metadata?: unknown;
  status?: unknown;
}

function normalizeEntity(
  row: EntityRowLike,
  operation: EntityRequest['operation'],
): EntityRecord {
  return {
    id: String(row.id ?? ''),
    name: String(row.name ?? ''),
    category: row.category ? String(row.category) : null,
    metadata: row.metadata && typeof row.metadata === 'object' && !Array.isArray(row.metadata)
      ? (row.metadata as JsonObject)
      : null,
    status: operation === 'delete' ? 'deleted' : (String(row.status ?? 'active') as 'active' | 'deleted' | 'archived'),
  };
}

export function createEntityDomainPort(user: ProductivityUser): EntityDomainPort {
  const userId = user.id;
  return {
    async execute(request, context, operationId): Promise<ToolOutcome<EntityResult>> {
      const invalid = checkDomainContext(userId, context);
      if (invalid) return invalid;

      try {
        if (request.operation === 'read') {
          const rows = await getEntitiesByUser({
            userId,
            ...(request.input.category ? { category: request.input.category } : {}),
            ...(request.input.query ? { query: request.input.query } : {}),
            limit: request.input.limit ?? 50,
          });

          let filtered = rows;
          if (request.input.query) {
            const queryLower = request.input.query.toLowerCase();
            filtered = rows.filter(r => r.name.toLowerCase().includes(queryLower));
          }

          const entities = filtered.map(r => normalizeEntity(r, 'read'));
          const data: EntityResult = entityResultSchema.parse({
            operation: 'read',
            entities,
            complete: true,
            issues: [],
            presentation: { canonicalCard: null, questions: [], cta: null },
          });

          return {
            status: 'success',
            data,
            receipt: {
              userId,
              operationId,
              toolName: 'entity_read',
              resourceIds: entities.map(e => e.id),
            },
            observation: JSON.stringify({
              operation: 'read',
              returnedCount: entities.length,
              entities: entities.slice(0, 5).map(e => e.name),
            }),
          };
        }

        if (request.operation === 'create') {
          const created = await findOrCreateEntityFuzzy({
            userId,
            name: request.input.name,
            category: request.input.category ?? 'other',
            metadata: request.input.metadata ?? {},
          });

          if (!created) {
            return {
              status: 'failed',
              code: 'DATABASE_ERROR',
              observation: 'Could not create entity.',
            };
          }

          const entity = normalizeEntity(created, 'create');
          const data: EntityResult = entityResultSchema.parse({
            operation: 'create',
            entities: [entity],
            complete: true,
            issues: [],
            presentation: { canonicalCard: null, questions: [], cta: null },
          });

          return {
            status: 'success',
            data,
            receipt: {
              userId,
              operationId,
              toolName: 'entity_create',
              resourceIds: [entity.id],
            },
            observation: JSON.stringify({
              operation: 'create',
              id: entity.id,
              name: entity.name,
              category: entity.category,
            }),
          };
        }

        if (request.operation === 'update') {
          const oldName = request.input.oldName ?? '';
          const res = await renameEntityCascade({
            userId,
            oldName,
            newName: request.input.newName,
            category: request.input.category,
          });

          const failureRes = res as { success: false; errorCode?: string; error?: string };
          if (!res.success) {
            return {
              status: 'failed',
              code: failureRes.errorCode ?? 'ENTITY_NOT_FOUND',
              observation: failureRes.error ?? `Could not rename entity '${oldName}'.`,
            };
          }

          const successRes = res as { entity?: { id?: string }; id?: string };
          const entityId = successRes.entity?.id ?? (typeof successRes.id === 'string' ? successRes.id : '');
          const entity = normalizeEntity({
            id: entityId,
            name: request.input.newName,
            category: request.input.category,
          }, 'update');

          const data: EntityResult = entityResultSchema.parse({
            operation: 'update',
            entities: [entity],
            complete: true,
            issues: [],
            presentation: { canonicalCard: null, questions: [], cta: null },
          });

          return {
            status: 'success',
            data,
            receipt: {
              userId,
              operationId,
              toolName: 'entity_update',
              resourceIds: entity.id ? [entity.id] : [],
            },
            observation: JSON.stringify({
              operation: 'update',
              name: entity.name,
            }),
          };
        }

        if (request.operation === 'merge') {
          const res = await mergeEntities({
            userId,
            sourceName: request.input.sourceName,
            targetName: request.input.targetName,
            category: request.input.category,
          });

          const failureRes = res as { success: false; errorCode?: string; error?: string };
          if (!res.success) {
            return {
              status: 'failed',
              code: failureRes.errorCode ?? 'MERGE_FAILED',
              observation: failureRes.error ?? 'Could not merge entities.',
            };
          }

          const successRes = res as { targetEntity?: { id?: string }; id?: string; mergedCount?: number; tasksMovedCount?: number };
          const entityId = successRes.targetEntity?.id ?? (typeof successRes.id === 'string' ? successRes.id : '');
          const entity = normalizeEntity({
            id: entityId,
            name: request.input.targetName,
            category: request.input.category,
          }, 'merge');

          const data: EntityResult = entityResultSchema.parse({
            operation: 'merge',
            entities: [entity],
            complete: true,
            issues: [],
            presentation: { canonicalCard: null, questions: [], cta: null },
            mergedCount: typeof successRes.mergedCount === 'number' ? successRes.mergedCount : 1,
            tasksMovedCount: typeof successRes.tasksMovedCount === 'number' ? successRes.tasksMovedCount : 0,
          });

          return {
            status: 'success',
            data,
            receipt: {
              userId,
              operationId,
              toolName: 'entity_merge',
              resourceIds: entity.id ? [entity.id] : [],
            },
            observation: JSON.stringify({
              operation: 'merge',
              target: entity.name,
              tasksMoved: data.tasksMovedCount,
            }),
          };
        }

        if (request.operation === 'delete') {
          const dryRun = !request.input.confirmed;
          const preview = await deleteEntities({
            userId,
            targetName: request.input.name ?? null,
            entityIds: request.input.entityId ? [request.input.entityId] : null,
            category: request.input.category ?? null,
            scope: request.input.scope ?? 'single',
            dryRun,
          });

          const previewResult = preview as {
            success: boolean;
            errorCode?: string;
            error?: string;
            candidates?: EntityRowLike[];
            entities?: EntityRowLike[];
            deletedCount?: number;
          };

          if (!previewResult.success) {
            return {
              status: 'failed',
              code: previewResult.errorCode ?? 'ENTITY_DELETE_FAILED',
              observation: previewResult.error ?? 'Could not delete entity.',
            };
          }

          if (dryRun) {
            const previewEntities = (previewResult.candidates ?? previewResult.entities ?? []).map(e => normalizeEntity(e, 'delete'));
            const question = context.language === 'en'
              ? `Are you sure you want to delete entity ${previewEntities.map(e => e.name).join(', ')}?`
              : `¿Estás seguro de que deseas eliminar la entidad ${previewEntities.map(e => e.name).join(', ')}?`;

            const data: EntityResult = entityResultSchema.parse({
              operation: 'delete',
              entities: previewEntities,
              complete: false,
              issues: [],
              requiresConfirmation: true,
              presentation: {
                canonicalCard: question,
                questions: [question],
                cta: null,
              },
              deletedCount: 0,
            });

            return {
              status: 'clarification_required',
              code: 'CONFIRMATION_REQUIRED',
              data,
              observation: JSON.stringify({
                status: 'confirmation_required',
                entities: previewEntities.map(e => e.name),
              }),
            };
          }

          const deletedEntities = (previewResult.entities ?? []).map(e => normalizeEntity(e, 'delete'));
          const data: EntityResult = entityResultSchema.parse({
            operation: 'delete',
            entities: deletedEntities,
            complete: true,
            issues: [],
            presentation: { canonicalCard: null, questions: [], cta: null },
            deletedCount: previewResult.deletedCount ?? deletedEntities.length,
          });

          return {
            status: 'success',
            data,
            receipt: {
              userId,
              operationId,
              toolName: 'entity_delete',
              resourceIds: deletedEntities.map((e: EntityRecord) => e.id),
            },
            observation: JSON.stringify({
              operation: 'delete',
              deletedCount: data.deletedCount,
            }),
          };
        }

        return {
          status: 'failed',
          code: 'UNSUPPORTED_OPERATION',
          observation: 'Unsupported entity operation.',
        };
      } catch (err: unknown) {
        return {
          status: 'failed',
          code: 'DATABASE_ERROR',
          observation: err instanceof Error ? err.message : 'Entity database error',
        };
      }
    },
  };
}
