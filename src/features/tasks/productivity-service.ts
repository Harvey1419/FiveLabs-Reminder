import type { TaskRequest, TurnContext } from '@templelabs/contracts';
import { definedFields, domainInput, domainResult, type ProductivityService, type ProductivityUser } from '../productivity-domain.js';
import { executeTaskCreate } from './operations/task-create.js';
import { executeTaskReadTool } from './operations/task-read.js';
import { executeTaskUpdate } from './operations/task-update.js';
import { executeTaskComplete } from './operations/task-complete.js';
import { executeTaskDelete } from './operations/task-delete.js';

const handlers = { create: executeTaskCreate, read: executeTaskReadTool, update: executeTaskUpdate,
  complete: executeTaskComplete, delete: executeTaskDelete };
export type TaskServiceHandlers = { [K in keyof typeof handlers]: (...args: Parameters<typeof handlers[K]>) => Promise<unknown> };
export function taskParameters(request: TaskRequest) {
  switch (request.operation) {
    case 'create': {
      const { dueDateIso, ...fields } = request.input;
      return { action: 'create', items: [definedFields({ ...fields, dueDate: dueDateIso })] };
    }
    case 'read': {
      const { scope } = request.input;
      return definedFields({ ...request.input, action: 'list', limit: request.input.limit ?? 50,
        scope: scope && /^\d{4}-\d{2}-\d{2}$/.test(scope) ? `explicit_date@${scope}` : scope });
    }
    case 'update': {
      const { taskId, dueDateIso, appendDescription, ...fields } = request.input;
      return { action: 'update', target: taskId, updates: definedFields({ ...fields, dueDate: dueDateIso, append: appendDescription }) };
    }
    case 'complete': case 'delete': return { action: request.operation, target: request.input.taskId };
  }
}
export function createTaskService(authenticatedUser: ProductivityUser, operations: TaskServiceHandlers = handlers): ProductivityService<TaskRequest> {
  const user = { ...authenticatedUser };
  return { async execute(request: TaskRequest, context: TurnContext) {
    const input = { ...await domainInput(user, context), params: taskParameters(request) };
    return domainResult(await operations[request.operation](input));
  } };
}
