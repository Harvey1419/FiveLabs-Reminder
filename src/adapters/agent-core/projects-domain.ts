import {
  projectResultSchema, type ProjectRecord, type ProjectRequest, type ProjectResult,
} from '@templelabs/contracts';
import type { ProjectDomainPort, ToolOutcome } from '@templelabs/tools';
import {
  findProjects, findOrCreateProjectFuzzy, renameProject, deleteProjects,
} from '../../infrastructure/database/projects.js';
import type { ProductivityUser } from '../../features/productivity-domain.js';
import { checkDomainContext } from './domain-outcome.js';

function normalizeProject(
  row: { id?: unknown; name?: unknown; description?: unknown; status?: unknown },
  operation: ProjectRequest['operation'],
): ProjectRecord {
  return {
    id: String(row.id ?? ''),
    name: String(row.name ?? ''),
    description: row.description ? String(row.description) : null,
    status: operation === 'delete' ? 'deleted' : (String(row.status ?? 'active') as 'active' | 'deleted' | 'archived'),
  };
}

export function createProjectDomainPort(user: ProductivityUser): ProjectDomainPort {
  const userId = user.id;
  return {
    async execute(request, context, operationId): Promise<ToolOutcome<ProjectResult>> {
      const invalid = checkDomainContext(userId, context);
      if (invalid) return invalid;

      try {
        if (request.operation === 'read') {
          const rows = await findProjects({
            userId,
            query: request.input.query ?? null,
            status: request.input.status ?? 'active',
            limit: request.input.limit ?? 50,
          });
          const projects = rows.map(r => normalizeProject(r, 'read'));
          const isEn = context.language === 'en';
          const heading = isEn ? '📁 *Your Projects*' : '📁 *Tus Proyectos*';
          const lines = projects.map(p => `• *${p.name}*${p.description ? ` — ${p.description}` : ''}`);
          const canonicalCard = `${heading}\n\n${lines.join('\n') || (isEn ? 'No projects found.' : 'No tienes proyectos registrados.')}`;
          const data: ProjectResult = projectResultSchema.parse({
            operation: 'read',
            projects,
            complete: true,
            issues: [],
            presentation: { canonicalCard, questions: [], cta: null },
          });
          return {
            status: 'success',
            data,
            receipt: {
              userId,
              operationId,
              toolName: 'project_read',
              resourceIds: projects.map(p => p.id),
            },
            observation: JSON.stringify({
              operation: 'read',
              count: projects.length,
              projects: projects.map(p => ({ id: p.id, name: p.name, status: p.status })),
            }),
          };
        }

        if (request.operation === 'create') {
          const project = await findOrCreateProjectFuzzy({
            userId,
            name: request.input.name,
            description: request.input.description ?? null,
          });
          if (!project) {
            return {
              status: 'failed',
              code: 'PROJECT_CREATE_FAILED',
              observation: 'Could not create project.',
            };
          }
          const record = normalizeProject(project, 'create');
          const isEn = context.language === 'en';
          const canonicalCard = isEn ? `✅ Project *${record.name}* created.` : `✅ Proyecto *${record.name}* creado.`;
          const data: ProjectResult = projectResultSchema.parse({
            operation: 'create',
            projects: [record],
            complete: true,
            issues: [],
            presentation: { canonicalCard, questions: [], cta: null },
          });
          return {
            status: 'success',
            data,
            receipt: {
              userId,
              operationId,
              toolName: 'project_create',
              resourceIds: [record.id],
            },
            observation: JSON.stringify({
              operation: 'create',
              project: { id: record.id, name: record.name },
            }),
          };
        }

        if (request.operation === 'rename') {
          const res = await renameProject({
            userId,
            oldName: request.input.oldName,
            newName: request.input.newName,
          });
          if (!res.success || !res.project) {
            return {
              status: 'failed',
              code: 'PROJECT_NOT_FOUND',
              observation: res.error ?? `Project '${request.input.oldName}' not found.`,
            };
          }
          const record = normalizeProject(res.project, 'rename');
          const isEn = context.language === 'en';
          const canonicalCard = isEn ? `✅ Project renamed to *${record.name}*.` : `✅ Proyecto renombrado a *${record.name}*.`;
          const data: ProjectResult = projectResultSchema.parse({
            operation: 'rename',
            projects: [record],
            complete: true,
            issues: [],
            presentation: { canonicalCard, questions: [], cta: null },
          });
          return {
            status: 'success',
            data,
            receipt: {
              userId,
              operationId,
              toolName: 'project_rename',
              resourceIds: [record.id],
            },
            observation: JSON.stringify({
              operation: 'rename',
              project: { id: record.id, name: record.name, oldName: request.input.oldName },
            }),
          };
        }

        if (request.operation === 'delete') {
          const dryRun = !request.input.confirmed;
          const preview = await deleteProjects({
            userId,
            targetName: request.input.name ?? null,
            projectIds: request.input.projectId ? [request.input.projectId] : null,
            scope: request.input.scope ?? 'single',
            dryRun,
          });

          const previewResult = preview as {
            success: boolean;
            errorCode?: string;
            error?: string;
            projects?: Array<{ id: string; name: string; description?: string | null; status?: string }>;
            pendingTaskCount?: number;
            activeReminderCount?: number;
            deletedCount?: number;
            deletedTaskCount?: number;
            cancelledReminderCount?: number;
          };

          if (!previewResult.success) {
            return {
              status: 'failed',
              code: previewResult.errorCode ?? 'PROJECT_DELETE_FAILED',
              observation: previewResult.error ?? 'Could not delete project.',
            };
          }

          if (dryRun) {
            const previewProjects = (previewResult.projects ?? []).map(p => normalizeProject(p, 'delete'));
            const question = context.language === 'en'
              ? `Do you want to delete project ${previewProjects.map(p => p.name).join(', ')}? This will delete ${previewResult.pendingTaskCount ?? 0} associated tasks.`
              : `¿Deseas eliminar el proyecto ${previewProjects.map(p => p.name).join(', ')}? Esto eliminará ${previewResult.pendingTaskCount ?? 0} tareas pendientes asociadas.`;

            const data: ProjectResult = projectResultSchema.parse({
              operation: 'delete',
              projects: previewProjects,
              complete: false,
              issues: [],
              requiresConfirmation: true,
              presentation: {
                canonicalCard: question,
                questions: [question],
                cta: null,
              },
              deletedCount: 0,
              deletedTaskCount: previewResult.pendingTaskCount ?? 0,
              cancelledReminderCount: previewResult.activeReminderCount ?? 0,
            });

            return {
              status: 'clarification_required',
              code: 'CONFIRMATION_REQUIRED',
              data,
              observation: JSON.stringify({
                status: 'confirmation_required',
                projects: previewProjects.map(p => p.name),
                pendingTasks: previewResult.pendingTaskCount,
              }),
            };
          }

          const deletedProjects = (previewResult.projects ?? []).map(p => normalizeProject(p, 'delete'));
          const isEn = context.language === 'en';
          const count = previewResult.deletedCount ?? deletedProjects.length;
          const canonicalCard = isEn
            ? `🗑️ Deleted ${count} project(s).`
            : `🗑️ ${count} proyecto(s) eliminado(s).`;
          const data: ProjectResult = projectResultSchema.parse({
            operation: 'delete',
            projects: deletedProjects,
            complete: true,
            issues: [],
            presentation: { canonicalCard, questions: [], cta: null },
            deletedCount: count,
            deletedTaskCount: previewResult.deletedTaskCount ?? 0,
            cancelledReminderCount: previewResult.cancelledReminderCount ?? 0,
          });

          return {
            status: 'success',
            data,
            receipt: {
              userId,
              operationId,
              toolName: 'project_delete',
              resourceIds: deletedProjects.map((p: ProjectRecord) => p.id),
            },
            observation: JSON.stringify({
              operation: 'delete',
              deletedCount: data.deletedCount,
              deletedTaskCount: data.deletedTaskCount,
            }),
          };
        }

        return {
          status: 'failed',
          code: 'UNSUPPORTED_OPERATION',
          observation: 'Unsupported project operation.',
        };
      } catch (err: unknown) {
        return {
          status: 'failed',
          code: 'DATABASE_ERROR',
          observation: err instanceof Error ? err.message : 'Project database error',
        };
      }
    },
  };
}
