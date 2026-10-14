import {
  taskResultSchema, taskFlowSchema, type TaskRecord, type TaskRequest, type TaskResult,
  type TurnContext,
} from '@templelabs/contracts';
import type { TaskDomainPort, ToolOutcome } from '@templelabs/tools';
import { createTaskService } from '../../features/tasks/productivity-service.js';
import type { ProductivityService, ProductivityUser } from '../../features/productivity-domain.js';
import {
  checkDomainContext, failedOutcome, domainEnvelopeSchema,
  nullableString, objectSchema, presentation,
} from './domain-outcome.js';

const actions = {
  create: new Set(['created_tasks_batch']), read: new Set(['listed_tasks']),
  update: new Set(['updated_task', 'updated_task_partial']),
  complete: new Set(['completed_task', 'completed_task_partial']),
  delete: new Set(['deleted_task', 'deleted_task_partial']),
};

function normalizeTask(value: unknown, operation: TaskRequest['operation']): TaskRecord {
  const row = objectSchema.parse(value);
  return {
    id: String(row.id ?? ''), title: nullableString(row.title), description: nullableString(row.description),
    priority: nullableString(row.priority) as TaskRecord['priority'],
    status: operation === 'delete' ? 'deleted' : operation === 'complete' ? 'completed'
      : nullableString(row.status) as TaskRecord['status'],
    dueDateIso: nullableString(row.dueDate ?? row.due_date),
    entityId: nullableString(row.entityId ?? row.entity_id ?? row.project_id),
    entityName: nullableString(row.entityName),
  };
}

export function createTaskDomainPort(user: ProductivityUser, service: ProductivityService<TaskRequest> = createTaskService(user)): TaskDomainPort {
  const userId = user.id;
  return {
    async execute(request, context, operationId): Promise<ToolOutcome<TaskResult>> {
      const invalid = checkDomainContext(userId, context);
      if (invalid) return invalid;
      const raw = domainEnvelopeSchema.parse(await service.execute(request, context));
      if (raw.success && !actions[request.operation].has(raw.action)) throw new Error('Unexpected task action');
      const hasEffects = raw.success || raw.partialSuccess === true;
      let rows: unknown[] = [];
      if (hasEffects) {
        if (request.operation === 'create') {
          if (!Array.isArray(raw.data)) throw new Error('Missing created task evidence');
          rows = raw.data;
        } else if (request.operation === 'read') {
          const data = objectSchema.parse(raw.data);
          if (!Array.isArray(data.tasks)) throw new Error('Missing task read evidence');
          rows = data.tasks;
        } else rows = [raw.data];
        if (request.operation !== 'read' && rows.length !== 1) throw new Error('Unexpected task write evidence');
      }
      const records = rows.slice(0, 50).map(row => normalizeTask(row, request.operation));
      if (hasEffects && request.operation !== 'create' && request.operation !== 'read'
        && records[0]?.id !== request.input.taskId) throw new Error('Task resource identity mismatch');

      // Task creation does not yet return evidence of its post-insert reminder.
      const unverifiedCompanion = hasEffects && request.operation === 'create'
        && request.input.scheduleReminder !== false && request.input.dueDateIso !== undefined
        && Date.parse(request.input.dueDateIso) > Date.parse(context.referenceTimeIso);
      const complete = raw.success && raw.complete !== false && !raw.partialSuccess && !unverifiedCompanion;
      const issues = unverifiedCompanion
        ? [{ code: 'COMPANION_OUTCOME_UNVERIFIED', reason: 'The task was created; its linked reminder outcome was not returned by the domain service.' }]
        : raw.partialSuccess ? [{ code: 'COMPANION_CLEANUP_FAILED', reason: 'The principal effect is confirmed; linked reminder reconciliation is incomplete.' }] : [];
      const data = taskResultSchema.parse({
        operation: request.operation, records, complete,
        coverage: request.operation === 'read' ? 'bounded_list' : 'operation', issues,
        presentation: presentation(raw), flow: raw.flow == null ? null : taskFlowSchema.parse(raw.flow),
      });
      const observation = JSON.stringify({
        operation: data.operation, complete, coverage: data.coverage,
        returnedCount: records.length, records: records.slice(0, 5).map(({ description: _description, ...record }) => record),
        issues, questions: data.presentation.questions.map(question => question.slice(0, 500)),
      });
      if (!hasEffects) return failedOutcome(raw, data, observation, request.operation === 'read' ? 'read' : 'write', operationId);
      return { status: complete ? 'success' : 'partial', data, observation,
        receipt: { userId: context.userId, operationId, toolName: `task_${request.operation}`, resourceIds: records.map(row => row.id) } };
    },
  };
}
